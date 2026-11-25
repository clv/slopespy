#!/usr/bin/env python3
"""Make an Artifact-compatible entry page (artifact.html) from site/index.html.

The Artifact host wraps the page in its own <html>/<head>/<body>, so strip those tags.
"""
import os, re
SITE = os.path.join(os.path.dirname(__file__), '..', 'docs')
html = open(os.path.join(SITE, 'index.html')).read()
html = re.sub(r'<!doctype html>\s*|</?html[^>]*>\s*|</?head>\s*|</?body>\s*', '', html, flags=re.I)
html = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', '', html)
html = html.replace('<link rel="stylesheet" href="style.css">',
                    '<style>\n' + open(os.path.join(SITE, 'style.css')).read() + ':root{color-scheme:dark}\n</style>')
CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/'
html = re.sub(r'<script type="importmap">.*?</script>', '<script type="importmap">\n{ "imports": { "three": "' + CDN + 'build/three.module.min.js", "three/addons/": "' + CDN + 'examples/jsm/" } }\n</script>', html, flags=re.S)
html = html.replace('<script type="module" src="app.js"></script>', '<script type="module">\n' + open(os.path.join(SITE, 'app.js')).read() + '\n</script>')
html = html.replace('<script type="module">', '<script>window.RESORT_DIR = "data/r";</script>\n<script type="module">', 1)
# single-file bundles: resort JSON with the terrain PNG embedded
import json, base64
os.makedirs(os.path.join(SITE, 'data', 'r'), exist_ok=True)
for f in os.listdir(os.path.join(SITE, 'data', 'resorts')):
    d = json.load(open(os.path.join(SITE, 'data', 'resorts', f)))
    png = os.path.join(SITE, 'data', 'terrain', f[:-5] + '.png')
    if d.get('terrain') and os.path.exists(png):
        d['terrain']['png'] = base64.b64encode(open(png, 'rb').read()).decode()
    json.dump(d, open(os.path.join(SITE, 'data', 'r', f), 'w'), separators=(',', ':'), ensure_ascii=False)
open(os.path.join(SITE, 'artifact.html'), 'w').write(html)
print('wrote artifact.html', len(html))
