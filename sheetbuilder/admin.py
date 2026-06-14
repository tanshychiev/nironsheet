from django.contrib import admin
from .models import Sheet, UploadAsset, SheetItem


@admin.register(Sheet)
class SheetAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'width_cm', 'spacing_cm', 'margin_cm', 'created_at')


@admin.register(UploadAsset)
class UploadAssetAdmin(admin.ModelAdmin):
    list_display = ('id', 'sheet', 'original_file', 'created_at')


@admin.register(SheetItem)
class SheetItemAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'sheet', 'asset', 'x_cm', 'y_cm', 'width_cm', 'height_cm',
        'quantity', 'lock_ratio', 'use_processed', 'use_upscaled'
    )