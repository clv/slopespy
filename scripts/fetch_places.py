#!/usr/bin/env python3
"""Fetch named peaks and settlements around each resort from Overture Maps (OSM-derived), on AWS S3.

Writes docs/data/places/<id>.json:
  {"k": [[name, lon, lat, elevation_m_or_null], ...],          peaks (natural=peak/volcano), highest first
   "v": [[name, lon, lat, rank], ...]}                          places; rank 0 city, 1 town, 2 village, 3 hamlet
The area is the resort's terrain window (data/resorts/<id>.json "win"), the same one the 3D model covers.
"""
import json, math, os, sys, concurrent.futures as cf
import pyarrow.dataset as ds, pyarrow.fs as fs, pyarrow.compute as pc

SITE = os.path.join(os.path.dirname(__file__), '..', 'docs')
OUT = os.path.join(SITE, 'data', 'places')
REL = os.environ.get('OVERTURE_RELEASE', '2026-11-18.0')
ROOT = f'overturemaps-us-west-2/release/{REL}'
proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
s3 = fs.S3FileSystem(anonymous=True, region='us-west-2', **({'proxy_options': proxy} if proxy else {}))
LAND = ds.dataset(f'{ROOT}/theme=base/type=land', filesystem=s3, format='parquet')
DIV = ds.dataset(f'{ROOT}/theme=divisions/type=division', filesystem=s3, format='parquet')
RANK = {'city': 0, 'megacity': 0, 'town': 1, 'village': 2, 'hamlet': 3}
MAX_PEAKS, MAX_PLACES = 60, 60


def px2lon(px, z): return px / (256 * 2 ** z) * 360 - 180
def px2lat(py, z): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / (256 * 2 ** z)))))


def bbox_filter(b):
    return (pc.field('bbox', 'xmax') > b[0]) & (pc.field('bbox', 'xmin') < b[2]) & (pc.field('bbox', 'ymax') > b[1]) & (pc.field('bbox', 'ymin') < b[3])


def name_of(n):
    return (n or {}).get('primary')


def fetch(rid):
    path = os.path.join(OUT, rid + '.json')
    if os.path.exists(path):
        return rid, 'cached'
    d = json.load(open(os.path.join(SITE, 'data', 'resorts', rid + '.json')))
    t = d.get('win') or d['terrain']; z = t['z']; c = t['crop']
    b = (px2lon(c[0], z), px2lat(c[3], z), px2lon(c[2], z), px2lat(c[1], z))
    f = bbox_filter(b)
    peaks = []
    for r in LAND.to_table(filter=f & pc.field('class').isin(['peak', 'volcano']), columns=['names', 'elevation', 'bbox']).to_pylist():
        nm = name_of(r['names'])
        if not nm: continue
        bb = r['bbox']
        peaks.append([nm, round(bb['xmin'], 5), round(bb['ymin'], 5), round(r['elevation']) if r['elevation'] is not None else None])
    peaks.sort(key=lambda p: -(p[3] or 0))
    places = []
    for r in DIV.to_table(filter=f & (pc.field('subtype') == 'locality'), columns=['names', 'class', 'population', 'bbox']).to_pylist():
        nm, k = name_of(r['names']), RANK.get(r['class'])
        if not nm or k is None: continue
        bb = r['bbox']
        places.append([nm, round(bb['xmin'], 5), round(bb['ymin'], 5), k, r['population'] or 0])
    places.sort(key=lambda p: (p[3], -p[4]))
    out = {'k': peaks[:MAX_PEAKS], 'v': [p[:4] for p in places[:MAX_PLACES]]}
    with open(path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
    return rid, f"{len(out['k'])} peaks, {len(out['v'])} places"


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    ids = sys.argv[1:] or [e['id'] for e in json.load(open(os.path.join(SITE, 'data', 'index.json')))]
    done = 0
    with cf.ThreadPoolExecutor(int(os.environ.get('WORKERS', '12'))) as ex:
        for fut in cf.as_completed([ex.submit(fetch, i) for i in ids]):
            try:
                rid, msg = fut.result()
            except Exception as e:
                rid, msg = '?', f'error {e}'
            done += 1
            if done % 100 == 0 or 'error' in msg:
                print(done, rid, msg, flush=True)
    print('done', done)
