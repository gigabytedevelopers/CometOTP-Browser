"""Draws the Chrome Web Store's small promo tile, small-440x280.png, beside this file.

The CometOTP mark (extension/static/icons/mark.svg) in white over the brand indigo, the name, and
the screenshots' headline below it, in Inter like the screenshots. It is drawn four times larger
and scaled down, so its edges are smooth.

Needs Python 3 with Pillow, and Inter's variable font (https://rsms.me/inter/):

    py -3 -I extension/store/promo-tile/draw.py "C:/Windows/Fonts/Inter-VariableFont_opsz,wght.ttf"
"""
import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
MARK = HERE.parents[1] / 'static' / 'icons' / 'mark.svg'
OUT = HERE / 'small-440x280.png'

W, H, SCALE = 440, 280, 4
# The popup's --brand and --on-brand (static/popup/popup.css), a lighter and a darker indigo for
# the wash behind, and the dark theme's --brand for the headline.
BRAND = (0x29, 0x33, 0x9B)
BRAND_LIGHT = (0x3A, 0x45, 0xB8)
BRAND_DARK = (0x1E, 0x25, 0x78)
ON_BRAND = (0xFF, 0xFF, 0xFF)
HEADLINE = (0xBD, 0xC2, 0xFF)


def mark_outline(steps=24):
    """The mark's outline as points in its 100 x 67.5 viewBox; its path is all M, C and Z."""
    d = re.search(r'\sd="([^"]+)"', MARK.read_text(encoding='utf-8')).group(1)
    tokens = re.findall(r'[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?', d)
    points, i, command, current = [], 0, None, (0.0, 0.0)
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command == 'Z':
                continue
        if command == 'M':
            current = (float(tokens[i]), float(tokens[i + 1]))
            points.append(current)
            i += 2
        elif command == 'C':
            p0 = current
            p1, p2, p3 = ((float(tokens[i + j]), float(tokens[i + j + 1])) for j in (0, 2, 4))
            for s in range(1, steps + 1):
                t = s / steps
                u = 1 - t
                points.append(tuple(
                    u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]
                    for k in range(2)
                ))
            current = p3
            i += 6
        else:
            raise ValueError(f'The mark uses {command}, which this does not draw')
    return points


def inter(path, size, weight):
    """Inter at `size` px and `weight`, its optical size matched to the size."""
    font = ImageFont.truetype(path, size * SCALE)
    values = []
    for axis in font.get_variation_axes():
        name = axis.get('name', b'')
        name = (name.decode() if isinstance(name, bytes) else str(name)).lower()
        if 'weight' in name:
            values.append(weight)
        elif 'optical' in name:
            values.append(min(max(size, axis['minimum']), axis['maximum']))
        else:
            values.append(axis['default'])
    font.set_variation_by_axes(values)
    return font


def main(font_path):
    w, h = W * SCALE, H * SCALE
    # A diagonal wash from the lighter indigo at the top left to the darker at the bottom right.
    tile = Image.new('RGB', (w, h))
    pixels = tile.load()
    for y in range(h):
        for x in range(w):
            t = x / w * 0.55 + y / h * 0.45
            a, b, k = (BRAND_LIGHT, BRAND, t / 0.5) if t < 0.5 else (BRAND, BRAND_DARK, (t - 0.5) / 0.5)
            pixels[x, y] = tuple(round(a[c] + (b[c] - a[c]) * k) for c in range(3))
    draw = ImageDraw.Draw(tile)

    # The mark, 116 px wide and centred.
    mark_w, top = 116, 46
    mark_h = mark_w * 67.5 / 100
    left, k = (W - mark_w) / 2, mark_w / 100 * SCALE
    draw.polygon([(left * SCALE + x * k, top * SCALE + y * k) for x, y in mark_outline()], fill=ON_BRAND)

    def centred(text, font, y, colour):
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(((w - (box[2] - box[0])) / 2 - box[0], y * SCALE - box[1]), text, font=font, fill=colour)

    name_top = top + mark_h + 26
    centred('CometOTP', inter(font_path, 44, 700), name_top, ON_BRAND)
    centred('Your two-factor codes, in your browser', inter(font_path, 17, 500), name_top + 62, HEADLINE)

    tile.resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print(f'{OUT.name}: {W} x {H}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
