#!/usr/bin/env python3
"""
Generates the boxcode app-icon set as a Python/Pillow fallback for
icons/build_icons.sh, whose real toolchain (icns2png, composite, convert,
png2icns, icotool, rsvg-convert) is unavailable in this environment (no
Homebrew, no rsvg/imagemagick/icoutils/libicns binaries). Pillow itself
supports writing both ICNS and ICO natively (confirmed: Image.save(...,
format="ICNS"/"ICO") works without shelling out), so every raster/icon
target is produced directly here instead.

Mark: a rounded dark "box" tile with an inset amber rounded square (the
box body) and a smaller bright-amber accent square straddling its
bottom-right corner (a code-cursor blip breaking out of the box) --
literal enough for "boxcode", abstract enough to not read as a scaled
wordmark, and simple enough (3 flat shapes, no fine detail) to stay
legible at 16px.
"""
import os

from PIL import Image, ImageDraw

DARK = (26, 23, 19, 255)      # #1A1713 -- warm ground, matches boxcode-dark.json
AMBER = (217, 119, 6, 255)    # #D97706 -- primary accent
BRIGHT = (251, 191, 36, 255)  # #FBBF24 -- cursor-blip accent, matches boxcode-dark.json textLink

CANVAS = 1024  # master raster size; everything else is downsampled from this


def draw_mark(size, with_tile=True):
    """Draws the mark at `size`x`size` with high-res supersampling for clean edges."""
    ss = 4
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def box(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle([x0 * big / 100, y0 * big / 100, x1 * big / 100, y1 * big / 100],
                             radius=r * big / 100, fill=fill)

    if with_tile:
        box(6, 6, 94, 94, 20, DARK)
    box(24, 24, 76, 76, 12, AMBER)
    box(62, 62, 82, 82, 5, BRIGHT)

    return img.resize((size, size), Image.LANCZOS)


def svg_mark():
    """Hand-authored SVG matching draw_mark(with_tile=True)'s geometry exactly."""
    return '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0" y="0" width="1024" height="1024" viewBox="0, 0, 100, 100">
  <g id="boxcode_mark">
    <rect x="6" y="6" width="88" height="88" rx="20" fill="#1A1713"/>
    <rect x="24" y="24" width="52" height="52" rx="12" fill="#D97706"/>
    <rect x="62" y="62" width="20" height="20" rx="5" fill="#FBBF24"/>
  </g>
</svg>
'''


def letterpress_svg(fill, opacity=None):
    """40x40 viewBox, glyph-only (no tile), matching the original letterpress convention."""
    opacity_attr = f' fill-opacity="{opacity}"' if opacity is not None else ''
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0" y="0" width="40" height="40" viewBox="0, 0, 40, 40">
  <g id="boxcode_letterpress" fill="{fill}"{opacity_attr}>
    <rect x="9.6" y="9.6" width="20.8" height="20.8" rx="4.8"/>
    <rect x="24.8" y="24.8" width="8" height="8" rx="2"/>
  </g>
</svg>
'''


def main():
    out = "out"
    os.makedirs(out, exist_ok=True)

    master = draw_mark(CANVAS, with_tile=True)
    master.save(f"{out}/code-master-1024.png")

    for sz in (512, 256, 192, 128, 70, 64, 48, 32, 24, 20, 16):
        master.resize((sz, sz), Image.LANCZOS).save(f"{out}/code-{sz}.png")

    # ICNS (darwin app icon) -- Pillow writes multi-resolution natively.
    master.save(f"{out}/code.icns", format="ICNS")

    # ICO (win32 app icon + server favicon) -- Pillow writes multi-resolution natively.
    master.save(f"{out}/code.ico", format="ICO",
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # Linux main PNG (1024) already covered by code-master-1024.png / code-1024 alias.
    master.save(f"{out}/code-1024.png")

    with open(f"{out}/code-icon.svg", "w") as f:
        f.write(svg_mark())
    with open(f"{out}/code-linux.svg", "w") as f:
        f.write(svg_mark())

    with open(f"{out}/letterpress-dark.svg", "w") as f:
        f.write(letterpress_svg("#B2B2B2", opacity="0.3"))
    with open(f"{out}/letterpress-light.svg", "w") as f:
        f.write(letterpress_svg("#B2B2B2", opacity="0.1"))
    with open(f"{out}/letterpress-hcDark.svg", "w") as f:
        f.write(letterpress_svg("#3C3C3C"))
    with open(f"{out}/letterpress-hcLight.svg", "w") as f:
        f.write(letterpress_svg("#B2B2B2"))

    print("done")


if __name__ == "__main__":
    main()
