from decimal import Decimal

from django.db import models


class Sheet(models.Model):
    name = models.CharField(max_length=200)

    width_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
    )
    height_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.00"),
    )
    spacing_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.20"),
    )
    margin_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.20"),
    )

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class UploadAsset(models.Model):
    sheet = models.ForeignKey(
        Sheet,
        on_delete=models.CASCADE,
        related_name="assets",
        null=True,
        blank=True,
    )

    # Original uploaded artwork
    original_file = models.ImageField(
        upload_to="niron/original/",
    )

    # Cropped, AI background-cleared, or Magic Wand result
    processed_file = models.ImageField(
        upload_to="niron/processed/",
        null=True,
        blank=True,
    )

    # Enlarged/upscaled version
    upscaled_file = models.ImageField(
        upload_to="niron/upscaled/",
        null=True,
        blank=True,
    )

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Asset {self.id}"


class SheetItem(models.Model):
    ROTATION_CHOICES = [
        (0, "0°"),
        (90, "90°"),
        (180, "180°"),
        (270, "270°"),
    ]

    sheet = models.ForeignKey(
        Sheet,
        on_delete=models.CASCADE,
        related_name="items",
    )
    asset = models.ForeignKey(
        UploadAsset,
        on_delete=models.CASCADE,
        related_name="sheet_items",
    )

    # Position on the sheet
    x_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.00"),
    )
    y_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.00"),
    )

    # Printed size
    width_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("5.00"),
    )
    height_cm = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("5.00"),
    )

    # Desired number of prints
    quantity = models.PositiveIntegerField(default=1)

    # Transform settings
    lock_ratio = models.BooleanField(default=True)
    rotation = models.PositiveSmallIntegerField(
        choices=ROTATION_CHOICES,
        default=0,
    )

    # Image source settings
    use_processed = models.BooleanField(default=False)
    use_upscaled = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Item {self.id} - Sheet {self.sheet_id}"