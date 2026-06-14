from __future__ import annotations

from decimal import Decimal, InvalidOperation
from io import BytesIO
import json
import math
import os
from typing import Any

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import FileResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from PIL import Image, ImageEnhance, ImageFilter

from .models import Sheet, SheetItem, UploadAsset


MAX_DUPLICATES = 500
MAX_EXPORT_PIXELS = 120_000_000
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
VALID_ROTATIONS = {0, 90, 180, 270}

_RESAMPLING = getattr(Image, "Resampling", Image)
LANCZOS = _RESAMPLING.LANCZOS
BICUBIC = _RESAMPLING.BICUBIC


# ============================================================
# PAGES
# ============================================================


def home(request):
    recent_sheets = Sheet.objects.order_by("-id")[:6]
    return render(request, "home.html", {"recent_sheets": recent_sheets})


def create_sheet(request):
    context: dict[str, Any] = {}

    if request.method == "POST":
        name = request.POST.get("name", "").strip()
        width_cm = request.POST.get("width_cm", "").strip()
        height_cm = request.POST.get("height_cm", "").strip() or "0"
        spacing_cm = request.POST.get("spacing_cm", "0.20").strip() or "0.20"
        margin_cm = request.POST.get("margin_cm", "0.20").strip() or "0.20"

        try:
            width = _decimal(width_cm)
            height = _decimal(height_cm)
            spacing = max(_decimal(spacing_cm), Decimal("0.00"))
            margin = max(_decimal(margin_cm), Decimal("0.00"))
        except (InvalidOperation, TypeError, ValueError):
            context["error"] = "Please enter valid sheet sizes."
            return render(request, "create_sheet.html", context)

        if not name:
            context["error"] = "Please enter a sheet name."
        elif width <= 0:
            context["error"] = "Sheet width must be greater than zero."
        elif margin * 2 >= width:
            context["error"] = "The left and right margins are too large for this sheet width."
        else:
            sheet = Sheet.objects.create(
                name=name,
                width_cm=width,
                height_cm=max(height, Decimal("0.00")),
                spacing_cm=spacing,
                margin_cm=margin,
            )
            return redirect("builder", sheet_id=sheet.id)

    return render(request, "create_sheet.html", context)


def builder(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)
    return render(request, "builder_react.html", {"sheet": sheet})


# ============================================================
# BASIC HELPERS
# ============================================================


def _decimal(value, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(default).quantize(Decimal("0.01"))


def _float(value, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def _json_body(request) -> dict[str, Any]:
    try:
        if not request.body:
            return {}
        payload = json.loads(request.body.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


def _file_url(request, field):
    if not field:
        return None
    try:
        return request.build_absolute_uri(field.url)
    except (ValueError, AttributeError):
        return None


def _asset_name(asset: UploadAsset) -> str:
    if not asset.original_file:
        return f"Asset {asset.id}"
    return os.path.basename(asset.original_file.name)


def _normalize_rotation(value) -> int:
    try:
        rotation = int(value) % 360
    except (TypeError, ValueError):
        rotation = 0

    if rotation not in VALID_ROTATIONS:
        raise ValueError("Rotation must be 0, 90, 180, or 270 degrees.")
    return rotation


def _pick_file_field(item: SheetItem):
    if item.use_upscaled and item.asset.upscaled_file:
        return item.asset.upscaled_file
    if item.use_processed and item.asset.processed_file:
        return item.asset.processed_file
    return item.asset.original_file


def _pick_image_url(request, item: SheetItem):
    return _file_url(request, _pick_file_field(item))


def _save_rgba_png(field, image: Image.Image, filename: str) -> None:
    buffer = BytesIO()
    image.convert("RGBA").save(buffer, format="PNG", optimize=True)
    field.save(filename, ContentFile(buffer.getvalue()), save=True)


def _validate_uploaded_image(uploaded_file) -> str | None:
    if uploaded_file.size > MAX_UPLOAD_BYTES:
        return "The image is too large. Maximum upload size is 50 MB."

    try:
        uploaded_file.seek(0)
        with Image.open(uploaded_file) as image:
            image.verify()
        uploaded_file.seek(0)
    except Exception:
        try:
            uploaded_file.seek(0)
        except Exception:
            pass
        return "The uploaded file is not a valid supported image."

    return None



def _visible_alpha_bbox(image: Image.Image, threshold: int = 8):
    """
    Return the visible-pixel bounding box.

    Very low-alpha edge noise is ignored so a nearly transparent pixel at the
    outside edge does not keep the selection box at the original full size.
    """
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    return mask.getbbox()


def _trim_transparent_pixels(
    image: Image.Image,
) -> tuple[Image.Image, tuple[int, int, int, int], tuple[int, int]]:
    """
    Crop transparent margins and return:
    (cropped image, bounding box, original pixel size).
    """
    rgba = image.convert("RGBA")
    original_size = rgba.size
    bounding_box = _visible_alpha_bbox(rgba)

    if not bounding_box:
        raise ValueError("The cleaned image is fully transparent.")

    cropped = rgba.crop(bounding_box)

    if cropped.width <= 1 or cropped.height <= 1:
        raise ValueError(
            "The visible artwork is too small after background removal."
        )

    return cropped, bounding_box, original_size


def _trimmed_geometry_for_item(
    item: SheetItem,
    source_size: tuple[int, int],
    bounding_box: tuple[int, int, int, int],
) -> dict[str, Decimal]:
    """
    Tighten the real layer to the visible artwork while preserving the exact
    physical position and size of the visible pixels.

    This also handles artwork rotated by 90, 180, or 270 degrees.
    """
    source_width, source_height = source_size
    left, top, right, bottom = bounding_box
    crop_width = right - left
    crop_height = bottom - top
    rotation = int(item.rotation or 0) % 360

    if rotation == 90:
        display_source_width = source_height
        display_source_height = source_width
        offset_x = source_height - bottom
        offset_y = left
        visible_width = crop_height
        visible_height = crop_width
    elif rotation == 180:
        display_source_width = source_width
        display_source_height = source_height
        offset_x = source_width - right
        offset_y = source_height - bottom
        visible_width = crop_width
        visible_height = crop_height
    elif rotation == 270:
        display_source_width = source_height
        display_source_height = source_width
        offset_x = top
        offset_y = source_width - right
        visible_width = crop_height
        visible_height = crop_width
    else:
        display_source_width = source_width
        display_source_height = source_height
        offset_x = left
        offset_y = top
        visible_width = crop_width
        visible_height = crop_height

    old_width = _float(item.width_cm, 0.10)
    old_height = _float(item.height_cm, 0.10)
    old_x = _float(item.x_cm, 0)
    old_y = _float(item.y_cm, 0)

    new_x = old_x + old_width * (
        offset_x / max(display_source_width, 1)
    )
    new_y = old_y + old_height * (
        offset_y / max(display_source_height, 1)
    )
    new_width = old_width * (
        visible_width / max(display_source_width, 1)
    )
    new_height = old_height * (
        visible_height / max(display_source_height, 1)
    )

    return {
        "x_cm": _decimal(max(new_x, 0)),
        "y_cm": _decimal(max(new_y, 0)),
        "width_cm": _decimal(max(new_width, 0.10)),
        "height_cm": _decimal(max(new_height, 0.10)),
    }


def _save_trimmed_processed_image(
    asset: UploadAsset,
    image: Image.Image,
    filename: str,
) -> dict[str, int | bool]:
    """
    Save a tightly cropped transparent PNG and update every real copy so its
    selection handles fit the visible artwork instead of the old full canvas.
    """
    cropped, bounding_box, source_size = _trim_transparent_pixels(image)

    with transaction.atomic():
        items = list(asset.sheet_items.all())

        for sheet_item in items:
            geometry = _trimmed_geometry_for_item(
                sheet_item,
                source_size,
                bounding_box,
            )

            sheet_item.x_cm = geometry["x_cm"]
            sheet_item.y_cm = geometry["y_cm"]
            sheet_item.width_cm = geometry["width_cm"]
            sheet_item.height_cm = geometry["height_cm"]
            sheet_item.use_processed = True
            sheet_item.use_upscaled = False

        if items:
            SheetItem.objects.bulk_update(
                items,
                [
                    "x_cm",
                    "y_cm",
                    "width_cm",
                    "height_cm",
                    "use_processed",
                    "use_upscaled",
                ],
            )

        _save_rgba_png(
            asset.processed_file,
            cropped,
            filename,
        )

    for sheet_id in {item.sheet_id for item in items}:
        sheet = Sheet.objects.filter(id=sheet_id).first()
        if sheet:
            _recalculate_sheet_height(sheet)

    return {
        "trimmed": bounding_box
        != (0, 0, source_size[0], source_size[1]),
        "source_width": source_size[0],
        "source_height": source_size[1],
        "visible_width": cropped.width,
        "visible_height": cropped.height,
    }


def _crop_transparent_space(asset: UploadAsset) -> bool:
    """Crop only fully transparent outer space on upload."""
    try:
        with Image.open(asset.original_file) as opened:
            original = opened.convert("RGBA")

        cropped, bounding_box = _trim_transparent_image(original)

        if bounding_box == (0, 0, original.width, original.height):
            return False

        stem = os.path.splitext(os.path.basename(asset.original_file.name))[0]
        _save_rgba_png(
            asset.processed_file,
            cropped,
            f"{stem}_transparent_crop.png",
        )
        return True
    except Exception:
        return False


def _auto_item_size_from_image(file_field):
    default_width = Decimal("8.00")
    default_height = Decimal("8.00")

    try:
        with Image.open(file_field) as image:
            pixel_width, pixel_height = image.size

        if pixel_width <= 0 or pixel_height <= 0:
            return default_width, default_height

        ratio = Decimal(pixel_height) / Decimal(pixel_width)

        if pixel_width >= pixel_height:
            default_width = Decimal("8.00")
            default_height = (default_width * ratio).quantize(Decimal("0.01"))
        else:
            default_height = Decimal("8.00")
            default_width = (default_height / ratio).quantize(Decimal("0.01"))

        default_width = max(default_width, Decimal("0.50"))
        default_height = max(default_height, Decimal("0.50"))
    except Exception:
        pass

    return default_width, default_height


def _item_payload(request, item: SheetItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "sheet_id": item.sheet_id,
        "asset_id": item.asset_id,
        "x_cm": str(item.x_cm),
        "y_cm": str(item.y_cm),
        "width_cm": str(item.width_cm),
        "height_cm": str(item.height_cm),
        "quantity": 1,
        "lock_ratio": item.lock_ratio,
        "use_processed": item.use_processed,
        "use_upscaled": item.use_upscaled,
        "rotation": int(item.rotation or 0) % 360,
        "image_url": _pick_image_url(request, item),
        "original_url": _file_url(request, item.asset.original_file),
        "processed_url": _file_url(request, item.asset.processed_file),
        "upscaled_url": _file_url(request, item.asset.upscaled_file),
        "name": _asset_name(item.asset),
    }


def _recalculate_sheet_height(sheet: Sheet) -> None:
    margin = max(_float(sheet.margin_cm, 0.2), 0)
    used_bottom = max(
        (
            _float(item.y_cm) + _float(item.height_cm)
            for item in sheet.items.all()
        ),
        default=margin,
    )
    sheet.height_cm = _decimal(max(used_bottom + margin, 1))
    sheet.save(update_fields=["height_cm"])


def _fit_asset_items_to_processed_image(
    *,
    asset: UploadAsset,
    reference_size: tuple[int, int],
    processed_image: Image.Image,
    filename: str,
) -> None:
    """
    Trim transparent edges, save the processed PNG, and tighten every real
    layer belonging to this asset.

    The layer remains centered while its selection box shrinks to match the
    visible artwork. This prevents the large empty selection area that remains
    after background removal.
    """
    reference_width_px, reference_height_px = reference_size
    cropped_image, _ = _trim_transparent_image(processed_image)
    new_width_px, new_height_px = cropped_image.size

    _save_rgba_png(asset.processed_file, cropped_image, filename)

    if (
        reference_width_px <= 0
        or reference_height_px <= 0
        or new_width_px <= 0
        or new_height_px <= 0
    ):
        asset.sheet_items.update(use_processed=True, use_upscaled=False)
        return

    scale_x = Decimal(new_width_px) / Decimal(reference_width_px)
    scale_y = Decimal(new_height_px) / Decimal(reference_height_px)

    # Never enlarge a layer merely because of edge-cleaning.
    scale_x = min(max(scale_x, Decimal("0.001")), Decimal("1.00"))
    scale_y = min(max(scale_y, Decimal("0.001")), Decimal("1.00"))

    rows = list(asset.sheet_items.all())
    updates = []

    for row in rows:
        old_width = _decimal(row.width_cm)
        old_height = _decimal(row.height_cm)
        old_x = _decimal(row.x_cm)
        old_y = _decimal(row.y_cm)

        center_x = old_x + (old_width / Decimal("2"))
        center_y = old_y + (old_height / Decimal("2"))

        quarter_turn = int(row.rotation or 0) % 180 == 90

        if quarter_turn:
            new_width = max(_decimal(old_width * scale_y), Decimal("0.10"))
            new_height = max(_decimal(old_height * scale_x), Decimal("0.10"))
        else:
            new_width = max(_decimal(old_width * scale_x), Decimal("0.10"))
            new_height = max(_decimal(old_height * scale_y), Decimal("0.10"))

        row.width_cm = new_width
        row.height_cm = new_height
        row.x_cm = max(
            _decimal(center_x - (new_width / Decimal("2"))),
            Decimal("0.00"),
        )
        row.y_cm = max(
            _decimal(center_y - (new_height / Decimal("2"))),
            Decimal("0.00"),
        )
        row.use_processed = True
        row.use_upscaled = False
        updates.append(row)

    if updates:
        SheetItem.objects.bulk_update(
            updates,
            [
                "x_cm",
                "y_cm",
                "width_cm",
                "height_cm",
                "use_processed",
                "use_upscaled",
            ],
        )

    sheet_ids = {row.sheet_id for row in rows}
    for sheet in Sheet.objects.filter(id__in=sheet_ids):
        _recalculate_sheet_height(sheet)


# ============================================================
# PACKING HELPERS
# ============================================================


def _boxes_collide(candidate, existing, spacing: float) -> bool:
    return not (
        candidate["x"] + candidate["w"] + spacing <= existing["x"]
        or candidate["x"] >= existing["x"] + existing["w"] + spacing
        or candidate["y"] + candidate["h"] + spacing <= existing["y"]
        or candidate["y"] >= existing["y"] + existing["h"] + spacing
    )


def _candidate_positions(placed, margin: float, spacing: float):
    positions = {(round(margin, 4), round(margin, 4))}

    for box in placed:
        positions.add(
            (
                round(box["x"] + box["w"] + spacing, 4),
                round(box["y"], 4),
            )
        )
        positions.add(
            (
                round(box["x"], 4),
                round(box["y"] + box["h"] + spacing, 4),
            )
        )
        positions.add(
            (
                round(margin, 4),
                round(box["y"] + box["h"] + spacing, 4),
            )
        )

    return sorted(positions, key=lambda point: (point[1], point[0]))


def _find_best_position(
    width: float,
    height: float,
    sheet_width: float,
    margin: float,
    spacing: float,
    placed,
):
    best = None

    for x, y in _candidate_positions(placed, margin, spacing):
        if x < margin or y < margin:
            continue
        if x + width > sheet_width - margin + 1e-9:
            continue

        candidate = {"x": x, "y": y, "w": width, "h": height}

        if any(_boxes_collide(candidate, box, spacing) for box in placed):
            continue

        score = (y + height, y, x + width, x)

        if best is None or score < best["score"]:
            best = {**candidate, "score": score}

    return best


def _bottom_of_placed(placed, margin: float, spacing: float) -> float:
    if not placed:
        return margin
    return max(box["y"] + box["h"] for box in placed) + spacing


def _canonical_orientation(item: SheetItem):
    rotation = int(item.rotation or 0) % 360
    width = max(_float(item.width_cm, 0.5), 0.1)
    height = max(_float(item.height_cm, 0.5), 0.1)

    if rotation in {90, 270}:
        base_width, base_height = height, width
    else:
        base_width, base_height = width, height

    base_rotation = 180 if rotation in {180, 270} else 0
    return base_width, base_height, base_rotation


def _packing_options(item: SheetItem, allow_rotate: bool):
    current_rotation = int(item.rotation or 0) % 360
    current_width = max(_float(item.width_cm, 0.5), 0.1)
    current_height = max(_float(item.height_cm, 0.5), 0.1)

    if not allow_rotate:
        return [(current_width, current_height, current_rotation)]

    base_width, base_height, base_rotation = _canonical_orientation(item)
    options = [(base_width, base_height, base_rotation)]

    if abs(base_width - base_height) > 1e-9:
        options.append(
            (
                base_height,
                base_width,
                (base_rotation + 90) % 360,
            )
        )

    return options


def _pack_sheet(sheet: Sheet, allow_rotate: bool = False):
    sheet_width = _float(sheet.width_cm, 58)
    margin = max(_float(sheet.margin_cm, 0.2), 0)
    spacing = max(_float(sheet.spacing_cm, 0.2), 0)
    usable_width = sheet_width - (margin * 2)

    if sheet_width <= 0:
        raise ValueError("Sheet width must be greater than zero.")
    if usable_width <= 0:
        raise ValueError("Sheet margin is too large for the selected sheet width.")

    items = list(sheet.items.select_related("asset").order_by("id"))
    items.sort(
        key=lambda row: (
            -(_float(row.width_cm) * _float(row.height_cm)),
            -max(_float(row.width_cm), _float(row.height_cm)),
            row.id,
        )
    )

    placed = []
    updates = []
    overflow_ids: list[int] = []

    for item in items:
        fitting_choices = []

        for option_width, option_height, option_rotation in _packing_options(
            item,
            allow_rotate,
        ):
            if option_width > usable_width + 1e-9:
                continue

            position = _find_best_position(
                option_width,
                option_height,
                sheet_width,
                margin,
                spacing,
                placed,
            )
            if position is None:
                continue

            fitting_choices.append(
                {
                    **position,
                    "rotation": option_rotation,
                }
            )

        if fitting_choices:
            best_choice = min(fitting_choices, key=lambda choice: choice["score"])
        else:
            current_width = max(_float(item.width_cm, 0.5), 0.1)
            current_height = max(_float(item.height_cm, 0.5), 0.1)
            current_rotation = int(item.rotation or 0) % 360

            overflow_ids.append(item.id)
            overflow_y = _bottom_of_placed(placed, margin, spacing)
            best_choice = {
                "x": margin,
                "y": overflow_y,
                "w": current_width,
                "h": current_height,
                "rotation": current_rotation,
                "score": (
                    overflow_y + current_height,
                    overflow_y,
                    current_width,
                    margin,
                ),
            }

        placed.append(
            {
                "x": best_choice["x"],
                "y": best_choice["y"],
                "w": best_choice["w"],
                "h": best_choice["h"],
            }
        )

        item.x_cm = _decimal(best_choice["x"])
        item.y_cm = _decimal(best_choice["y"])
        item.width_cm = _decimal(best_choice["w"])
        item.height_cm = _decimal(best_choice["h"])
        item.rotation = best_choice["rotation"]
        item.quantity = 1
        updates.append(item)

    if updates:
        SheetItem.objects.bulk_update(
            updates,
            [
                "x_cm",
                "y_cm",
                "width_cm",
                "height_cm",
                "rotation",
                "quantity",
            ],
        )

    used_height = max(
        (box["y"] + box["h"] for box in placed),
        default=margin,
    ) + margin
    used_height = max(used_height, margin * 2, 1.0)

    sheet.height_cm = _decimal(used_height)
    sheet.save(update_fields=["height_cm"])

    printable_width = max(sheet_width - (2 * margin), 0)
    printable_height = max(used_height - (2 * margin), 0)
    printable_area = printable_width * printable_height
    artwork_area = sum(box["w"] * box["h"] for box in placed)

    coverage = (artwork_area / printable_area * 100) if printable_area > 0 else 0
    coverage = min(max(coverage, 0), 100)
    waste = max(0, 100 - coverage)

    return {
        "item_count": len(items),
        "used_height_cm": round(used_height, 2),
        "coverage_percent": round(coverage, 2),
        "waste_percent": round(waste, 2),
        "overflow_item_ids": overflow_ids,
    }


def _normalized_item_size(item: SheetItem):
    rotation = int(item.rotation or 0) % 180
    if rotation == 90:
        return _decimal(item.height_cm), _decimal(item.width_cm)
    return _decimal(item.width_cm), _decimal(item.height_cm)


def _image_for_export(item: SheetItem) -> Image.Image:
    file_field = _pick_file_field(item)
    if not file_field:
        raise ValueError("No image file is available for this item.")

    file_field.open("rb")
    try:
        with Image.open(file_field) as opened:
            image = opened.convert("RGBA")
    finally:
        file_field.close()

    rotation = int(item.rotation or 0) % 360
    if rotation:
        image = image.rotate(-rotation, expand=True, resample=BICUBIC)

    return image


# ============================================================
# SHEET API
# ============================================================


def sheet_detail_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)

    items = [
        _item_payload(request, item)
        for item in sheet.items.select_related("asset").order_by("id")
    ]

    assets = [
        {
            "id": asset.id,
            "name": _asset_name(asset),
            "original_url": _file_url(request, asset.original_file),
            "processed_url": _file_url(request, asset.processed_file),
            "upscaled_url": _file_url(request, asset.upscaled_file),
        }
        for asset in sheet.assets.order_by("-id")
    ]

    return JsonResponse(
        {
            "sheet": {
                "id": sheet.id,
                "name": sheet.name,
                "width_cm": str(sheet.width_cm),
                "height_cm": str(sheet.height_cm),
                "spacing_cm": str(sheet.spacing_cm),
                "margin_cm": str(sheet.margin_cm),
            },
            "assets": assets,
            "items": items,
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def upload_asset_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)
    uploaded_file = request.FILES.get("file")

    if not uploaded_file:
        return JsonResponse({"error": "No file uploaded."}, status=400)

    validation_error = _validate_uploaded_image(uploaded_file)
    if validation_error:
        return JsonResponse({"error": validation_error}, status=400)

    asset = UploadAsset.objects.create(
        sheet=sheet,
        original_file=uploaded_file,
    )

    transparent_crop_ok = _crop_transparent_space(asset)
    source = (
        asset.processed_file
        if transparent_crop_ok and asset.processed_file
        else asset.original_file
    )
    width_cm, height_cm = _auto_item_size_from_image(source)

    item = SheetItem.objects.create(
        sheet=sheet,
        asset=asset,
        x_cm=sheet.margin_cm,
        y_cm=sheet.margin_cm,
        width_cm=width_cm,
        height_cm=height_cm,
        quantity=1,
        lock_ratio=True,
        use_processed=transparent_crop_ok,
        use_upscaled=False,
        rotation=0,
    )

    _recalculate_sheet_height(sheet)

    return JsonResponse(
        {
            "ok": True,
            "transparent_cropped": transparent_crop_ok,
            "asset_id": asset.id,
            "item": _item_payload(request, item),
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def auto_pack_sheet_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)
    payload = _json_body(request)
    allow_rotate = bool(payload.get("allow_rotate", False))

    try:
        with transaction.atomic():
            metrics = _pack_sheet(sheet, allow_rotate=allow_rotate)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    return JsonResponse({"ok": True, **metrics})


@csrf_exempt
@require_http_methods(["GET", "POST"])
def export_sheet_png_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)

    try:
        requested_dpi = int(
            request.GET.get("dpi")
            or request.POST.get("dpi")
            or 150
        )
    except (TypeError, ValueError):
        requested_dpi = 150

    dpi = 300 if requested_dpi >= 300 else 150
    items = list(sheet.items.select_related("asset").order_by("id"))

    actual_bottom_cm = max(
        (
            _float(item.y_cm) + _float(item.height_cm)
            for item in items
        ),
        default=1,
    )

    height_cm = max(
        _float(sheet.height_cm, 1),
        actual_bottom_cm + _float(sheet.margin_cm, 0.2),
        1,
    )
    width_cm = max(_float(sheet.width_cm, 1), 1)

    width_px = max(1, int(round(width_cm / 2.54 * dpi)))
    height_px = max(1, int(round(height_cm / 2.54 * dpi)))

    if width_px * height_px > MAX_EXPORT_PIXELS:
        return JsonResponse(
            {
                "error": (
                    "This export is too large for safe memory use. "
                    "Choose 150 DPI or reduce the sheet length."
                )
            },
            status=400,
        )

    canvas = Image.new("RGBA", (width_px, height_px), (0, 0, 0, 0))
    pixels_per_cm = dpi / 2.54
    skipped_item_ids: list[int] = []

    for item in items:
        try:
            image = _image_for_export(item)
            item_width_px = max(
                1,
                int(round(_float(item.width_cm) * pixels_per_cm)),
            )
            item_height_px = max(
                1,
                int(round(_float(item.height_cm) * pixels_per_cm)),
            )

            image = image.resize(
                (item_width_px, item_height_px),
                LANCZOS,
            )

            x = max(0, int(round(_float(item.x_cm) * pixels_per_cm)))
            y = max(0, int(round(_float(item.y_cm) * pixels_per_cm)))
            canvas.paste(image, (x, y), image)
        except Exception:
            skipped_item_ids.append(item.id)

    if items and len(skipped_item_ids) == len(items):
        return JsonResponse(
            {"error": "Export failed because no artwork image could be rendered."},
            status=500,
        )

    buffer = BytesIO()
    canvas.save(
        buffer,
        format="PNG",
        dpi=(dpi, dpi),
        optimize=False,
    )
    buffer.seek(0)

    safe_name = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in sheet.name
    ).strip("_") or f"sheet_{sheet.id}"

    response = FileResponse(
        buffer,
        as_attachment=True,
        filename=f"{safe_name}_{dpi}dpi.png",
        content_type="image/png",
    )

    if skipped_item_ids:
        response["X-Niron-Skipped-Items"] = ",".join(
            map(str, skipped_item_ids)
        )

    return response


# ============================================================
# ITEM API
# ============================================================


@csrf_exempt
@require_http_methods(["POST"])
def create_item_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)
    payload = _json_body(request)

    asset_id = payload.get("asset_id")
    if not asset_id:
        return JsonResponse({"error": "asset_id is required."}, status=400)

    asset = get_object_or_404(
        UploadAsset,
        id=asset_id,
        sheet=sheet,
    )

    try:
        rotation = _normalize_rotation(payload.get("rotation", 0))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    use_processed = bool(payload.get("use_processed", False))
    use_upscaled = bool(payload.get("use_upscaled", False))

    if use_upscaled and not asset.upscaled_file:
        use_upscaled = False
    if use_processed and not asset.processed_file:
        use_processed = False
    if use_upscaled:
        use_processed = False

    item = SheetItem.objects.create(
        sheet=sheet,
        asset=asset,
        x_cm=max(
            _decimal(payload.get("x_cm", sheet.margin_cm)),
            Decimal("0.00"),
        ),
        y_cm=max(
            _decimal(payload.get("y_cm", sheet.margin_cm)),
            Decimal("0.00"),
        ),
        width_cm=max(
            _decimal(payload.get("width_cm", "5.00")),
            Decimal("0.10"),
        ),
        height_cm=max(
            _decimal(payload.get("height_cm", "5.00")),
            Decimal("0.10"),
        ),
        quantity=1,
        lock_ratio=bool(payload.get("lock_ratio", True)),
        use_processed=use_processed,
        use_upscaled=use_upscaled,
        rotation=rotation,
    )

    _recalculate_sheet_height(sheet)
    return JsonResponse({"ok": True, "item": _item_payload(request, item)})


@csrf_exempt
@require_http_methods(["POST"])
def clone_item_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("sheet", "asset"),
        id=item_id,
    )
    payload = _json_body(request)

    offset_x = _decimal(payload.get("offset_x_cm", "0.80"))
    offset_y = _decimal(payload.get("offset_y_cm", "0.80"))

    clone = SheetItem.objects.create(
        sheet=item.sheet,
        asset=item.asset,
        x_cm=max(item.x_cm + offset_x, Decimal("0.00")),
        y_cm=max(item.y_cm + offset_y, Decimal("0.00")),
        width_cm=item.width_cm,
        height_cm=item.height_cm,
        quantity=1,
        lock_ratio=item.lock_ratio,
        use_processed=item.use_processed,
        use_upscaled=item.use_upscaled,
        rotation=item.rotation,
    )

    _recalculate_sheet_height(item.sheet)
    return JsonResponse({"ok": True, "item": _item_payload(request, clone)})


@csrf_exempt
@require_http_methods(["PATCH", "POST"])
def update_item_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("asset", "sheet"),
        id=item_id,
    )
    payload = _json_body(request)

    decimal_fields = {
        "x_cm": Decimal("0.00"),
        "y_cm": Decimal("0.00"),
        "width_cm": Decimal("0.10"),
        "height_cm": Decimal("0.10"),
    }

    for field_name, minimum in decimal_fields.items():
        if field_name in payload:
            setattr(
                item,
                field_name,
                max(_decimal(payload[field_name]), minimum),
            )

    if "quantity" in payload:
        item.quantity = 1

    if "lock_ratio" in payload:
        item.lock_ratio = bool(payload["lock_ratio"])

    try:
        if "rotation" in payload:
            item.rotation = _normalize_rotation(payload["rotation"])
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    if "use_upscaled" in payload and bool(payload["use_upscaled"]):
        if not item.asset.upscaled_file:
            return JsonResponse(
                {"error": "No upscaled image is available."},
                status=400,
            )
        item.use_upscaled = True
        item.use_processed = False
    elif "use_processed" in payload and bool(payload["use_processed"]):
        if not item.asset.processed_file:
            return JsonResponse(
                {"error": "No processed image is available."},
                status=400,
            )
        item.use_processed = True
        item.use_upscaled = False
    else:
        if "use_upscaled" in payload:
            item.use_upscaled = bool(payload["use_upscaled"])
        if "use_processed" in payload:
            item.use_processed = bool(payload["use_processed"])

        if not item.use_upscaled and not item.use_processed:
            item.use_upscaled = False
            item.use_processed = False

    item.save()
    _recalculate_sheet_height(item.sheet)

    return JsonResponse({"ok": True, "item": _item_payload(request, item)})


@csrf_exempt
@require_http_methods(["POST"])
def smart_duplicate_item_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("sheet", "asset"),
        id=item_id,
    )
    payload = _json_body(request)

    try:
        total_quantity = int(payload.get("total_quantity", 1))
    except (TypeError, ValueError):
        return JsonResponse(
            {"error": "Quantity must be a whole number."},
            status=400,
        )

    total_quantity = min(max(total_quantity, 1), MAX_DUPLICATES)
    allow_rotate = bool(payload.get("allow_rotate", False))

    selected_size = _normalized_item_size(item)
    candidates = item.sheet.items.filter(
        asset=item.asset,
        use_processed=item.use_processed,
        use_upscaled=item.use_upscaled,
    ).order_by("id")

    existing = [
        candidate
        for candidate in candidates
        if _normalized_item_size(candidate) == selected_size
    ]

    if item not in existing:
        existing.insert(0, item)

    try:
        with transaction.atomic():
            if len(existing) < total_quantity:
                rows_to_create = []

                for _ in range(total_quantity - len(existing)):
                    rows_to_create.append(
                        SheetItem(
                            sheet=item.sheet,
                            asset=item.asset,
                            x_cm=item.x_cm,
                            y_cm=item.y_cm,
                            width_cm=item.width_cm,
                            height_cm=item.height_cm,
                            quantity=1,
                            lock_ratio=item.lock_ratio,
                            use_processed=item.use_processed,
                            use_upscaled=item.use_upscaled,
                            rotation=item.rotation,
                        )
                    )

                SheetItem.objects.bulk_create(rows_to_create)

            elif len(existing) > total_quantity:
                removable = [
                    row for row in existing
                    if row.id != item.id
                ]
                delete_count = len(existing) - total_quantity
                delete_ids = [
                    row.id
                    for row in removable[-delete_count:]
                ]

                if delete_ids:
                    SheetItem.objects.filter(id__in=delete_ids).delete()

            metrics = _pack_sheet(
                item.sheet,
                allow_rotate=allow_rotate,
            )
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    return JsonResponse(
        {
            "ok": True,
            "total_quantity": total_quantity,
            **metrics,
        }
    )


@csrf_exempt
@require_http_methods(["DELETE", "POST"])
def delete_item_api(request, item_id):
    item = get_object_or_404(SheetItem, id=item_id)
    sheet = item.sheet
    item.delete()
    _recalculate_sheet_height(sheet)
    return JsonResponse({"ok": True})


@csrf_exempt
@require_http_methods(["POST"])
def rotate_item_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )

    item.width_cm, item.height_cm = item.height_cm, item.width_cm
    item.rotation = (int(item.rotation or 0) + 90) % 360
    item.save(update_fields=["width_cm", "height_cm", "rotation"])

    return JsonResponse({"ok": True, "item": _item_payload(request, item)})


# ============================================================
# IMAGE PROCESSING API
# ============================================================


@csrf_exempt
@require_http_methods(["POST"])
def remove_background_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )
    asset = item.asset

    # Process the image version currently visible on the sheet.
    source = _pick_file_field(item)

    try:
        from rembg import remove
    except ImportError:
        return JsonResponse(
            {
                "error": (
                    "AI background removal is not installed. Run: "
                    "pip install rembg onnxruntime"
                )
            },
            status=500,
        )

    try:
        source.open("rb")
        try:
            raw = source.read()
        finally:
            source.close()

        result = remove(raw)

        if isinstance(result, Image.Image):
            cleaned_image = result.convert("RGBA")
        else:
            with Image.open(BytesIO(bytes(result))) as opened:
                cleaned_image = opened.convert("RGBA")

        stem = os.path.splitext(
            os.path.basename(source.name)
        )[0]

        trim_info = _save_trimmed_processed_image(
            asset,
            cleaned_image,
            f"{stem}_ai_clear_trimmed.png",
        )

        item.refresh_from_db()

        return JsonResponse(
            {
                "ok": True,
                "processed_url": _file_url(
                    request,
                    asset.processed_file,
                ),
                "item": _item_payload(request, item),
                **trim_info,
            }
        )

    except ValueError as exc:
        return JsonResponse(
            {"error": str(exc)},
            status=400,
        )
    except Exception as exc:
        return JsonResponse(
            {
                "error": (
                    f"AI background removal failed: {exc}"
                )
            },
            status=500,
        )


@csrf_exempt
@require_http_methods(["POST"])
def magic_wand_apply_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )
    processed = request.FILES.get("file")

    if not processed:
        return JsonResponse(
            {"error": "No processed PNG received."},
            status=400,
        )

    validation_error = _validate_uploaded_image(processed)
    if validation_error:
        return JsonResponse(
            {"error": validation_error},
            status=400,
        )

    try:
        processed.seek(0)

        with Image.open(processed) as opened:
            image = opened.convert("RGBA")

        stem = os.path.splitext(
            os.path.basename(
                item.asset.original_file.name
            )
        )[0]

        trim_info = _save_trimmed_processed_image(
            item.asset,
            image,
            f"{stem}_magic_wand_trimmed.png",
        )

        item.refresh_from_db()

        return JsonResponse(
            {
                "ok": True,
                "processed_url": _file_url(
                    request,
                    item.asset.processed_file,
                ),
                "item": _item_payload(request, item),
                **trim_info,
            }
        )

    except ValueError as exc:
        return JsonResponse(
            {"error": str(exc)},
            status=400,
        )
    except Exception as exc:
        return JsonResponse(
            {
                "error": (
                    f"Magic Wand save failed: {exc}"
                )
            },
            status=500,
        )


@csrf_exempt
@require_http_methods(["POST"])
def upscale_item_api(request, item_id):
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )
    asset = item.asset
    source = (
        asset.processed_file
        if asset.processed_file
        else asset.original_file
    )

    if not source:
        return JsonResponse({"error": "No image found."}, status=400)

    try:
        source.open("rb")
        try:
            with Image.open(source) as opened:
                image = opened.convert("RGBA")
        finally:
            source.close()

        image = image.resize(
            (image.width * 2, image.height * 2),
            LANCZOS,
        )
        image = image.filter(ImageFilter.SHARPEN)
        image = ImageEnhance.Sharpness(image).enhance(1.7)
        image = ImageEnhance.Contrast(image).enhance(1.08)

        stem = os.path.splitext(os.path.basename(source.name))[0]
        _save_rgba_png(
            asset.upscaled_file,
            image,
            f"{stem}_upscaled.png",
        )

        asset.sheet_items.update(
            use_upscaled=True,
            use_processed=False,
        )
        item.refresh_from_db()

        return JsonResponse(
            {
                "ok": True,
                "upscaled_url": _file_url(
                    request,
                    asset.upscaled_file,
                ),
                "item": _item_payload(request, item),
            }
        )
    except Exception as exc:
        return JsonResponse(
            {"error": f"Upscale failed: {exc}"},
            status=500,
        )
