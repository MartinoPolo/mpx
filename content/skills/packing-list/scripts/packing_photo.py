"""Turns a downloaded product photo into the list's 256x256 transparent cut-out WebP.

Usage: python packing_photo.py <source image> <trip-dir>/images/<item id>.webp

A packshot on a plain white ground loses that ground: near-white pixels connected to the image edge become
transparent, so white parts inside the product stay. The product is then trimmed and centred with a small margin.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

SIZE = 256
MARGIN = 8
WHITE_TOLERANCE = 28


def clear_edge_background(image: Image.Image) -> Image.Image:
    if image.getextrema()[3][0] < 255:
        return image
    # Flood-fill a marker colour from every edge pixel through near-white, then turn the marked area transparent.
    marker = (255, 0, 255)
    filled = image.convert("RGB")
    width, height = filled.size
    edge_points = [(x, y) for x in range(0, width, 4) for y in (0, height - 1)]
    edge_points += [(x, y) for y in range(0, height, 4) for x in (0, width - 1)]
    for point in edge_points:
        if min(filled.getpixel(point)) >= 255 - WHITE_TOLERANCE:
            ImageDraw.floodfill(filled, point, marker, thresh=WHITE_TOLERANCE)
    background = ImageChops.difference(filled, Image.new("RGB", filled.size, marker)).convert("L").point(lambda value: 255 if value else 0)
    image.putalpha(ImageChops.multiply(image.getchannel("A"), background))
    return image


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    image = clear_edge_background(Image.open(source).convert("RGBA"))
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        sys.exit(f"{source} has nothing left after removing the background.")
    image = image.crop(bounds)
    image.thumbnail((SIZE - 2 * MARGIN, SIZE - 2 * MARGIN), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(image, ((SIZE - image.width) // 2, (SIZE - image.height) // 2), image)
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target, "WEBP", quality=82, method=6)
    print(f"{target} {target.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
