#!/usr/bin/env python3
"""Generate Delver artwork from resources/delver/logo.png.

Run from the repository root:
    python scripts/generate-artwork.py
"""

import io
import os
import struct
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_PATH = os.path.join(ROOT, 'resources', 'delver', 'logo.png')
BACKGROUND = (13, 14, 15)  # #0d0e0f — matches Delver Dark chrome


def load_master(size: int = 1024) -> Image.Image:
    """Load the logo, trim transparent edges, and center it on a square canvas."""
    img = Image.open(LOGO_PATH).convert('RGBA')
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    # Use a square canvas; scale logo to fit with 10% padding.
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    logo_size = int(size * 0.8)
    img.thumbnail((logo_size, logo_size), Image.Resampling.LANCZOS)

    x = (size - img.width) // 2
    y = (size - img.height) // 2
    canvas.paste(img, (x, y), img)
    return canvas


def make_ico(master: Image.Image, path: str, sizes: list[int]) -> None:
    """Write a multi-resolution Windows ICO."""
    imgs = []
    for s in sizes:
        copy = master.copy()
        copy.thumbnail((s, s), Image.Resampling.LANCZOS)
        # Center on a square s×s canvas.
        canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        x = (s - copy.width) // 2
        y = (s - copy.height) // 2
        canvas.paste(copy, (x, y), copy)
        imgs.append(canvas)
    imgs[0].save(path, format='ICO', sizes=[(i.width, i.height) for i in imgs], append_images=imgs[1:])


def make_icns(master: Image.Image, path: str) -> None:
    """Write a macOS ICNS file using PNG-encoded entries."""
    # icp4/5/6/7/8/9/10 are 16/32/64/128/256/512/1024 PNG entries.
    types = {
        16: b'icp4',
        32: b'icp5',
        64: b'icp6',
        128: b'ic07',
        256: b'ic08',
        512: b'ic09',
        1024: b'ic10',
    }
    records = []
    for size, type_code in types.items():
        copy = master.copy()
        copy.thumbnail((size, size), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        x = (size - copy.width) // 2
        y = (size - copy.height) // 2
        canvas.paste(copy, (x, y), copy)
        buf = io.BytesIO()
        canvas.save(buf, format='PNG')
        data = buf.getvalue()
        length = 8 + len(data)
        records.append(type_code + struct.pack('>I', length) + data)

    body = b''.join(records)
    file_length = 8 + len(body)
    with open(path, 'wb') as f:
        f.write(b'icns' + struct.pack('>I', file_length) + body)


def make_png(master: Image.Image, path: str, size: int) -> None:
    """Write a square transparent PNG."""
    copy = master.copy()
    copy.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    x = (size - copy.width) // 2
    y = (size - copy.height) // 2
    canvas.paste(copy, (x, y), copy)
    canvas.save(path)


def make_bmp(master: Image.Image, path: str, size: tuple[int, int]) -> None:
    """Write a BMP with the logo centered on the Delver Dark background."""
    w, h = size
    canvas = Image.new('RGB', (w, h), BACKGROUND)
    copy = master.copy()
    # Fill most of the canvas but leave a margin.
    fit_w = int(w * 0.45)
    fit_h = int(h * 0.55)
    copy.thumbnail((fit_w, fit_h), Image.Resampling.LANCZOS)
    x = (w - copy.width) // 2
    y = (h - copy.height) // 2
    # Composite using alpha.
    bg = Image.new('RGBA', (w, h), (*BACKGROUND, 255))
    bg.paste(copy, (x, y), copy)
    canvas = bg.convert('RGB')
    canvas.save(path, format='BMP')


def main() -> None:
    master = load_master(1024)

    # Windows
    make_ico(master, os.path.join(ROOT, 'resources', 'win32', 'code.ico'),
             [16, 24, 32, 48, 64, 128, 256])
    make_png(master, os.path.join(ROOT, 'resources', 'win32', 'code_70x70.png'), 70)
    make_png(master, os.path.join(ROOT, 'resources', 'win32', 'code_150x150.png'), 150)

    inno_big = {
        100: (164, 314),
        125: (192, 386),
        150: (246, 459),
        175: (273, 556),
        200: (328, 604),
        225: (355, 700),
        250: (410, 797),
    }
    for scale, size in inno_big.items():
        make_bmp(master, os.path.join(ROOT, 'resources', 'win32', f'inno-big-{scale}.bmp'), size)

    inno_small = {
        100: (55, 55),
        125: (64, 68),
        150: (83, 80),
        175: (92, 97),
        200: (110, 106),
        225: (119, 123),
        250: (138, 140),
    }
    for scale, size in inno_small.items():
        make_bmp(master, os.path.join(ROOT, 'resources', 'win32', f'inno-small-{scale}.bmp'), size)

    # macOS
    make_icns(master, os.path.join(ROOT, 'resources', 'darwin', 'code.icns'))

    # Linux
    make_png(master, os.path.join(ROOT, 'resources', 'linux', 'code.png'), 1024)

    # Server/web
    make_png(master, os.path.join(ROOT, 'resources', 'server', 'code-192.png'), 192)
    make_png(master, os.path.join(ROOT, 'resources', 'server', 'code-512.png'), 512)
    make_ico(master, os.path.join(ROOT, 'resources', 'server', 'favicon.ico'), [16, 32, 48])

    print('Artwork generated.')


if __name__ == '__main__':
    main()
