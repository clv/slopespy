#!/usr/bin/env python3
"""Generate one static page per resort (docs/<id>.html), the resort directory, sitemap and robots.txt.

Each resort page is docs/index.html with its own title, description and canonical URL, plus a short
crawlable section (inside the About dialog) linking to nearby resorts and to every resort in the country.
The app reads the first resort from the path and the second from the fragment: /sugar-bowl#palisades.

Run after build_data.py / enrich_index.py, and again whenever docs/index.html changes.
"""
import html, json, math, os, re
from collections import defaultdict

SITE = 'https://slopespy.com'
DOCS = os.path.join(os.path.dirname(__file__), '..', 'docs')
index = json.load(open(os.path.join(DOCS, 'data', 'index.json')))
tpl = open(os.path.join(DOCS, 'index.html')).read()
esc = lambda s: html.escape(str(s or ''), quote=True)
fmt = lambda n: f'{round(n):,}'
CONT_ORDER = ['Europe', 'North America', 'Asia', 'Oceania', 'South America', 'Africa', 'Other']

# drop pages from an earlier run whose resort no longer exists
ids = {e['id'] for e in index}
for fn in os.listdir(DOCS):
    if fn.endswith('.html') and fn not in ('index.html', 'resorts.html') and fn[:-5] not in ids:
        os.remove(os.path.join(DOCS, fn))

def centre(e):
    b = e['bbox']
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

def dist_km(p, q):
    la1, la2 = math.radians(p[1]), math.radians(q[1])
    dl = math.radians(q[0] - p[0])
    return 6371 * math.acos(max(-1, min(1, math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(dl))))

by_country = defaultdict(list)
for e in index:
    by_country[e.get('countryName') or e['country']].append(e)
for v in by_country.values():
    v.sort(key=lambda e: e['name'].lower())

# coarse grid for nearest-neighbour lookups
grid = defaultdict(list)
for e in index:
    c = centre(e); e['_c'] = c
    grid[(int(c[0] // 2), int(c[1] // 2))].append(e)

def nearest(e, n=12):
    gx, gy = int(e['_c'][0] // 2), int(e['_c'][1] // 2)
    cand = []
    for r in range(0, 6):
        cand = [o for dx in range(-r - 1, r + 2) for dy in range(-r - 1, r + 2) for o in grid[(gx + dx, gy + dy)] if o is not e]
        if len(cand) >= n * 2:
            break
    return sorted(cand, key=lambda o: dist_km(e['_c'], o['_c']))[:n]

def sub(text, start, end, new):
    i, j = text.index(start), text.index(end) + len(end)
    return text[:i] + new + text[j:]

def describe(e):
    bits = [f"{fmt(e['runKm'])} km of mapped runs"] if e.get('runKm') else []
    if e.get('lifts'): bits.append(f"{e['lifts']} lifts")
    if e.get('vert'): bits.append(f"{fmt(e['vert'])} m vertical")
    where = ', '.join(x for x in (e.get('region'), e.get('countryName')) if x)
    return where, bits

def page(e):
    name, where = e['name'], describe(e)[0]
    _, bits = describe(e)
    title = f'{name} in 3D · compare with any ski resort · Slope Spy'
    desc = (f"{name} ({where}) as a scale-correct 3D model: " + ', '.join(bits) +
            '. Compare it side by side with any of 4,000+ ski resorts.')
    url = f"{SITE}/{e['id']}"
    seo = (f'<!--seo-->\n<title>{esc(title)}</title>\n<meta name="description" content="{esc(desc)}">\n'
           f'<link rel="canonical" href="{url}">\n<meta property="og:title" content="{esc(name)} · Slope Spy">\n'
           f'<meta property="og:url" content="{url}">\n<meta property="og:description" content="{esc(desc)}">\n<!--/seo-->')
    near = nearest(e)
    country = e.get('countryName') or e['country']
    others = [o for o in by_country[country] if o is not e]
    body = [f'<!--resort--><h3>{esc(name)}</h3>',
            f'<p class="resort-facts">{esc(where)}. ' + esc(', '.join(bits)) + '.</p>',
            f'<h3>Compare {esc(name)} with</h3><ul class="links">' +
            ''.join(f'<li><a href="#{o["id"]}">{esc(o["name"])}</a></li>' for o in near) + '</ul>']
    if others:
        body.append(f'<h3>Ski resorts in {esc(country)}</h3><ul class="links">' +
                    ''.join(f'<li><a href="{o["id"]}">{esc(o["name"])}</a></li>' for o in others) + '</ul>')
    body.append('<p><a href="resorts">Browse all ski resorts</a></p><!--/resort-->')
    out = sub(tpl, '<!--seo-->', '<!--/seo-->', seo)
    return sub(out, '<!--resort-->', '<!--/resort-->', '\n      '.join(body))

for e in index:
    with open(os.path.join(DOCS, e['id'] + '.html'), 'w') as f:
        f.write(page(e))

# directory of every resort, grouped by continent and country
groups = defaultdict(lambda: defaultdict(list))
for e in index:
    groups[e.get('cont', 'Other')][e.get('countryName') or e['country']].append(e)
parts = []
for cont in sorted(groups, key=lambda c: CONT_ORDER.index(c) if c in CONT_ORDER else 99):
    parts.append(f'<h2>{esc(cont)}</h2>')
    for country in sorted(groups[cont]):
        items = sorted(groups[cont][country], key=lambda e: e['name'].lower())
        parts.append(f'<h3>{esc(country)} <small>{len(items)}</small></h3><ul>' +
                     ''.join(f'<li><a href="{e["id"]}">{esc(e["name"])}</a></li>' for e in items) + '</ul>')
directory = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All {len(index):,} ski resorts · Slope Spy</title>
<meta name="description" content="Every ski resort on Slope Spy, by continent and country. Open any one as a scale-correct 3D model and compare it side by side with another.">
<link rel="canonical" href="{SITE}/resorts">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>
  :root {{ color-scheme: dark; --fg: #e8edf2; --muted: #93a1ae; --a: #4fa3ff; --line: #2a333d; }}
  body {{ margin: 0; background: #0f1419; color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }}
  header {{ padding: 12px 16px; border-bottom: 1px solid var(--line); }}
  .brand {{ display: inline-flex; align-items: center; gap: 8px; color: var(--fg); text-decoration: none; font-size: 17px; font-weight: 650; }}
  .brand b {{ color: var(--a); }}
  main {{ max-width: 1100px; margin: 0 auto; padding: 8px 16px 40px; }}
  h1 {{ font-size: 22px; margin: 18px 0 4px; }}
  h2 {{ font-size: 13px; text-transform: uppercase; letter-spacing: .06em; margin: 28px 0 0; padding-bottom: 4px; border-bottom: 1px solid var(--line); }}
  h3 {{ font-size: 14px; margin: 14px 0 4px; }} h3 small {{ color: var(--muted); font-weight: 400; }}
  ul {{ list-style: none; margin: 0; padding: 0; columns: 220px; column-gap: 24px; }}
  li {{ break-inside: avoid; }} a {{ color: var(--a); text-decoration: none; }} a:hover {{ text-decoration: underline; }}
  p {{ color: var(--muted); margin: 0; }}
</style>
</head>
<body>
<header><a class="brand" href="./"><img src="logo.svg" alt="" width="28" height="28"><span>Slope <b>Spy</b></span></a></header>
<main>
<h1>All {len(index):,} ski resorts</h1>
<p>Pick any resort to see it in 3D, then choose a second one to compare it with at the same scale.</p>
{''.join(parts)}
</main>
</body>
</html>
'''
open(os.path.join(DOCS, 'resorts.html'), 'w').write(directory)

urls = [f'{SITE}/', f'{SITE}/resorts'] + [f"{SITE}/{e['id']}" for e in index]
open(os.path.join(DOCS, 'sitemap.xml'), 'w').write(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    ''.join(f'<url><loc>{u}</loc></url>\n' for u in urls) + '</urlset>\n')
open(os.path.join(DOCS, 'robots.txt'), 'w').write(f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n')
sizes = [os.path.getsize(os.path.join(DOCS, e['id'] + '.html')) for e in index]
print(f'{len(index)} resort pages, {sum(sizes) // 1024 // 1024} MB total, largest {max(sizes) // 1024} KB; directory {len(directory) // 1024} KB')
