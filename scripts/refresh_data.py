#!/usr/bin/env python3
"""Refresh the site's resort data from the latest OpenSkiMap export, rebaking only what changed.

  python3 scripts/refresh_data.py [--raw DIR] [--summary FILE]

1. Download ski_areas / runs / lifts GeoJSON from OpenSkiMap (into --raw, default data/raw).
2. Rebuild docs/data/index.json and resorts/*.json (ids stay stable via scripts/ids.json).
3. For new resorts, and resorts whose terrain window moved, (re)bake land cover and fetch
   peak/village names and landmark features from the latest Overture release.
   Removed resorts lose their files.
4. Regenerate the per-resort pages, sitemap and directory.
5. Check the result looks sane, and write a Markdown summary of what changed.

Exits non-zero (leaving the working tree for inspection) if a sanity check fails.
"""
import argparse, json, os, re, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOCS = os.path.join(ROOT, 'docs')
DATA = os.path.join(DOCS, 'data')
OSM = 'https://tiles.openskimap.org/geojson/{}.geojson'
MUST_HAVE = ['big-sky', 'sugar-bowl', 'dolomiti-superski', 'whistler-blackcomb']
MAX_FILES = 19500        # Cloudflare Pages allows 20,000 files per deployment
MIN_KEEP = 0.95          # refuse if more than 5% of resorts vanish at once
UA = {'User-Agent': 'slopespy-data-refresh (+https://slopespy.com)'}  # OpenSkiMap 403s Python's default


def get(url, timeout):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


def run(*cmd, **env):
    print('+', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT, env={**os.environ, **env})


def download(raw):
    os.makedirs(raw, exist_ok=True)
    for name in ('ski_areas', 'runs', 'lifts'):
        dst = os.path.join(raw, name + '.geojson')
        print('download', OSM.format(name), flush=True)
        with get(OSM.format(name), 600) as r:
            modified = r.headers.get('Last-Modified')
            with open(dst + '.tmp', 'wb') as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
        os.replace(dst + '.tmp', dst)
    return modified


def latest_overture():
    with get('https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/', 60) as r:
        rel = re.findall(r'<Prefix>release/([^<]+)/</Prefix>', r.read().decode())
    return max(rel)


def snapshot():
    """id -> (raw text of resorts/<id>.json, its terrain window)."""
    out = {}
    d = os.path.join(DATA, 'resorts')
    for fn in os.listdir(d):
        if fn.endswith('.json'):
            txt = open(os.path.join(d, fn)).read()
            out[fn[:-5]] = (txt, json.loads(txt)['win'])
    return out


def drop(rid, kinds):
    for kind, ext in kinds:
        p = os.path.join(DATA, kind, rid + ext)
        if os.path.exists(p):
            os.remove(p)


DERIVED = [('landcover', '.png'), ('places', '.json'), ('features', '.json')]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default=os.path.join(ROOT, 'data', 'raw'))
    ap.add_argument('--summary', default=None)
    ap.add_argument('--no-download', action='store_true', help='reuse files already in --raw')
    a = ap.parse_args()

    modified = None if a.no_download else download(a.raw)
    before = snapshot()
    old_index = {e['id']: e for e in json.load(open(os.path.join(DATA, 'index.json')))}

    run(sys.executable, os.path.join(HERE, 'build_data.py'), a.raw, DATA, TOP_N='100000')
    run(sys.executable, os.path.join(HERE, 'enrich_index.py'))
    after = snapshot()
    index = json.load(open(os.path.join(DATA, 'index.json')))

    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(i for i in set(after) & set(before) if after[i][0] != before[i][0])
    moved = [i for i in changed if after[i][1] != before[i][1]]   # terrain window changed

    for rid in removed:
        drop(rid, DERIVED)
    for rid in moved:
        drop(rid, DERIVED)

    redo = added + moved
    if redo:
        rel = latest_overture()
        print('Overture release', rel, '-', len(redo), 'resorts to (re)bake', flush=True)
        run(sys.executable, os.path.join(HERE, 'bake_landcover.py'), *redo)
        run(sys.executable, os.path.join(HERE, 'fetch_places.py'), *redo, OVERTURE_RELEASE=rel)
        top = {e['id'] for e in index[:int(os.environ.get('TOP_FEATURES', '1000'))]}
        feat = [i for i in redo if i in top]
        if feat:
            run(sys.executable, os.path.join(HERE, 'fetch_features.py'), *feat, OVERTURE_RELEASE=rel)
    run(sys.executable, os.path.join(HERE, 'build_pages.py'))

    # sanity checks
    problems = []
    ids = {e['id'] for e in index}
    if len(index) < MIN_KEEP * len(old_index):
        problems.append(f'resort count fell from {len(old_index)} to {len(index)}')
    problems += [f'{m} is missing' for m in MUST_HAVE if m in old_index and m not in ids]
    nfiles = sum(len(f) for _, _, f in os.walk(DOCS))
    if nfiles > MAX_FILES:
        problems.append(f'{nfiles} files in docs/, over the {MAX_FILES} limit')
    missing_lc = [i for i in ids if not os.path.exists(os.path.join(DATA, 'landcover', i + '.png'))]
    if len(missing_lc) > 20:
        problems.append(f'{len(missing_lc)} resorts have no land cover')

    def names(lst):
        src = {**old_index, **{e['id']: e for e in index}}
        s = ', '.join(src[i]['name'] for i in lst[:15])
        return s + (f' and {len(lst) - 15} more' if len(lst) > 15 else '')

    lines = [f'OpenSkiMap export of {modified}' if modified else 'OpenSkiMap export (local files)', '',
             f'- {len(index)} resorts ({len(index) - len(old_index):+d})',
             f'- {len(changed)} updated (runs, lifts or stats), {len(moved)} of them with a new terrain window']
    if added:
        lines.append(f'- Added {len(added)}: {names(added)}')
    if removed:
        lines.append(f'- Removed {len(removed)}: {names(removed)}')
    if problems:
        lines += ['', 'Sanity checks FAILED:'] + [f'- {p}' for p in problems]
    text = '\n'.join(lines) + '\n'
    print(text)
    if a.summary:
        open(a.summary, 'w').write(text)
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
