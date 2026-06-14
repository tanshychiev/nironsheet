from django.urls import path

from . import views


urlpatterns = [
    # ====================================================
    # PAGES
    # ====================================================
    path("", views.home, name="home"),
    path("create-sheet/", views.create_sheet, name="create_sheet"),
    path("builder/<int:sheet_id>/", views.builder, name="builder"),

    # ====================================================
    # SHEET API
    # ====================================================
    path(
        "api/sheets/<int:sheet_id>/",
        views.sheet_detail_api,
        name="sheet_detail_api",
    ),
    path(
        "api/sheets/<int:sheet_id>/upload/",
        views.upload_asset_api,
        name="upload_asset_api",
    ),
    path(
        "api/sheets/<int:sheet_id>/auto-pack/",
        views.auto_pack_sheet_api,
        name="auto_pack_sheet_api",
    ),
    path(
        "api/sheets/<int:sheet_id>/export/png/",
        views.export_sheet_png_api,
        name="export_sheet_png_api",
    ),
    path(
        "api/sheets/<int:sheet_id>/items/create/",
        views.create_item_api,
        name="create_item_api",
    ),

    # ====================================================
    # ITEM API
    # ====================================================
    path(
        "api/items/<int:item_id>/update/",
        views.update_item_api,
        name="update_item_api",
    ),
    path(
        "api/items/<int:item_id>/smart-duplicate/",
        views.smart_duplicate_item_api,
        name="smart_duplicate_item_api",
    ),
    path(
        "api/items/<int:item_id>/clone/",
        views.clone_item_api,
        name="clone_item_api",
    ),
    path(
        "api/items/<int:item_id>/delete/",
        views.delete_item_api,
        name="delete_item_api",
    ),
    path(
        "api/items/<int:item_id>/rotate/",
        views.rotate_item_api,
        name="rotate_item_api",
    ),

    # ====================================================
    # IMAGE PROCESSING API
    # ====================================================
    path(
        "api/items/<int:item_id>/remove-background/",
        views.remove_background_api,
        name="remove_background_api",
    ),
    path(
        "api/items/<int:item_id>/magic-wand/",
        views.magic_wand_apply_api,
        name="magic_wand_apply_api",
    ),
    path(
        "api/items/<int:item_id>/crop/",
        views.crop_item_api,
        name="crop_item_api",
    ),
    path(
        "api/items/<int:item_id>/upscale/",
        views.upscale_item_api,
        name="upscale_item_api",
    ),
]
