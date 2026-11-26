#!/usr/bin/env python3
"""Build the resort dataset from OpenSkiMap's OSM-derived GeoJSON exports.

Inputs (download first, see README):
  data/raw/ski_areas.geojson, runs.geojson, lifts.geojson
  from https://tiles.openskimap.org/geojson/{ski_areas,runs,lifts}.geojson

Outputs:
  site/data/index.json            list of resorts with summary stats
  site/data/resorts/<id>.json     runs, lifts and boundary for one resort

Selection: operating, named downhill ski areas, ranked by total mapped
downhill run length (km). The top N (default 300) are kept.
"""
import json, math, os, sys, re, unicodedata
sys.path.insert(0, os.path.dirname(__file__))
from bake_terrain import window

RAW = sys.argv[1] if len(sys.argv) > 1 else '/home/user/data/raw'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'docs', 'data')
TOP_N = int(os.environ.get('TOP_N', '300'))
# Stable URL ids: OpenSkiMap ski-area id -> our slug, kept across rebuilds so /<id> links never move.
# Every slug ever handed out stays reserved, so a resort that disappears never has its id reused.
IDS = os.environ.get('IDS', os.path.join(os.path.dirname(__file__), 'ids.json'))

# Well-known resorts that are small by mapped run length but people expect to find.
# Matched as case-insensitive substrings of the OpenSkiMap name; the largest match is used.
EXTRAS = [
    'hakuba happo one', 'hakuba 47', 'hakuba iwatake', 'les grands montets', 'portillo', 'the remarkables',
    'coronet peak', 'cardrona', 'treble cone', 'gulmarg', 'yongpyong', 'mount buller', 'falls creek',
    'las leñas', 'kasprowy wierch', 'gudauri', 'shymbulak', 'furano ski resort', 'rusutsu', 'kiroro',
    'shiga kogen yakebitaiyama', 'myoko suginohara', 'zao onsen', 'alyeska', 'crystal mountain',
    'solitude mountain', 'sugar bowl', 'kirkwood', 'gemsstock', 'mürren/schilthorn', 'gstaad - saanen',
    'bansko', 'cortina tofane', 'bormio ski', 'rukatunturi', 'hemsedal skisenter', 'ski geilo',
    'jakobshorn', 'wanlong paradise', 'dizin', 'mzaar', 'mount hermon', 'chapelco', 'cerro castor',
    'corralco', 'nevados de chillán', 'alpensia', 'nozawa onsen', 'big white', 'mt. bachelor',
]


def run_km(p):
    try:
        return sum(v.get('lengthInKm', 0) for v in p['statistics']['runs']['byActivity']['downhill']['byDifficulty'].values())
    except (KeyError, TypeError):
        return 0.0


def clean_name(n):
    # OpenSkiMap joins alternative names with ", " (e.g. "Kronplatz - Plan de Corones, Kronplatz, Plan de Corones").
    parts = [s.strip() for s in n.split(',')]
    if len(parts) > 1:
        # Prefer the first latin-script part when the first is non-latin (e.g. "Роза Хутор, Rosa Khutor").
        def latin(s):
            return all(ord(c) < 0x250 or not c.isalpha() for c in s)
        if not latin(parts[0]):
            lat = [p for p in parts if latin(p)]
            if lat:
                return f"{lat[0]} ({parts[0]})"
        return parts[0]
    return n


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
    short = re.sub(r'-(ski-)?(resort|area|centre|center)$', '', s)  # sugar-bowl-resort -> sugar-bowl
    return (short if len(short) >= 3 else s) or 'resort'


def rnd(coords):
    """Round nested coordinate arrays to ~1 m precision and drop z."""
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 5), round(coords[1], 5)]
    return [rnd(c) for c in coords]


def iter_features(path):
    with open(path) as f:
        for line in f:
            line = line.strip().rstrip(',')
            if not line.startswith('{"type":"Feature"'):
                continue
            yield json.loads(line)


class BoundaryFix:
    """Correct OpenSkiMap's lift/run -> ski area assignment using the ski area boundaries.

    OpenSkiMap only puts a lift or run in a landuse=winter_sports area if the boundary covers 100% of
    it. One that pokes out by a few metres (e.g. a bottom station in the village) is then picked up by
    a neighbouring ski area instead: Palisades' Gold Coast Funitel and Red Dog went to Alpine Meadows,
    Ylläs lifts to Levi.

    Rule here, only for features OpenSkiMap assigned somewhere (unassigned ones are mostly backcountry
    runs and stay out): if a resort we show has a boundary holding at least half of the feature and it
    isn't assigned there, add it, and drop any assigned area whose boundary holds less than a tenth of
    it. Areas without a boundary (points) are never dropped. When a dropped area and an added one look
    like the same resort under two names (OpenSkiMap keeps some duplicates, e.g. "Hemsedal" and
    "Hemsedal skisenter"), the assignment is left alone, so a resort page never loses its lifts to its
    own duplicate.
    """
    MAJORITY, STRAY = 0.5, 0.1

    GENERIC = {'ski', 'skisenter', 'alpinsenter', 'skiarena', 'skiareal', 'skipark', 'skicentrum', 'resort',
               'area', 'station', 'centre', 'center', 'centrum', 'the', 'mount', 'mt', 'stacja', 'narciarska',
               'wintersportgebiet', 'skigebiet', 'domaine', 'hiihtokeskus', 'laskettelukeskus'}

    def __init__(self, areas, shown):
        try:
            from shapely.geometry import shape
            from shapely.strtree import STRtree
            from shapely.validation import make_valid
        except ImportError:
            print('shapely missing: keeping OpenSkiMap ski area assignment as is')
            self.tree = None
            return
        self.shape = shape
        self.poly, self.name = {}, {}
        for a in areas:
            self.name[a['properties']['id']] = a['properties'].get('name') or ''
            g = a['geometry']
            if g and g['type'] in ('Polygon', 'MultiPolygon'):
                try:
                    self.poly[a['properties']['id']] = make_valid(shape(g))
                except Exception:
                    pass
        self.shown = [i for i in self.poly if i in shown]
        self.tree = STRtree([self.poly[i] for i in self.shown])
        self.moves = []

    def words(self, aid):
        n = self.name.get(aid, '').split(',')[0].lower().translate(str.maketrans({'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ł': 'l'}))
        n = unicodedata.normalize('NFKD', n).encode('ascii', 'ignore').decode()
        return [w for w in re.split(r'[^a-z0-9]+', n) if len(w) > 1 and w not in self.GENERIC]

    def same_resort(self, a, b):
        # Same resort if every word of the shorter name starts (or is the start of) a word in the other.
        wa, wb = sorted((self.words(a), self.words(b)), key=len)
        if not wa:
            return True
        pre = lambda x, y: min(len(x), len(y)) >= 4 and (x.startswith(y) or y.startswith(x))
        return all(any(w == v or pre(w, v) for v in wb) for w in wa)

    def frac(self, g, aid):
        try:
            return g.intersection(self.poly[aid]).length / g.length
        except Exception:
            return 0.0

    def areas_for(self, feat, assigned):
        # Features OpenSkiMap left out of every ski area (mostly backcountry runs) stay out.
        if self.tree is None or not assigned or not feat.get('geometry'):
            return assigned
        try:
            g = self.shape(feat['geometry'])
        except Exception:
            return assigned
        if g.geom_type not in ('LineString', 'MultiLineString'):
            g = g.boundary if g.geom_type in ('Polygon', 'MultiPolygon') else g
        if g.length == 0:
            return assigned
        add = [self.shown[k] for k in self.tree.query(g)
               if self.shown[k] not in assigned and self.frac(g, self.shown[k]) >= self.MAJORITY]
        if not add:
            return assigned
        keep = [a for a in assigned if a not in self.poly or self.frac(g, a) >= self.STRAY]
        if any(self.same_resort(d, a) for d in assigned if d not in keep for a in add):
            return assigned
        self.moves.append((feat['properties'].get('name'), sorted(set(assigned) - set(keep)), add))
        return keep + add


def main():
    areas = json.load(open(os.path.join(RAW, 'ski_areas.geojson')))['features']
    cands = []
    for a in areas:
        p = a['properties']
        if p.get('status') != 'operating' or not p.get('name') or 'downhill' not in (p.get('activities') or []):
            continue
        km = run_km(p)
        if km <= 0:
            continue
        cands.append((km, a))
    cands.sort(key=lambda t: -t[0])

    chosen, seen = [], set()
    for km, a in cands:
        p = a['properties']
        nm = clean_name(p['name'])
        country = (p.get('places') or [{}])[0].get('iso3166_1Alpha2', '')
        key = (nm.lower(), country)
        if key in seen:
            continue
        seen.add(key)
        chosen.append((km, a, nm, country))
        if len(chosen) >= TOP_N:
            break
    for pat in EXTRAS:
        for km, a in cands:
            if pat in a['properties']['name'].lower():
                p = a['properties']
                nm = clean_name(p['name'])
                country = (p.get('places') or [{}])[0].get('iso3166_1Alpha2', '')
                if (nm.lower(), country) not in seen:
                    seen.add((nm.lower(), country))
                    chosen.append((km, a, nm, country))
                break
        else:
            print('extra not found:', pat)
    chosen.sort(key=lambda t: -t[0])

    ids = {a['properties']['id']: i for i, (_, a, _, _) in enumerate(chosen)}
    runs = {i: [] for i in range(len(chosen))}
    lifts = {i: [] for i in range(len(chosen))}

    fix = BoundaryFix(areas, ids)

    def member(feat):
        osm = [s['properties']['id'] for s in feat['properties'].get('skiAreas', [])]
        return [ids[a] for a in fix.areas_for(feat, osm) if a in ids]

    for ft in iter_features(os.path.join(RAW, 'runs.geojson')):
        p = ft['properties']
        if 'downhill' not in (p.get('uses') or []) or p.get('status') not in (None, 'operating'):
            continue
        m = member(ft)
        if not m:
            continue
        g = ft['geometry']
        rec = {'d': p.get('difficulty') or 'unknown', 'n': p.get('name'), 't': g['type'], 'c': rnd(g['coordinates'])}
        for i in m:
            runs[i].append(rec)

    for ft in iter_features(os.path.join(RAW, 'lifts.geojson')):
        p = ft['properties']
        if p.get('status') not in (None, 'operating'):
            continue
        m = member(ft)
        if not m:
            continue
        g = ft['geometry']
        if g['type'] not in ('LineString', 'MultiLineString'):
            continue
        rec = {'k': p.get('liftType') or 'lift', 'n': p.get('name'), 't': g['type'], 'c': rnd(g['coordinates'])}
        occ = p.get('occupancy')
        if occ:
            try: rec['o'] = int(occ)
            except (TypeError, ValueError): pass
        if p.get('bubble'): rec['b'] = 1
        if p.get('heating'): rec['h'] = 1
        if p.get('detachable'): rec['dt'] = 1
        for key, short in (('capacity', 'cap'), ('duration', 'dur')):
            try:
                v = int(float(p.get(key))) if p.get(key) else None
            except (TypeError, ValueError):
                v = None
            if v: rec[short] = v
        if p.get('ref') and not p.get('name'): rec['n'] = p.get('ref')
        for i in m:
            lifts[i].append(rec)

    if getattr(fix, 'moves', None):
        print(f'boundary fix: reassigned {len(fix.moves)} runs/lifts to the ski area whose boundary holds most of them')
    os.makedirs(os.path.join(OUT, 'resorts'), exist_ok=True)
    slugs = assign_slugs(chosen)
    index = []
    for i, (km, a, nm, country) in enumerate(chosen):
        p = a['properties']
        st = p['statistics']
        # bbox from runs + lifts (+ boundary polygon)
        xs, ys = [], []

        def walk(c):
            if isinstance(c[0], (int, float)):
                xs.append(c[0]); ys.append(c[1])
            else:
                for cc in c:
                    walk(cc)
        for r in runs[i] + lifts[i]:
            walk(r['c'])
        boundary = None
        if a['geometry']['type'] in ('Polygon', 'MultiPolygon'):
            boundary = {'t': a['geometry']['type'], 'c': rnd(a['geometry']['coordinates'])}
            walk(boundary['c'])
        if not xs:
            continue
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        s = slugs[p['id']]
        byd = st['runs']['byActivity']['downhill']['byDifficulty']
        diff_km = {k: round(v.get('lengthInKm', 0), 1) for k, v in byd.items()}
        liftcount = sum(v.get('count', 0) for v in (st.get('lifts', {}).get('byType') or {}).values())
        place = p['places'][0]['localized']['en'] if p.get('places') else {}
        entry = {
            'id': s, 'name': nm, 'fullName': p['name'], 'country': country,
            'countryName': place.get('country'), 'region': place.get('region'),
            'rank': i + 1, 'runKm': round(km, 1), 'diffKm': diff_km, 'lifts': liftcount,
            'top': st.get('maxElevation'), 'base': st.get('minElevation'),
            'bbox': [round(v, 5) for v in bbox],
            'center': [round(v, 5) for v in p['viewportHint']['center']] if p.get('viewportHint') else [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2],
            'osm': [s_['id'] for s_ in p.get('sources', []) if s_.get('type') == 'openstreetmap'][:3],
            'website': (p.get('websites') or [None])[0],
            'osk': p['id'],  # OpenSkiMap ski-area id: openskimap.org/?obj=<id>
            'conv': p.get('runConvention') or 'europe',
        }
        index.append(entry)
        z, _, crop = window(entry['bbox'])
        win = {'z': z, 'crop': [round(v, 3) for v in crop]}
        with open(os.path.join(OUT, 'resorts', s + '.json'), 'w') as f:
            json.dump({**entry, 'win': win, 'boundary': boundary, 'runs': runs[i], 'lifts': lifts[i]}, f, separators=(',', ':'), ensure_ascii=False)
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    keep = {e['id'] + '.json' for e in index}
    for fn in os.listdir(os.path.join(OUT, 'resorts')):  # resorts that are gone from OpenSkiMap
        if fn.endswith('.json') and fn not in keep:
            os.remove(os.path.join(OUT, 'resorts', fn))
    print(len(index), 'resorts written')


def assign_slugs(chosen):
    """Give each chosen ski area its id: the one it had before if known, else a fresh unused slug."""
    idmap = json.load(open(IDS)) if os.path.exists(IDS) else {}
    reserved = set(idmap.values())
    out, taken = {}, set()
    for _, a, _, _ in chosen:
        s = idmap.get(a['properties']['id'])
        if s and s not in taken:
            out[a['properties']['id']] = s
            taken.add(s)
    # OpenSkiMap occasionally re-keys an area (e.g. its OSM source changed). Reclaim the old id when
    # an unclaimed one matches by name and country.
    orphans = {}
    for osk, s in idmap.items():
        if s in taken:
            continue
        path = os.path.join(OUT, 'resorts', s + '.json')
        if os.path.exists(path):
            r = json.load(open(path))
            orphans.setdefault((r['name'].lower(), r['country']), s)
    for _, a, nm, country in chosen:
        osk = a['properties']['id']
        if osk in out:
            continue
        s = orphans.pop((nm.lower(), country), None)
        if not s:
            s = slug(nm)
            if s == 'resort':  # name has no latin characters
                s = f"resort-{country.lower()}-{osk[:6]}"
            base, k = s, 1
            while s in taken or s in reserved:
                k += 1
                s = f"{base}-{country.lower()}" if k == 2 else f"{base}-{k}"
        out[osk] = s
        taken.add(s)
        idmap[osk] = s
    with open(IDS, 'w') as f:
        json.dump(dict(sorted(idmap.items())), f, indent=0, ensure_ascii=False)
    return out


if __name__ == '__main__':
    main()
