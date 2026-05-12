"""Generate PWA icons for the Strength app.

Renders a flame logo on a red→orange gradient background at the standard
PWA sizes (192, 512) plus a maskable variant (with safe-area padding) and
the iOS apple-touch-icon (180x180). Outputs PNG files into ./public/.
"""

from PIL import Image, ImageDraw
import math

OUT_DIR = "/home/claude/pwa/strength/public"

# Palette — matches the app
TOP_COLOR = (255, 55, 95)      # #FF375F
BOTTOM_COLOR = (255, 149, 0)   # #FF9500
FLAME_COLOR = (255, 255, 255)  # white


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        c = lerp(top, bottom, y / max(size - 1, 1))
        for x in range(size):
            px[x, y] = c
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def draw_flame(draw, cx, cy, scale):
    """Stylized flame: a teardrop with a small inner curl."""
    # Outer flame: bezier-esque shape via polygon
    # We define points around an idealized 1.0 unit flame, then scale.
    flame = [
        (0.00, -1.00),  # top tip
        (0.30, -0.55),
        (0.55, -0.10),
        (0.65, 0.40),
        (0.45, 0.80),
        (0.00, 0.95),   # bottom
        (-0.45, 0.80),
        (-0.65, 0.40),
        (-0.55, -0.10),
        (-0.30, -0.55),
    ]
    pts = [(cx + p[0] * scale, cy + p[1] * scale) for p in flame]
    draw.polygon(pts, fill=FLAME_COLOR)

    # Inner highlight (smaller flame, slightly offset, semi-transparent feel via lighter color)
    inner = [(cx + p[0] * scale * 0.45, cy + p[1] * scale * 0.45 + scale * 0.15) for p in flame]
    draw.polygon(inner, fill=(255, 200, 120))


def render(size, maskable=False):
    bg = gradient_bg(size, TOP_COLOR, BOTTOM_COLOR)

    # For maskable icons, the inner ~80% is the safe area; flame must fit there.
    flame_scale = size * (0.32 if maskable else 0.36)
    draw = ImageDraw.Draw(bg)
    draw_flame(draw, size / 2, size / 2 + size * 0.04, flame_scale)

    # Apply rounded mask only to non-maskable variants (PWA default icons get
    # rounded by the OS itself, but iOS apple-touch-icon also benefits from
    # being already rounded). For maskable we leave it square and let Android
    # mask it to whatever shape the launcher prefers.
    if not maskable:
        mask = rounded_mask(size, int(size * 0.22))
        rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rounded.paste(bg, (0, 0), mask)
        return rounded
    else:
        return bg.convert("RGBA")


def save(img, name):
    path = f"{OUT_DIR}/{name}"
    img.save(path, "PNG", optimize=True)
    print(f"  wrote {path}")


def main():
    print("Generating PWA icons...")
    save(render(192), "pwa-192.png")
    save(render(512), "pwa-512.png")
    save(render(512, maskable=True), "pwa-512-maskable.png")
    save(render(180), "apple-touch-icon.png")
    print("Done.")


if __name__ == "__main__":
    main()
