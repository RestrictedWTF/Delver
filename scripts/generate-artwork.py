#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

"""Generate Delver artwork from resources/delver/logo.png.

Covers two families of output:

  * OS-level raster icons under `resources/` — taskbar, dock, installer, favicon.
  * In-workbench SVGs under `src/` — the titlebar app icon and the empty-editor
	watermark. These are rendered by the renderer, not the OS, so replacing the
	raster icons alone leaves them showing the upstream VS Code logo.

Run from the repository root:
	python scripts/generate-artwork.py
"""

import io
import math
import os
import struct
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_PATH = os.path.join(ROOT, 'resources', 'delver', 'logo.png')
BACKGROUND = (13, 14, 15)  # #0d0e0f — matches Delver Dark chrome
LOGO_COLOR = '#ff9648'  # the single flat colour the logo is drawn in

# Contour simplification tolerance, in source-image pixels. The logo master is
# 665px wide and the largest place these SVGs render is the 256px watermark, so
# a sub-pixel tolerance here is well below anything visible.
TRACE_TOLERANCE = 0.35


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
	"""Write a multi-resolution Windows ICO.

	Pillow's ICO writer generates every requested size from a single source image.
	The source is rendered at the largest requested size with the logo centered.
	"""
	max_size = max(sizes)
	copy = master.copy()
	copy.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
	source = Image.new('RGBA', (max_size, max_size), (0, 0, 0, 0))
	x = (max_size - copy.width) // 2
	y = (max_size - copy.height) // 2
	source.paste(copy, (x, y), copy)
	source.save(path, format='ICO', sizes=[(s, s) for s in sizes])


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


def trace_alpha(path: str, level: float = 127.5) -> tuple[list[list[tuple[float, float]]], int, int]:
	"""Trace the logo's alpha channel into closed polygon contours.

	Marching squares over the alpha channel, with linear interpolation along
	each cell edge so the contour lands on the true half-opacity boundary rather
	than on pixel corners. Returns the contours plus the source image size.
	"""
	img = Image.open(path).convert('RGBA')
	width, height = img.size
	alpha = img.getchannel('A').load()

	def sample(x: int, y: int) -> float:
		"""Alpha at (x, y), with a transparent border so edge contours close."""
		if x < 0 or y < 0 or x >= width or y >= height:
			return 0.0
		return float(alpha[x, y])

	def crossing(v0: float, v1: float, p0: tuple[int, int], p1: tuple[int, int]) -> tuple[float, float]:
		t = 0.5 if v0 == v1 else (level - v0) / (v1 - v0)
		return (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)

	segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
	for y in range(-1, height):
		for x in range(-1, width):
			tl, tr = sample(x, y), sample(x + 1, y)
			br, bl = sample(x + 1, y + 1), sample(x, y + 1)
			case = ((tl > level) | ((tr > level) << 1) | ((br > level) << 2) | ((bl > level) << 3))
			if case == 0 or case == 15:
				continue

			top = crossing(tl, tr, (x, y), (x + 1, y))
			right = crossing(tr, br, (x + 1, y), (x + 1, y + 1))
			bottom = crossing(bl, br, (x, y + 1), (x + 1, y + 1))
			left = crossing(tl, bl, (x, y), (x, y + 1))

			# Segments are oriented so the filled side is on the left.
			if case == 1:
				segments.append((left, top))
			elif case == 2:
				segments.append((top, right))
			elif case == 3:
				segments.append((left, right))
			elif case == 4:
				segments.append((right, bottom))
			elif case == 6:
				segments.append((top, bottom))
			elif case == 7:
				segments.append((left, bottom))
			elif case == 8:
				segments.append((bottom, left))
			elif case == 9:
				segments.append((bottom, top))
			elif case == 11:
				segments.append((bottom, right))
			elif case == 12:
				segments.append((right, left))
			elif case == 13:
				segments.append((right, top))
			elif case == 14:
				segments.append((top, left))
			else:
				# Saddle (5 and 10): the cell centre decides which way it joins.
				centre = (tl + tr + br + bl) / 4.0
				if case == 5:
					if centre > level:
						segments.append((left, top))
						segments.append((right, bottom))
					else:
						segments.append((left, bottom))
						segments.append((right, top))
				else:
					if centre > level:
						segments.append((top, right))
						segments.append((bottom, left))
					else:
						segments.append((top, left))
						segments.append((bottom, right))

	return stitch(segments), width, height


def stitch(segments: list[tuple[tuple[float, float], tuple[float, float]]]) -> list[list[tuple[float, float]]]:
	"""Join marching-squares segments end-to-end into closed contours."""
	def key(point: tuple[float, float]) -> tuple[float, float]:
		return (round(point[0], 4), round(point[1], 4))

	by_start: dict[tuple[float, float], list[int]] = {}
	for index, segment in enumerate(segments):
		by_start.setdefault(key(segment[0]), []).append(index)

	contours: list[list[tuple[float, float]]] = []
	used = [False] * len(segments)
	for index in range(len(segments)):
		if used[index]:
			continue
		contour = [segments[index][0]]
		current = index
		while current is not None and not used[current]:
			used[current] = True
			contour.append(segments[current][1])
			current = next(
				(i for i in by_start.get(key(segments[current][1]), []) if not used[i]),
				None)
		if len(contour) > 3:
			contours.append(contour)
	return contours


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
	"""Ramer-Douglas-Peucker, iterative so deep contours don't blow the stack."""
	keep = [False] * len(points)
	keep[0] = keep[-1] = True
	stack = [(0, len(points) - 1)]
	while stack:
		start, end = stack.pop()
		if end - start < 2:
			continue
		ax, ay = points[start]
		bx, by = points[end]
		dx, dy = bx - ax, by - ay
		span = math.hypot(dx, dy)
		worst, worst_at = -1.0, start
		for i in range(start + 1, end):
			px, py = points[i]
			if span:
				distance = abs(dx * (ay - py) - (ax - px) * dy) / span
			else:
				distance = math.hypot(px - ax, py - ay)
			if distance > worst:
				worst, worst_at = distance, i
		if worst > tolerance:
			keep[worst_at] = True
			stack.append((start, worst_at))
			stack.append((worst_at, end))
	return [p for p, k in zip(points, keep) if k]


def simplify_contour(contour: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
	"""Simplify a closed contour, seaming it at a corner rather than mid-edge."""
	points = contour[:-1]
	cx = sum(p[0] for p in points) / len(points)
	cy = sum(p[1] for p in points) / len(points)
	# Start from the point farthest from the centroid — reliably a corner, so
	# the seam never pins a spurious vertex into the middle of a straight edge.
	pivot = max(range(len(points)), key=lambda i: (points[i][0] - cx) ** 2 + (points[i][1] - cy) ** 2)
	points = points[pivot:] + points[:pivot]
	return simplify(points + [points[0]], tolerance)[:-1]


def build_path(contours: list[list[tuple[float, float]]], scale: float,
			   offset: tuple[float, float], precision: int = 2) -> str:
	"""Render contours as SVG path data in the target coordinate space."""
	def coord(value: float) -> str:
		text = f'{value:.{precision}f}'.rstrip('0').rstrip('.')
		return text if text not in ('', '-0') else '0'

	commands = []
	for contour in contours:
		points = [(x * scale + offset[0], y * scale + offset[1]) for x, y in contour]
		commands.append('M' + ' '.join(f'{coord(x)} {coord(y)}' for x, y in points) + 'Z')
	return ''.join(commands)


def fit(source: tuple[int, int], box: tuple[float, float], margin: float) -> tuple[float, tuple[float, float]]:
	"""Scale/offset that centres the source inside the box, leaving a margin."""
	width, height = source
	box_w, box_h = box
	scale = min(box_w * (1 - margin) / width, box_h * (1 - margin) / height)
	return scale, ((box_w - width * scale) / 2, (box_h - height * scale) / 2)


def make_app_icon_svg(contours, source, path: str) -> None:
	"""The in-workbench app icon: titlebar, banner, welcome and walkthrough.

	Kept nearly edge-to-edge — it renders at 16px in the titlebar, where the
	generous padding the OS icons carry would leave the mark illegible.
	"""
	scale, offset = fit(source, (1024, 1024), margin=0.04)
	data = build_path([simplify_contour(c, TRACE_TOLERANCE) for c in contours], scale, offset)
	svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
		   f'<path fill="{LOGO_COLOR}" fill-rule="evenodd" d="{data}"/></svg>\n')
	with open(path, 'w', encoding='utf8', newline='\n') as f:
		f.write(svg)


def make_letterpress_svg(contours, source, path: str, root_attributes: str,
						 path_attributes: str) -> None:
	"""The empty-editor watermark, one variant per theme.

	The per-theme opacity/fill is carried over verbatim from upstream, so only
	the mark changes — the watermark keeps its previous visual weight.
	"""
	scale, offset = fit(source, (260, 260), margin=0.06)
	data = build_path([simplify_contour(c, TRACE_TOLERANCE) for c in contours], scale, offset)
	svg = (f'<svg width="260" height="260" viewBox="0 0 260 260" {root_attributes}'
		   'xmlns="http://www.w3.org/2000/svg">'
		   f'<path {path_attributes}fill-rule="evenodd" d="{data}"/></svg>\n')
	with open(path, 'w', encoding='utf8', newline='\n') as f:
		f.write(svg)


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

	# In-workbench SVGs. Traced from the same master so they can never drift
	# from the OS icons.
	contours, width, height = trace_alpha(LOGO_PATH)
	source = (width, height)

	make_app_icon_svg(contours, source,
					  os.path.join(ROOT, 'src', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'))

	letterpress = os.path.join(ROOT, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media')
	variants = {
		'light': ('opacity="0.1" ', ''),
		'dark': ('opacity="0.3" ', ''),
		'hcLight': ('', 'fill="#D9D9D9" '),
		'hcDark': ('', 'fill="#3C3C3C" '),
	}
	for name, (root_attributes, path_attributes) in variants.items():
		make_letterpress_svg(contours, source,
							 os.path.join(letterpress, f'letterpress-{name}.svg'),
							 root_attributes, path_attributes)

	print('Artwork generated.')


if __name__ == '__main__':
	main()
