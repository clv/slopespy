#!/usr/bin/env python3
"""Bake an ESA WorldCover 2021 (10 m) land-cover raster for each resort's terrain window.

Output: site/data/landcover/<id>.png, 8-bit greyscale holding the WorldCover class code
(10 tree, 20 shrub, 30 grass, 40 crop, 50 built-up, 60 bare, 70 snow/ice, 80 water,
90 wetland, 95 mangrove, 100 moss/lichen, 0 no data). Rows/columns are laid out in the
same Web-Mercator pixel window as the terrain mesh, so it maps straight onto its UVs.
Source: s3://esa-worldcover (CC BY 4.0, © ESA WorldCover project 2021).
"""
import json, math, os, sys, concurrent.futures as cf
import numpy as np
from PIL import Image

SITE = os.path.join(os.path.dirname(__file__), '..', 'docs')
MAXPX = int(os.environ.get('LC_MAX', '1024'))
URL = '/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif'
os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('CPL_VSIL_CURL_ALLOWED_EXTENSIONS', '.tif')


def px2lon(px, z): return px / (256 * 2 ** z) * 360 - 180
def px2lat(py, z): return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py / (256 * 2 ** z)))))


def tile_name(lat, lon):
    la, lo = int(math.floor(lat / 3) * 3), int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def bake(rid):
    import rasterio
    from rasterio.windows import from_bounds
    out = os.path.join(SITE, 'data', 'landcover', rid + '.png')
    if os.path.exists(out):
        return rid, 'cached'
    d = json.load(open(os.path.join(SITE, 'data', 'resorts', rid + '.json')))
    z, c = d['win']['z'], d['win']['crop']
    mpp = 40075016 * math.cos(math.radians(d['center'][1])) / (256 * 2 ** z)
    span = max(c[2] - c[0], c[3] - c[1])
    n = int(min(MAXPX, max(128, span * mpp / 10)))
    w = max(2, round(n * (c[2] - c[0]) / span)); h = max(2, round(n * (c[3] - c[1]) / span))
    lons = px2lon(c[0] + (np.arange(w) + 0.5) * (c[2] - c[0]) / w, z)
    lats = px2lat(c[1] + (np.arange(h) + 0.5) * (c[3] - c[1]) / h, z)
    LON, LAT = np.meshgrid(lons, lats)
    res = np.zeros((h, w), np.uint8)
    tiles = {}
    for la in {math.floor(v / 3) * 3 for v in (lats.min(), lats.max())} | {math.floor(lats.mean() / 3) * 3}:
        for lo in {math.floor(v / 3) * 3 for v in (lons.min(), lons.max())}:
            tiles[tile_name(la + 0.1, lo + 0.1)] = (la, lo)
    for t, (la, lo) in tiles.items():
        m = (LAT >= la) & (LAT < la + 3) & (LON >= lo) & (LON < lo + 3)
        if not m.any():
            continue
        try:
            with rasterio.open(URL.format(t=t)) as src:
                b = (LON[m].min() - 0.001, LAT[m].min() - 0.001, LON[m].max() + 0.001, LAT[m].max() + 0.001)
                win = from_bounds(*b, src.transform).round_offsets().round_lengths()
                a = src.read(1, window=win, boundless=True, fill_value=0)
                tr = src.window_transform(win)
                cols = ((LON[m] - tr.c) / tr.a).astype(int).clip(0, a.shape[1] - 1)
                rows = ((LAT[m] - tr.f) / tr.e).astype(int).clip(0, a.shape[0] - 1)
                res[m] = a[rows, cols]
        except Exception as e:  # ocean tiles don't exist
            if 'No such file' not in str(e) and '404' not in str(e) and 'not recognized' not in str(e):
                raise
    os.makedirs(os.path.dirname(out), exist_ok=True)
    Image.fromarray(res, 'L').save(out + '.tmp.png', optimize=True)
    os.replace(out + '.tmp.png', out)
    return rid, w, h, int((res == 10).mean() * 100)


def main():
    ids = sys.argv[1:] or [e['id'] for e in json.load(open(os.path.join(SITE, 'data', 'index.json')))]
    with cf.ProcessPoolExecutor(int(os.environ.get('WORKERS', '6'))) as pool:
        futs = {pool.submit(bake, i): i for i in ids}
        for fu in cf.as_completed(futs):
            try:
                print(*fu.result(), flush=True)
            except Exception as e:
                print(futs[fu], 'ERROR', repr(e)[:200], flush=True)


if __name__ == '__main__':
    main()
