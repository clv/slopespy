#!/usr/bin/env python3
"""Pre-bake a terrain heightmap per resort so the site needs no runtime tile fetches.

For each resort in site/data/index.json this fetches AWS Terrain Tiles (Terrarium PNG),
stitches them, resamples the padded resort window to a grid of at most GRID samples on
the long side, and writes site/data/terrain/<id>.png (Terrarium-encoded RGB) plus the
grid's placement into the resort JSON ("terrain": {z, crop, w, h}).

The window/zoom logic mirrors loadTerrain() in app.js.
"""
import io, json, math, os, sys, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image

SITE = os.path.join(os.path.dirname(__file__), '..', 'docs')
CACHE = os.environ.get('TILE_CACHE', '/home/user/data/tiles')
GRID = int(os.environ.get('GRID', '640'))
MAX_TILES, MAX_ZOOM = 64, 14
R = 6371008.8
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'


def lon2px(lon, z): return (lon + 180) / 360 * 256 * 2 ** z
def lat2px(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 256 * 2 ** z


def tile(z, x, y):
    p = os.path.join(CACHE, str(z), str(x), f'{y}.png')
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        for attempt in range(4):
            try:
                data = urllib.request.urlopen(URL.format(z=z, x=x, y=y), timeout=60).read()
                break
            except Exception:
                if attempt == 3:
                    raise
        with open(p + '.tmp', 'wb') as f:
            f.write(data)
        os.replace(p + '.tmp', p)
    a = np.asarray(Image.open(p).convert('RGB'), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def window(bbox):
    w, s, e, n = bbox
    lat0 = (s + n) / 2
    mLat = R * math.pi / 180
    mLon = mLat * math.cos(math.radians(lat0))
    pad = max(1200, 0.12 * max((e - w) * mLon, (n - s) * mLat))
    w -= pad / mLon; e += pad / mLon; s -= pad / mLat; n += pad / mLat
    for z in range(MAX_ZOOM, 5, -1):
        tx0, tx1 = int(lon2px(w, z) // 256), int(lon2px(e, z) // 256)
        ty0, ty1 = int(lat2px(n, z) // 256), int(lat2px(s, z) // 256)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES:
            break
    return z, (tx0, tx1, ty0, ty1), (lon2px(w, z), lat2px(n, z), lon2px(e, z), lat2px(s, z))


def bake(entry, pool):
    path = os.path.join(SITE, 'data', 'resorts', entry['id'] + '.json')
    d = json.load(open(path))
    z, (tx0, tx1, ty0, ty1), crop = window(d['bbox'])
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    big = np.zeros((ny * 256, nx * 256))
    jobs = {pool.submit(tile, z, x, y): (x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)}
    for fut in cf.as_completed(jobs):
        x, y = jobs[fut]
        big[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = fut.result()
    px0, py0, px1, py1 = crop
    span = max(px1 - px0, py1 - py0)
    step = max(1.0, span / GRID)
    gw, gh = math.ceil((px1 - px0) / step) + 1, math.ceil((py1 - py0) / step) + 1
    # sample points (global pixel coords) -> local array coords (pixel centres at +0.5)
    gx = np.linspace(px0, px1, gw) - tx0 * 256 - 0.5
    gy = np.linspace(py0, py1, gh) - ty0 * 256 - 0.5
    if step > 1.5:  # box-filter before point sampling to avoid aliasing on big areas
        k = int(round(step))
        pad = np.pad(big, k, mode='edge')
        c = pad.cumsum(0).cumsum(1)
        c = np.pad(c, ((1, 0), (1, 0)))
        h2 = k // 2
        H, W = big.shape
        ys = np.arange(H) + k - h2; xs = np.arange(W) + k - h2
        big = (c[ys[:, None] + k, xs[None, :] + k] - c[ys[:, None], xs[None, :] + k]
               - c[ys[:, None] + k, xs[None, :]] + c[ys[:, None], xs[None, :]]) / (k * k)
    gx = np.clip(gx, 0, big.shape[1] - 1.001); gy = np.clip(gy, 0, big.shape[0] - 1.001)
    x0 = gx.astype(int); y0 = gy.astype(int); fx = gx - x0; fy = gy - y0
    a = big[y0[:, None], x0[None, :]]; b = big[y0[:, None], x0[None, :] + 1]
    c_ = big[y0[:, None] + 1, x0[None, :]]; d_ = big[y0[:, None] + 1, x0[None, :] + 1]
    h = (a * (1 - fx) + b * fx) * (1 - fy[:, None]) + (c_ * (1 - fx) + d_ * fx) * fy[:, None]
    # Terrarium encode, quantised to 1/8 m
    v = np.round((h + 32768) * 4) / 4  # quantised to 0.25 m
    r = np.floor(v / 256); g = np.floor(v - r * 256); bl = np.round((v - r * 256 - g) * 256)
    img = np.stack([r, g, bl], -1).clip(0, 255).astype(np.uint8)
    os.makedirs(os.path.join(SITE, 'data', 'terrain'), exist_ok=True)
    Image.fromarray(img, 'RGB').save(os.path.join(SITE, 'data', 'terrain', entry['id'] + '.png'), optimize=True)
    d['terrain'] = {'z': z, 'crop': [round(v, 3) for v in crop], 'w': gw, 'h': gh}
    with open(path, 'w') as f:
        json.dump(d, f, separators=(',', ':'), ensure_ascii=False)
    return entry['id'], z, gw, gh, nx * ny


def main():
    index = json.load(open(os.path.join(SITE, 'data', 'index.json')))
    only = set(sys.argv[1:])
    with cf.ThreadPoolExecutor(24) as pool:
        for e in index:
            if only and e['id'] not in only:
                continue
            print(*bake(e, pool), flush=True)


if __name__ == '__main__':
    main()
