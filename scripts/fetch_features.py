#!/usr/bin/env python3
"""Fetch landmark features around each resort from Overture Maps (OSM-derived), on AWS S3.

Writes site/data/features/<id>.json, with coordinates as whole metres east/north of an origin:
  {"o": [lon0, lat0, mPerDegLon, mPerDegLat],
   "b": [[h, x1, y1, x2, y2, ...], ...],   buildings: height (m) and outer ring
   "p": [[x1, y1, ...], ...],              parking lots (outer rings)
   "r": {"major": [...], "minor": [...], "service": [...]}}   road centrelines (flat x,y lists)

The area is the resort's terrain window (data/resorts/<id>.json "terrain").
For very large windows, features are kept only within ~2 km of a run or lift.
"""
import json, math, os, sys, time, concurrent.futures as cf
import pyarrow.dataset as ds, pyarrow.fs as fs, pyarrow.compute as pc
import shapely

SITE = os.path.join(os.path.dirname(__file__), '..', 'docs')
REL = os.environ.get('OVERTURE_RELEASE', '2026-11-18.0')
ROOT = f'overturemaps-us-west-2/release/{REL}'
proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
s3 = fs.S3FileSystem(anonymous=True, region='us-west-2', **({'proxy_options': proxy} if proxy else {}))
DATASETS = {k: ds.dataset(f'{ROOT}/{p}', filesystem=s3, format='parquet') for k, p in {
    'building': 'theme=buildings/type=building',
    'segment': 'theme=transportation/type=segment',
    'infra': 'theme=base/type=infrastructure',
}.items()}
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
MINOR = {'residential', 'unclassified', 'living_street'}
SERVICE = {'service'}


def px2lon(px, z): return px / (256 * 2 ** z) * 360 - 180
def px2lat(py, z): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / (256 * 2 ** z)))))


def bbox_filter(b):
    return (pc.field('bbox', 'xmax') > b[0]) & (pc.field('bbox', 'xmin') < b[2]) & (pc.field('bbox', 'ymax') > b[1]) & (pc.field('bbox', 'ymin') < b[3])




def fetch(rid):
    out_path = os.path.join(SITE, 'data', 'features', rid + '.json')
    if os.path.exists(out_path):
        return rid, 'cached'
    d = json.load(open(os.path.join(SITE, 'data', 'resorts', rid + '.json')))
    t = d.get('win') or d['terrain']; z = t['z']; c = t['crop']
    b = (px2lon(c[0], z), px2lat(c[3], z), px2lon(c[2], z), px2lat(c[1], z))
    lat0 = (b[1] + b[3]) / 2
    span_km = max((b[2] - b[0]) * 111.32 * math.cos(math.radians(lat0)), (b[3] - b[1]) * 110.57)
    near = None
    if True:  # keep only what's within ~2 km of the ski terrain
        cell = 0.02  # ~2 km
        near = set()
        def add(cs):
            if isinstance(cs[0], (int, float)):
                gx, gy = int(cs[0] // cell), int(cs[1] // (cell * 0.7))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        near.add((gx + dx, gy + dy))
            else:
                for x in cs: add(x)
        for f in d['runs'] + d['lifts']: add(f['c'])
    def keep(x, y):
        return near is None or (int(x // 0.02), int(y // 0.014)) in near

    kx = 111319.49 * math.cos(math.radians(lat0)); ky = 111319.49
    ORIGIN = (round((b[0] + b[2]) / 2, 5), round(lat0, 5), round(kx, 2), ky)
    def ring(coords):
        lon0, lat0_, kx_, ky_ = ORIGIN
        out = []
        for x, y in coords:
            out += [round((x - lon0) * kx_), round((y - lat0_) * ky_)]
        return out
    f = bbox_filter(b)
    res = {'o': list(ORIGIN), 'b': [], 'p': [], 'r': {'major': [], 'minor': [], 'service': []}}
    tb = DATASETS['building'].to_table(filter=f, columns=['geometry', 'height', 'num_floors', 'bbox'])
    geoms = shapely.from_wkb(tb['geometry'].to_numpy(zero_copy_only=False))
    hs, fl = tb['height'].to_pylist(), tb['num_floors'].to_pylist()
    for g, h, n in zip(geoms, hs, fl):
        if g is None or g.is_empty: continue
        polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
        for p in polys:
            cx, cy = p.centroid.x, p.centroid.y
            if not keep(cx, cy): continue
            height = h or (n * 3.2 if n else 7.0)
            ext = shapely.simplify(p, 0.000005).exterior
            res['b'].append([round(min(height, 300), 1)] + ring(ext.coords))
    tb = DATASETS['segment'].to_table(filter=f & (pc.field('subtype') == 'road'), columns=['geometry', 'class'])
    for g, cls in zip(shapely.from_wkb(tb['geometry'].to_numpy(zero_copy_only=False)), tb['class'].to_pylist()):
        k = 'major' if cls in MAJOR else 'minor' if cls in MINOR else 'service' if cls in SERVICE else None
        if not k or g is None: continue
        lines = [g] if g.geom_type == 'LineString' else list(getattr(g, 'geoms', []))
        for ln in lines:
            cs = shapely.simplify(ln, 0.00001).coords
            if (keep(*cs[0]) or keep(*cs[-1])) and len(cs) >= 2:
                res['r'][k].append(ring(cs))
    tb = DATASETS['infra'].to_table(filter=f & (pc.field('class') == 'parking'), columns=['geometry'])
    for g in shapely.from_wkb(tb['geometry'].to_numpy(zero_copy_only=False)):
        if g is None or g.geom_type not in ('Polygon', 'MultiPolygon'): continue
        for p in ([g] if g.geom_type == 'Polygon' else g.geoms):
            if keep(p.centroid.x, p.centroid.y):
                res['p'].append(ring(shapely.simplify(p, 0.000005).exterior.coords))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path + '.tmp', 'w') as fh:
        json.dump(res, fh, separators=(',', ':'))
    os.replace(out_path + '.tmp', out_path)
    return rid, len(res['b']), sum(len(v) for v in res['r'].values()), len(res['p'])


def main():
    ids = sys.argv[1:] or [e['id'] for e in json.load(open(os.path.join(SITE, 'data', 'index.json')))][:int(os.environ.get('TOP_FEATURES', '1000'))]
    with cf.ThreadPoolExecutor(int(os.environ.get('WORKERS', '6'))) as pool:
        futs = {pool.submit(fetch, i): i for i in ids}
        for fu in cf.as_completed(futs):
            try:
                print(*fu.result(), flush=True)
            except Exception as e:
                print(futs[fu], 'ERROR', repr(e)[:200], flush=True)


if __name__ == '__main__':
    main()
