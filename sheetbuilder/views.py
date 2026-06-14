from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO
import json
import math
import os
import shutil
import subprocess
import tempfile
from typing import Any

from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count
from django.http import FileResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from .models import Sheet, SheetItem, UploadAsset


MAX_DUPLICATES = 500
MAX_EXPORT_PIXELS = 120_000_000
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
VALID_ROTATIONS = {0, 90, 180, 270}
PACK_EPSILON = 1e-6
PACK_ROUND_DIGITS = 6
MAX_UPSCALE_PIXELS = 100_000_000
MAX_UPSCALE_SIDE = 16_000
CM_PER_INCH = Decimal("2.54")
UPSCALE_MODES = {"smart", "normal", "high", "ultra", "logo_text", "photo", "hd_1080", "2k", "4k", "print_300dpi", "print_600dpi", "perfect_clear"}

_RESAMPLING = getattr(Image, "Resampling", Image)
LANCZOS = _RESAMPLING.LANCZOS
BICUBIC = _RESAMPLING.BICUBIC


# ============================================================
# PAGES
# ============================================================


def home(request):
    """Show only sheets created during the latest seven days."""
    seven_days_ago = timezone.now() - timedelta(days=7)

    recent_sheets = (
        Sheet.objects
        .filter(created_at__gte=seven_days_ago)
        .annotate(item_count=Count("items"))
        .order_by("-created_at", "-id")
    )

    return render(
        request,
        "home.html",
        {
            "recent_sheets": recent_sheets,
            "recent_sheet_count": recent_sheets.count(),
            "recent_days": 7,
        },
    )


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


def _trim_transparent_image(
    image: Image.Image,
    threshold: int = 1,
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Return an RGBA image cropped to visible alpha and its source bbox."""
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    bounding_box = mask.getbbox()

    if not bounding_box:
        return rgba, (0, 0, rgba.width, rgba.height)

    cropped = rgba.crop(bounding_box)
    return cropped, bounding_box


def _read_rgba_file_field(file_field) -> Image.Image:
    """Open a Django FileField safely and detach the returned PIL image."""
    file_field.open("rb")
    try:
        with Image.open(file_field) as opened:
            image = opened.convert("RGBA")
            image.load()
            return image.copy()
    finally:
        file_field.close()


def _clean_upscale_source(asset: UploadAsset):
    """
    Always return a clean source.

    Never return ``upscaled_file``. Re-upscaling a previous upscale compounds
    interpolation and sharpening artifacts, which is why repeated clicks can
    make letters and edges progressively worse.
    """
    if asset.processed_file:
        return asset.processed_file, "processed"
    if asset.original_file:
        return asset.original_file, "original"
    return None, "missing"


def _detect_upscale_mode(image: Image.Image) -> str:
    """Choose a conservative photo or logo/text pipeline."""
    rgba = image.convert("RGBA")
    thumbnail = rgba.copy()
    thumbnail.thumbnail((256, 256), LANCZOS)

    background = Image.new("RGBA", thumbnail.size, (255, 255, 255, 255))
    background.alpha_composite(thumbnail)
    rgb = background.convert("RGB")
    gray = rgb.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)

    edge_histogram = edges.histogram()
    total_pixels = max(edges.width * edges.height, 1)
    strong_edges = sum(edge_histogram[36:])
    edge_ratio = strong_edges / total_pixels

    quantized = rgb.quantize(colors=96)
    used_colors = sum(1 for count in quantized.histogram() if count)

    # Logos, lettering and flat graphics normally have many hard transitions
    # and fewer dominant colours than photographs.
    if edge_ratio >= 0.16 or used_colors <= 54:
        return "logo_text"
    return "photo"


def _requested_upscale_mode(request) -> str:
    payload = _json_body(request)
    mode = str(
        payload.get("mode")
        or request.POST.get("mode")
        or request.GET.get("mode")
        or "smart"
    ).strip().lower()
    return mode if mode in UPSCALE_MODES else "smart"


def _mode_scale(mode: str) -> int:
    return {
        "normal": 2,
        "high": 4,
        "ultra": 6,
        "logo_text": 4,
        "photo": 4,
        "smart": 4,
    }.get(mode, 4)


def _safe_target_size(target_width: int, target_height: int) -> tuple[int, int]:
    target_width = max(1, int(target_width))
    target_height = max(1, int(target_height))

    if target_width > MAX_UPSCALE_SIDE or target_height > MAX_UPSCALE_SIDE:
        ratio = min(MAX_UPSCALE_SIDE / target_width, MAX_UPSCALE_SIDE / target_height)
        target_width = max(1, int(target_width * ratio))
        target_height = max(1, int(target_height * ratio))

    pixel_count = target_width * target_height
    if pixel_count > MAX_UPSCALE_PIXELS:
        ratio = math.sqrt(MAX_UPSCALE_PIXELS / pixel_count)
        target_width = max(1, int(target_width * ratio))
        target_height = max(1, int(target_height * ratio))

    return target_width, target_height


def _item_target_pixels(item: SheetItem, dpi: int = 300) -> tuple[int, int]:
    width_px = max(1, int(math.ceil(_float(item.width_cm) / 2.54 * dpi)))
    height_px = max(1, int(math.ceil(_float(item.height_cm) / 2.54 * dpi)))
    return width_px, height_px


def _target_by_long_side(image: Image.Image, long_side: int) -> tuple[int, int]:
    width, height = image.size
    current_long = max(width, height, 1)
    target_long = max(int(long_side), current_long)
    ratio = target_long / current_long
    return max(1, int(round(width * ratio))), max(1, int(round(height * ratio)))


def _resize_rgba_to_target(image: Image.Image, target_width: int, target_height: int) -> tuple[Image.Image, Image.Image]:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").resize((target_width, target_height), LANCZOS)
    rgb = rgba.convert("RGB").resize((target_width, target_height), LANCZOS)
    return rgb, alpha


def _detect_upscale_mode(image: Image.Image) -> str:
    rgb = image.convert("RGB")
    edges = rgb.convert("L").filter(ImageFilter.FIND_EDGES)
    edge_histogram = edges.histogram()
    total_pixels = max(edges.width * edges.height, 1)
    strong_edges = sum(edge_histogram[36:])
    edge_ratio = strong_edges / total_pixels

    quantized = rgb.quantize(colors=96)
    used_colors = sum(1 for count in quantized.histogram() if count)

    if edge_ratio >= 0.16 or used_colors <= 54:
        return "logo_text"
    return "photo"


def _find_superres_model(model_dir: str, preferred: str | None = None) -> tuple[str, str, int] | None:
    candidates = [
        ("EDSR", 4, "EDSR_x4.pb"),
        ("FSRCNN", 4, "FSRCNN_x4.pb"),
        ("ESPCN", 4, "ESPCN_x4.pb"),
        ("LapSRN", 8, "LapSRN_x8.pb"),
    ]
    if preferred:
        candidates = [row for row in candidates if row[0] == preferred] + [row for row in candidates if row[0] != preferred]

    for algorithm, scale, filename in candidates:
        path = os.path.join(model_dir, filename)
        if os.path.exists(path):
            return path, algorithm, scale
    return None


def _try_superres_upscale(image: Image.Image, target_width: int, target_height: int) -> Image.Image | None:
    try:
        import cv2
        import numpy as np

        if not hasattr(cv2, "dnn_superres"):
            return None

        project_root = os.path.dirname(os.path.dirname(__file__))
        model_dir = os.path.join(project_root, "models", "upscale")
        found = _find_superres_model(model_dir)
        if not found:
            return None

        model_path, algorithm, model_scale = found
        sr = cv2.dnn_superres.DnnSuperResImpl_create()
        sr.readModel(model_path)
        sr.setModel(algorithm.lower(), model_scale)

        rgba = image.convert("RGBA")
        rgb = rgba.convert("RGB")
        alpha = rgba.getchannel("A")

        rgb_np = np.array(rgb)[:, :, ::-1].copy()
        upscaled_bgr = sr.upsample(rgb_np)
        upscaled_rgb = Image.fromarray(upscaled_bgr[:, :, ::-1])

        alpha_np = np.array(alpha)
        alpha_up = cv2.resize(alpha_np, (upscaled_rgb.width, upscaled_rgb.height), interpolation=cv2.INTER_LANCZOS4)
        alpha_img = Image.fromarray(alpha_up).convert("L")

        result = Image.merge("RGBA", (*upscaled_rgb.split(), alpha_img))
        if result.width != target_width or result.height != target_height:
            result = result.resize((target_width, target_height), LANCZOS)
        return result
    except Exception:
        return None



def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_realesrgan_ncnn() -> str | None:
    """Find the portable official Real-ESRGAN NCNN executable."""
    configured = os.environ.get("REALESRGAN_NCNN_PATH", "").strip()
    candidates = [
        configured,
        os.path.join(
            _project_root(),
            "tools",
            "realesrgan-ncnn-vulkan",
            "realesrgan-ncnn-vulkan.exe",
        ),
        os.path.join(
            _project_root(),
            "tools",
            "realesrgan-ncnn-vulkan.exe",
        ),
        os.path.join(_project_root(), "realesrgan-ncnn-vulkan.exe"),
    ]

    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def _run_realesrgan_ncnn(
    image: Image.Image,
    target_width: int,
    target_height: int,
) -> Image.Image | None:
    """
    Use the portable official Real-ESRGAN NCNN engine when installed.

    The executable package contains its own models and does not require
    PyTorch/CUDA. PNG is used so transparency can be preserved.
    """
    executable = _find_realesrgan_ncnn()
    if not executable:
        return None

    executable_dir = os.path.dirname(executable)

    with tempfile.TemporaryDirectory(prefix="niron_realesrgan_") as temp_dir:
        input_path = os.path.join(temp_dir, "input.png")
        output_path = os.path.join(temp_dir, "output.png")
        image.convert("RGBA").save(input_path, format="PNG")

        command = [
            executable,
            "-i",
            input_path,
            "-o",
            output_path,
            "-n",
            "realesrgan-x4plus",
            "-s",
            "4",
            "-t",
            "256",
            "-f",
            "png",
        ]

        completed = subprocess.run(
            command,
            cwd=executable_dir,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        if completed.returncode != 0 or not os.path.isfile(output_path):
            return None

        with Image.open(output_path) as opened:
            result = opened.convert("RGBA")

        if result.size != (target_width, target_height):
            result = result.resize((target_width, target_height), LANCZOS)
        return result


def _perfect_target_size(
    image: Image.Image,
    item: SheetItem | None,
) -> tuple[int, int]:
    """Target at least 4K and, for print, at least 600 DPI at item size."""
    source_width, source_height = image.size
    target_width, target_height = _target_by_long_side(image, 4096)

    if item is not None:
        dpi_width, dpi_height = _item_target_pixels(item, 600)
        ratio = max(
            dpi_width / max(source_width, 1),
            dpi_height / max(source_height, 1),
            target_width / max(source_width, 1),
            target_height / max(source_height, 1),
            1.0,
        )
        target_width = int(math.ceil(source_width * ratio))
        target_height = int(math.ceil(source_height * ratio))

    return _safe_target_size(target_width, target_height)


def _smart_upscale_image(
    image: Image.Image,
    requested_mode: str,
    item: SheetItem | None = None,
) -> tuple[Image.Image, dict[str, Any]]:
    detected_mode = _detect_upscale_mode(image)
    source_width, source_height = image.size

    if requested_mode == "perfect_clear":
        target_width, target_height = _perfect_target_size(image, item)
        content_mode = detected_mode
        mode_label = "perfect_clear"
    elif requested_mode == "hd_1080":
        target_width, target_height = _target_by_long_side(image, 1080)
        content_mode = detected_mode
        mode_label = "hd_1080"
    elif requested_mode == "2k":
        target_width, target_height = _target_by_long_side(image, 2048)
        content_mode = detected_mode
        mode_label = "2k"
    elif requested_mode == "4k":
        target_width, target_height = _target_by_long_side(image, 4096)
        content_mode = detected_mode
        mode_label = "4k"
    elif requested_mode == "print_300dpi" and item is not None:
        target_width, target_height = _item_target_pixels(item, 300)
        target_width = max(target_width, source_width)
        target_height = max(target_height, source_height)
        content_mode = detected_mode
        mode_label = "print_300dpi"
    elif requested_mode == "print_600dpi" and item is not None:
        target_width, target_height = _item_target_pixels(item, 600)
        target_width = max(target_width, source_width)
        target_height = max(target_height, source_height)
        content_mode = detected_mode
        mode_label = "print_600dpi"
    else:
        content_mode = detected_mode if requested_mode == "smart" else requested_mode
        if content_mode not in {"normal", "high", "ultra", "logo_text", "photo"}:
            content_mode = detected_mode
        scale = _mode_scale(content_mode)
        target_width = source_width * scale
        target_height = source_height * scale
        mode_label = requested_mode if requested_mode != "smart" else content_mode

    target_width, target_height = _safe_target_size(target_width, target_height)

    # Best engine first: official Real-ESRGAN NCNN portable executable.
    result = None
    engine = "fallback_lanczos"
    if max(target_width, target_height) > max(source_width, source_height):
        result = _run_realesrgan_ncnn(image, target_width, target_height)
        if result is not None:
            engine = "realesrgan_ncnn"

    # Secondary optional engine: OpenCV DNN super-resolution model.
    if result is None and max(target_width, target_height) >= 1080:
        result = _try_superres_upscale(image, target_width, target_height)
        if result is not None:
            engine = "opencv_dnn_superres"

    # Safe fallback. Deliberately restrained to avoid glowing/white halos.
    if result is None:
        rgb, alpha = _resize_rgba_to_target(image, target_width, target_height)

        if content_mode == "logo_text":
            rgb = rgb.filter(
                ImageFilter.UnsharpMask(radius=0.55, percent=24, threshold=5)
            )
        elif mode_label in {"perfect_clear", "4k", "print_600dpi"}:
            rgb = rgb.filter(
                ImageFilter.UnsharpMask(radius=0.80, percent=28, threshold=6)
            )
        elif mode_label in {"2k", "print_300dpi"}:
            rgb = rgb.filter(
                ImageFilter.UnsharpMask(radius=0.72, percent=24, threshold=6)
            )
        elif content_mode == "normal":
            rgb = rgb.filter(
                ImageFilter.UnsharpMask(radius=0.55, percent=18, threshold=7)
            )
        else:
            rgb = rgb.filter(
                ImageFilter.UnsharpMask(radius=0.70, percent=22, threshold=7)
            )

        result = Image.merge("RGBA", (*rgb.split(), alpha))

    plan = {
        "mode_requested": requested_mode,
        "mode_used": mode_label,
        "content_mode": content_mode,
        "engine": engine,
        "source_width": source_width,
        "source_height": source_height,
        "output_width": result.width,
        "output_height": result.height,
        "scale_ratio": round(
            max(
                result.width / max(source_width, 1),
                result.height / max(source_height, 1),
            ),
            2,
        ),
    }
    return result, plan


def _replace_image_field_png(field, image: Image.Image, filename: str) -> None:
    """Replace the previous generated file instead of accumulating versions."""
    if field:
        try:
            field.delete(save=False)
        except Exception:
            pass
    _save_rgba_png(field, image, filename)


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


def _is_near_white_rgba(pixel, floor: int = 215, chroma: int = 65) -> bool:
    red, green, blue, alpha = pixel
    if alpha <= 4:
        return False

    minimum = min(red, green, blue)
    maximum = max(red, green, blue)
    return minimum >= floor and (maximum - minimum) <= chroma


def _remove_border_connected_near_white(
    image: Image.Image,
    tolerance: int = 42,
) -> Image.Image:
    """
    Remove only near-white pixels connected to the outer image border.

    This is a safety pass for Magic Wand output. It clears white rectangular
    backgrounds while keeping interior white artwork that is not connected to
    the border.
    """
    rgba = image.convert("RGBA")
    width, height = rgba.size

    if width <= 0 or height <= 0:
        return rgba

    floor = max(170, min(245, 252 - int(tolerance * 1.3)))
    chroma = max(18, min(90, 16 + int(tolerance * 0.9)))
    step = max(1, min(width, height) // 140)

    seeds: set[tuple[int, int]] = set()

    for x in range(0, width, step):
        seeds.add((x, 0))
        seeds.add((x, height - 1))
    seeds.add((width - 1, 0))
    seeds.add((width - 1, height - 1))

    for y in range(0, height, step):
        seeds.add((0, y))
        seeds.add((width - 1, y))
    seeds.add((0, height - 1))

    for point in seeds:
        try:
            pixel = rgba.getpixel(point)
        except IndexError:
            continue

        if not _is_near_white_rgba(pixel, floor=floor, chroma=chroma):
            continue

        ImageDraw.floodfill(
            rgba,
            point,
            (255, 255, 255, 0),
            thresh=max(10, min(90, tolerance)),
        )

    return rgba


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
        "x_cm": _decimal(new_x),
        "y_cm": _decimal(new_y),
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
    """
    Initialize an empty/zero-height sheet, but do not continuously force the
    sheet to follow artwork. The operator can now resize or crop the sheet
    manually, and artwork is allowed to remain outside it.
    """
    if _decimal(sheet.height_cm) > Decimal("0.00"):
        return

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


def _pack_number(value: float) -> float:
    """Snap packing coordinates so repeated spacing does not drift."""
    return round(float(value), PACK_ROUND_DIGITS)


def _boxes_collide(candidate, existing, spacing: float) -> bool:
    """
    Return True only when two boxes genuinely overlap.

    Repeated float additions such as 36.6 + 5 + 0.2 can become
    41.800000000000004. Without a tolerance, the next box at 41.8 is
    incorrectly treated as colliding, causing Smart Duplicate to start a new
    row too early and leave a large empty strip on the right.
    """
    candidate_left = candidate["x"]
    candidate_top = candidate["y"]
    candidate_right = candidate_left + candidate["w"]
    candidate_bottom = candidate_top + candidate["h"]

    existing_left = existing["x"]
    existing_top = existing["y"]
    existing_right = existing_left + existing["w"]
    existing_bottom = existing_top + existing["h"]

    separated = (
        candidate_right + spacing <= existing_left + PACK_EPSILON
        or candidate_left >= existing_right + spacing - PACK_EPSILON
        or candidate_bottom + spacing <= existing_top + PACK_EPSILON
        or candidate_top >= existing_bottom + spacing - PACK_EPSILON
    )

    return not separated


def _candidate_positions(placed, margin: float, spacing: float):
    positions = {(_pack_number(margin), _pack_number(margin))}

    for box in placed:
        positions.add(
            (
                _pack_number(box["x"] + box["w"] + spacing),
                _pack_number(box["y"]),
            )
        )
        positions.add(
            (
                _pack_number(box["x"]),
                _pack_number(box["y"] + box["h"] + spacing),
            )
        )
        positions.add(
            (
                _pack_number(margin),
                _pack_number(box["y"] + box["h"] + spacing),
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
        if x < margin - PACK_EPSILON or y < margin - PACK_EPSILON:
            continue
        if x + width > sheet_width - margin + PACK_EPSILON:
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

        item.x_cm = _decimal(_pack_number(best_choice["x"]))
        item.y_cm = _decimal(_pack_number(best_choice["y"]))
        item.width_cm = _decimal(_pack_number(best_choice["w"]))
        item.height_cm = _decimal(_pack_number(best_choice["h"]))
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

    rightmost_edge = max(
        (box["x"] + box["w"] for box in placed),
        default=margin,
    )
    unused_right_cm = max(0.0, sheet_width - margin - rightmost_edge)

    return {
        "item_count": len(items),
        "used_height_cm": round(used_height, 2),
        "coverage_percent": round(coverage, 2),
        "waste_percent": round(waste, 2),
        "unused_right_cm": round(unused_right_cm, 2),
        "overflow_item_ids": overflow_ids,
    }


def _normalized_item_size(item: SheetItem):
    rotation = int(item.rotation or 0) % 180
    if rotation == 90:
        return _decimal(item.height_cm), _decimal(item.width_cm)
    return _decimal(item.width_cm), _decimal(item.height_cm)


def _best_export_file_field(item: SheetItem):
    """
    Use the clearest available artwork for print export.

    Perfect Clear / AI output is preferred when available. If it does not
    exist, keep the operator's selected cleaned/original source.
    """
    if item.asset.upscaled_file:
        return item.asset.upscaled_file
    if item.use_processed and item.asset.processed_file:
        return item.asset.processed_file
    if item.asset.original_file:
        return item.asset.original_file
    if item.asset.processed_file:
        return item.asset.processed_file
    return None


def _image_for_export(
    item: SheetItem,
    prefer_best: bool = True,
) -> tuple[Image.Image, str]:
    file_field = (
        _best_export_file_field(item)
        if prefer_best
        else _pick_file_field(item)
    )
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

    return image, str(getattr(file_field, "name", ""))


def _resize_rgba_for_export(
    image: Image.Image,
    target_size: tuple[int, int],
    sharpen: bool = False,
) -> Image.Image:
    """
    Resize transparent artwork with premultiplied alpha.

    This avoids pale/grey halos around transparent edges and produces cleaner
    text and logo boundaries than resizing normal RGBA directly.
    """
    target_width, target_height = target_size
    if image.size == target_size:
        result = image.convert("RGBA")
    else:
        premultiplied = image.convert("RGBa")
        premultiplied = premultiplied.resize(
            (target_width, target_height),
            LANCZOS,
        )
        result = premultiplied.convert("RGBA")

    if sharpen and min(target_width, target_height) >= 16:
        red, green, blue, alpha = result.split()
        rgb = Image.merge("RGB", (red, green, blue)).filter(
            ImageFilter.UnsharpMask(
                radius=0.55,
                percent=22,
                threshold=6,
            )
        )
        red, green, blue = rgb.split()
        result = Image.merge("RGBA", (red, green, blue, alpha))

    return result


def _prepare_item_image_for_export(
    item: SheetItem,
    target_width: int,
    target_height: int,
    smart_clear: bool,
) -> tuple[Image.Image, bool, str]:
    """
    Render one item at its final print dimensions.

    When the source does not contain enough pixels, use the installed
    Real-ESRGAN engine once during export. If the AI engine is unavailable,
    use a conservative high-quality fallback without aggressive halos.
    """
    image, source_name = _image_for_export(item, prefer_best=True)
    source_width, source_height = image.size
    needs_upscale = (
        target_width > int(source_width * 1.10)
        or target_height > int(source_height * 1.10)
    )

    ai_used = False
    engine = "source_or_lanczos"

    if smart_clear and needs_upscale:
        ai_image = _run_realesrgan_ncnn(
            image,
            target_width,
            target_height,
        )
        if ai_image is not None:
            image = ai_image
            ai_used = True
            engine = "realesrgan_ncnn"
        else:
            # Optional OpenCV super-resolution fallback.
            ai_image = _try_superres_upscale(
                image,
                target_width,
                target_height,
            )
            if ai_image is not None:
                image = ai_image
                ai_used = True
                engine = "opencv_dnn_superres"

    if image.size != (target_width, target_height):
        image = _resize_rgba_for_export(
            image,
            (target_width, target_height),
            sharpen=needs_upscale and not ai_used,
        )

    return image, ai_used, f"{engine}:{source_name}"


# ============================================================
# SHEET API
# ============================================================


@csrf_exempt
@require_http_methods(["GET", "PATCH", "POST"])
def sheet_detail_api(request, sheet_id):
    sheet = get_object_or_404(Sheet, id=sheet_id)

    if request.method in {"PATCH", "POST"}:
        payload = _json_body(request)

        width = max(
            _decimal(payload.get("width_cm", sheet.width_cm)),
            Decimal("1.00"),
        )
        height = max(
            _decimal(payload.get("height_cm", sheet.height_cm)),
            Decimal("1.00"),
        )

        margin = max(
            _decimal(payload.get("margin_cm", sheet.margin_cm)),
            Decimal("0.00"),
        )
        spacing = max(
            _decimal(payload.get("spacing_cm", sheet.spacing_cm)),
            Decimal("0.00"),
        )

        if margin * 2 >= width:
            return JsonResponse(
                {
                    "error": (
                        "The left and right margins are too large "
                        "for this sheet width."
                    )
                },
                status=400,
            )

        sheet.width_cm = width
        sheet.height_cm = height
        sheet.margin_cm = margin
        sheet.spacing_cm = spacing
        sheet.save(
            update_fields=[
                "width_cm",
                "height_cm",
                "margin_cm",
                "spacing_cm",
            ]
        )

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
            "ok": True,
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
            or 300
        )
    except (TypeError, ValueError):
        requested_dpi = 300

    # 300 DPI is the normal production setting. 600 DPI is allowed for
    # smaller sheets when memory limits permit.
    if requested_dpi >= 600:
        dpi = 600
    elif requested_dpi >= 300:
        dpi = 300
    else:
        dpi = 150

    quality = str(
        request.GET.get("quality")
        or request.POST.get("quality")
        or "smart"
    ).strip().lower()
    smart_clear = quality != "standard"

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
                    f"{dpi} DPI is too large for this sheet length. "
                    "Choose 300 DPI, reduce the sheet length, or crop the sheet."
                )
            },
            status=400,
        )

    canvas = Image.new("RGBA", (width_px, height_px), (0, 0, 0, 0))
    pixels_per_cm = dpi / 2.54
    skipped_item_ids: list[int] = []
    enhanced_item_ids: list[int] = []
    render_cache: dict[tuple, tuple[Image.Image, bool, str]] = {}
    engines: set[str] = set()

    for item in items:
        try:
            item_width_px = max(
                1,
                int(round(_float(item.width_cm) * pixels_per_cm)),
            )
            item_height_px = max(
                1,
                int(round(_float(item.height_cm) * pixels_per_cm)),
            )

            # Duplicate layers normally share one asset and one final size.
            # Cache the expensive AI render so it is calculated only once.
            cache_key = (
                item.asset_id,
                bool(item.use_processed),
                bool(item.use_upscaled),
                int(item.rotation or 0) % 360,
                item_width_px,
                item_height_px,
                smart_clear,
            )

            cached = render_cache.get(cache_key)
            if cached is None:
                cached = _prepare_item_image_for_export(
                    item,
                    item_width_px,
                    item_height_px,
                    smart_clear=smart_clear,
                )
                render_cache[cache_key] = cached

            image, ai_used, engine_info = cached
            if ai_used:
                enhanced_item_ids.append(item.id)
            engines.add(engine_info.split(":", 1)[0])

            x = int(round(_float(item.x_cm) * pixels_per_cm))
            y = int(round(_float(item.y_cm) * pixels_per_cm))
            canvas.alpha_composite(image, (x, y))
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
        compress_level=4,
    )
    buffer.seek(0)

    safe_name = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in sheet.name
    ).strip("_") or f"sheet_{sheet.id}"

    quality_name = "smart-clear" if smart_clear else "standard"
    response = FileResponse(
        buffer,
        as_attachment=True,
        filename=f"{safe_name}_{dpi}dpi_{quality_name}.png",
        content_type="image/png",
    )
    response["X-Niron-Export-DPI"] = str(dpi)
    response["X-Niron-Export-Width"] = str(width_px)
    response["X-Niron-Export-Height"] = str(height_px)
    response["X-Niron-AI-Enhanced"] = str(len(enhanced_item_ids))
    response["X-Niron-Engines"] = ",".join(sorted(engines))

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
        x_cm=_decimal(payload.get("x_cm", sheet.margin_cm)),
        y_cm=_decimal(payload.get("y_cm", sheet.margin_cm)),
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
        x_cm=item.x_cm + offset_x,
        y_cm=item.y_cm + offset_y,
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

    if "x_cm" in payload:
        item.x_cm = _decimal(payload["x_cm"])

    if "y_cm" in payload:
        item.y_cm = _decimal(payload["y_cm"])

    if "width_cm" in payload:
        item.width_cm = max(
            _decimal(payload["width_cm"]),
            Decimal("0.10"),
        )

    if "height_cm" in payload:
        item.height_cm = max(
            _decimal(payload["height_cm"]),
            Decimal("0.10"),
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
            # The selected item is the master for this duplicate group. Older
            # copies may have been resized or rotated separately, which creates
            # invisible packing gaps. Normalize the group before changing the
            # quantity so every copy has the exact same print footprint.
            rows_to_normalize = [row for row in existing if row.id != item.id]

            for row in rows_to_normalize:
                row.width_cm = item.width_cm
                row.height_cm = item.height_cm
                row.rotation = item.rotation
                row.lock_ratio = item.lock_ratio
                row.use_processed = item.use_processed
                row.use_upscaled = item.use_upscaled
                row.quantity = 1

            if rows_to_normalize:
                SheetItem.objects.bulk_update(
                    rows_to_normalize,
                    [
                        "width_cm",
                        "height_cm",
                        "rotation",
                        "lock_ratio",
                        "use_processed",
                        "use_upscaled",
                        "quantity",
                    ],
                )

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

        cleaned_image = _remove_border_connected_near_white(
            cleaned_image,
            tolerance=28,
        )

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

        # Safety pass: remove any near-white rectangle still connected to the
        # outer border before trimming and saving.
        image = _remove_border_connected_near_white(image)

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
def crop_item_api(request, item_id):
    """
    Crop the currently displayed artwork to an explicit rectangle.

    The frontend sends the cropped PNG plus the crop rectangle measured in the
    source canvas. Every real copy of the same artwork is updated so the layer
    box becomes tight around the cropped image while preserving its position.
    """
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )
    cropped_file = request.FILES.get("file")

    if not cropped_file:
        return JsonResponse(
            {"error": "No cropped PNG received."},
            status=400,
        )

    validation_error = _validate_uploaded_image(cropped_file)
    if validation_error:
        return JsonResponse(
            {"error": validation_error},
            status=400,
        )

    try:
        source_width = int(request.POST.get("source_width", "0"))
        source_height = int(request.POST.get("source_height", "0"))
        left = int(request.POST.get("left", "0"))
        top = int(request.POST.get("top", "0"))
        crop_width = int(request.POST.get("crop_width", "0"))
        crop_height = int(request.POST.get("crop_height", "0"))
    except (TypeError, ValueError):
        return JsonResponse(
            {"error": "Invalid crop measurements."},
            status=400,
        )

    if source_width <= 0 or source_height <= 0:
        return JsonResponse(
            {"error": "Invalid source image size."},
            status=400,
        )

    if crop_width <= 1 or crop_height <= 1:
        return JsonResponse(
            {"error": "Crop area is too small."},
            status=400,
        )

    left = max(0, min(left, source_width - 1))
    top = max(0, min(top, source_height - 1))
    crop_width = min(crop_width, source_width - left)
    crop_height = min(crop_height, source_height - top)

    try:
        cropped_file.seek(0)
        with Image.open(cropped_file) as opened:
            uploaded_crop = opened.convert("RGBA")

        # Remove any transparent padding still left inside the chosen crop.
        final_image, inner_box, _ = _trim_transparent_pixels(uploaded_crop)
        inner_left, inner_top, inner_right, inner_bottom = inner_box

        final_box = (
            left + inner_left,
            top + inner_top,
            left + inner_right,
            top + inner_bottom,
        )

        stem = os.path.splitext(
            os.path.basename(item.asset.original_file.name)
        )[0]

        with transaction.atomic():
            rows = list(item.asset.sheet_items.all())

            for row in rows:
                geometry = _trimmed_geometry_for_item(
                    row,
                    (source_width, source_height),
                    final_box,
                )
                row.x_cm = geometry["x_cm"]
                row.y_cm = geometry["y_cm"]
                row.width_cm = geometry["width_cm"]
                row.height_cm = geometry["height_cm"]
                row.use_processed = True
                row.use_upscaled = False

            if rows:
                SheetItem.objects.bulk_update(
                    rows,
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
                item.asset.processed_file,
                final_image,
                f"{stem}_cropped.png",
            )

        for sheet_id in {row.sheet_id for row in rows}:
            sheet = Sheet.objects.filter(id=sheet_id).first()
            if sheet:
                _recalculate_sheet_height(sheet)

        item.refresh_from_db()

        return JsonResponse(
            {
                "ok": True,
                "processed_url": _file_url(
                    request,
                    item.asset.processed_file,
                ),
                "item": _item_payload(request, item),
                "crop": {
                    "left": final_box[0],
                    "top": final_box[1],
                    "width": final_box[2] - final_box[0],
                    "height": final_box[3] - final_box[1],
                },
            }
        )

    except ValueError as exc:
        return JsonResponse(
            {"error": str(exc)},
            status=400,
        )
    except Exception as exc:
        return JsonResponse(
            {"error": f"Crop failed: {exc}"},
            status=500,
        )


@csrf_exempt
@require_http_methods(["POST"])
def upscale_item_api(request, item_id):
    """
    Create a fresh smart upscale from the clean original/processed source.

    Repeated clicks are idempotent: the endpoint never uses ``upscaled_file``
    as its source, so it does not repeatedly resize or sharpen an already
    enhanced image.
    """
    item = get_object_or_404(
        SheetItem.objects.select_related("asset"),
        id=item_id,
    )
    asset = item.asset
    source, source_kind = _clean_upscale_source(asset)

    if not source:
        return JsonResponse({"error": "No image found."}, status=400)

    requested_mode = _requested_upscale_mode(request)

    try:
        source_image = _read_rgba_file_field(source)
        upscaled_image, plan = _smart_upscale_image(
            source_image,
            requested_mode,
            item=item,
        )

        source_stem = os.path.splitext(os.path.basename(source.name))[0]
        filename = f"{source_stem}_{plan['mode_used']}_{plan['output_width']}x{plan['output_height']}.png"

        with transaction.atomic():
            _replace_image_field_png(asset.upscaled_file, upscaled_image, filename)
            asset.sheet_items.update(use_upscaled=True, use_processed=False)

        item.refresh_from_db()

        return JsonResponse(
            {
                "ok": True,
                "message": (
                    f"Upscale complete: {plan['mode_used']} "
                    f"({plan['output_width']}×{plan['output_height']}) "
                    f"using {plan['engine']}."
                ),
                "source_kind": source_kind,
                "upscaled_url": _file_url(request, asset.upscaled_file),
                "item": _item_payload(request, item),
                **plan,
            }
        )

    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"error": f"Smart upscale failed: {exc}"}, status=500)


