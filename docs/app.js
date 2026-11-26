import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// ---------- constants ----------
const RESORT_DIR = window.RESORT_DIR || 'data/resorts'; // the Artifact build uses single-file bundles in data/r
const EARTH_R = 6371008.8;               // mean Earth radius (m), used for local metric coordinates
const DEG = Math.PI / 180;
// Terrain tiles come from the public AWS bucket, which sends no cache headers, so we keep our own
// copy in the browser's Cache Storage: repeat visits load tiles locally instead of refetching them.
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TILE_CACHE = 'terrain-v1', TILE_CACHE_MAX = 4000;   // about 300-400 MB at most
let tileCache$ = null, tilePuts = 0;
async function fetchTileResponse(z, x, y) {
  const url = TILE_URL(z, x, y);
  // Cache Storage can be missing or blocked (private windows, some browsers): then just fetch
  tileCache$ ??= (self.caches ? caches.open(TILE_CACHE) : Promise.reject()).catch(() => null);
  const cache = await tileCache$;
  const hit = cache && await cache.match(url).catch(() => null);
  if (hit) return hit;
  const res = await fetch(url, { mode: 'cors' });
  if (res.ok && cache) {
    cache.put(url, res.clone()).catch(() => {});
    if (++tilePuts % 200 === 0) trimTileCache(cache).catch(() => {});
  }
  return res;
}
async function trimTileCache(cache) {  // drop the oldest tiles once the cache gets big
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - TILE_CACHE_MAX))) await cache.delete(k);
}
const MAX_TILES = 64;                     // per resort; picks the highest zoom that fits
const MAX_ZOOM = 14;                      // ~7-10 m/pixel at ski-resort latitudes
const MAX_SEGMENTS = (matchMedia('(pointer: coarse)').matches || innerWidth < 800) ? 420 : 768; // mesh resolution cap per side
const SIDE_COLORS = ['#4fa3ff', '#ff8a3d'];
const DIFF_COLORS = { green: '#2fa354', blue: '#2f6fd6', red: '#d93a2f', black: '#15181c', orange: '#f08c1a', grey: '#7d8790' };
const CONVENTIONS = {
  europe:        { novice: 'green', easy: 'blue',  intermediate: 'red',  advanced: 'black', expert: 'black' },
  north_america: { novice: 'green', easy: 'green', intermediate: 'blue', advanced: 'black', expert: 'black' },
  japan:         { novice: 'green', easy: 'green', intermediate: 'red',  advanced: 'black', expert: 'black' },
};
const LIFT_COLOR = '#ffd23f';
const SMALL_SCREEN = matchMedia('(pointer: coarse)').matches || innerWidth < 800;
const TEX_SIZE = SMALL_SCREEN ? 2048 : 4096;       // ground texture width (land cover + roads + parking)
const MAX_TREES = SMALL_SCREEN ? 30000 : 120000;   // per side
const BOUNDARY_COLOR = '#c27ff0';

// ---------- web mercator helpers ----------
const worldPx = z => 256 * 2 ** z;
const lon2px = (lon, z) => (lon + 180) / 360 * worldPx(z);
const lat2px = (lat, z) => { const s = Math.sin(lat * DEG); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z); };
const px2lon = (px, z) => px / worldPx(z) * 360 - 180;
const px2lat = (py, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / worldPx(z)))) / DEG;

// ---------- DOM ----------
const $ = (s, el = document) => el.querySelector(s);
const canvas = $('#c');
const stage = $('#stage');
const panels = [...document.querySelectorAll('.panel')];

// ---------- renderer / camera ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setScissorTest(true);
const camera = new THREE.PerspectiveCamera(40, 1, 10, 1e6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.addEventListener('change', requestRender);

const settings = { mode: 'aligned', pairMode: 'aligned', exag: 2, absElev: false, runs: true, lifts: true, labels: true, trees: true, town: true, grid: true, view: '3d' };
const lineMaterials = new Set();
const gridUniform = { value: 1 };

function makeSide(i) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0f1419');
  scene.add(new THREE.HemisphereLight('#e6f0ff', '#4a4a40', 1.1));
  const sun = new THREE.DirectionalLight('#ffffff', 2.4);
  sun.position.set(-1, 1.1, -0.9); // light from the north-west, like a classic hillshade
  scene.add(sun);
  const root = new THREE.Group();
  scene.add(root);
  const flat = new THREE.Group();  // objects kept at true height (trees, buildings), placed on the exaggerated terrain
  scene.add(flat);
  return { i, scene, root, flat, labelsObj: null, resort: null, token: 0, mid: 0, extent: 0, runsObj: null, liftsObj: null };
}
const sides = [makeSide(0), makeSide(1)];

// ---------- data ----------
let INDEX = [];
const byId = new Map();
const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function init() {
  INDEX = await (await fetch('data/index.json')).json();
  INDEX.forEach(r => { byId.set(r.id, r); r._s = norm([r.name, r.fullName, r.countryName, r.region, r.country].join(' ')); });
  setupPickers();
  setupTools();
  // URL: /<first-resort>#<second-resort>   (old links: #a=<id>&b=<id>)
  let { a, b } = parseUrl();
  // nothing in the URL: the last pair this visitor looked at, else Big Sky vs Sugar Bowl
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('sc.pair') || '[]'); } catch {}
  if (!a && !b && byId.has(saved[0]) && byId.has(saved[1])) [a, b] = saved;
  else if (a && !b && byId.has(saved[1])) b = saved[1];   // /<resort> alone (e.g. a single-view link): keep the last partner
  a = a || 'big-sky';
  b = b && b !== a ? b : (a === 'sugar-bowl' ? 'big-sky' : 'sugar-bowl');
  // "Compare X with Y" links in the About dialog: in single view, go back to side by side so Y shows
  document.getElementById('aboutResort')?.addEventListener('click', e => {
    if (e.target.closest('a[href^="#"]') && settings.mode === 'single') setMode(settings.pairMode || 'aligned');
  });
  // back/forward, an edited fragment or a nearby-resort link: load whatever the URL now names
  window.addEventListener('popstate', () => {
    const { a, b } = parseUrl();
    window.closeAbout?.();
    const st = history.state;   // our own entries remember both resorts, even when the URL shows one
    const A = a || st?.a || sides[0].resort?.id;
    let B = b || (st?.a === A ? st.b : null) || sides[1].resort?.id;
    if (B === A) B = sides[1].resort?.id !== A ? sides[1].resort?.id : nearestResorts(byId.get(A), 1)[0][0].id;
    urlPair = `${A}#${B}`;   // already in history: don't push it again
    if (A !== sides[0].resort?.id) selectResort(0, A);
    if (B !== sides[1].resort?.id) selectResort(1, B);
    if (!b && a && settings.mode !== 'single') updateHash();
  });
  resize();
  await Promise.all([selectResort(0, a, false), selectResort(1, b, false)]);
  fitCamera();
}

// ---------- resort picker (one sheet, opened from either resort card) ----------
// Empty query: resorts near the one on that side, then the biggest resorts. Typing: matches by size rank.
const centreOf = r => [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2];
function distKm(a, b) {
  const [lo1, la1] = centreOf(a), [lo2, la2] = centreOf(b);
  const x = (lo2 - lo1) * Math.cos((la1 + la2) / 2 * DEG), y = la2 - la1;
  return Math.hypot(x, y) * 111.2;
}
function nearestResorts(r, n) {
  return INDEX.filter(o => o !== r).map(o => [o, distKm(r, o)]).sort((a, b) => a[1] - b[1]).slice(0, n);
}

const picker = { side: 0, items: [], act: 0 };
function setupPickers() {
  const sheet = $('#picker'), input = $('#q'), list = $('.results', sheet), count = $('.count', sheet);
  // Rows are added in chunks as the list scrolls, so typing stays fast on phones.
  const CHUNK = 200;
  let shown = 0, cur = null;
  const rowsHtml = (from, to) => {
    let html = '';
    for (let k = from; k < to; k++) {
      const { r, head, val } = picker.items[k];
      if (head) html += `<li class="h1">${esc(head)}</li>`;
      const sub = [r.region, r.countryName || r.country].filter(Boolean).join(', ');
      html += `<li role="option" data-k="${k}" class="${k === picker.act ? 'act' : ''}${r.id === cur ? ' cur' : ''}"><span class="n"><span class="nm">${esc(r.name)}</span> <span class="m">${esc(sub)}</span></span><span class="v">${val}</span><button class="other" data-o="${k}" title="Show on the other side" aria-label="Show ${esc(r.name)} on the other side">${otherIcon()}</button></li>`;
    }
    return html;
  };
  const more = upTo => {
    const to = Math.min(picker.items.length, Math.max(upTo || 0, shown + CHUNK));
    if (to > shown) { list.insertAdjacentHTML('beforeend', rowsHtml(shown, to)); shown = to; }
  };
  // scroll only the list, never the page (scrollIntoView also scrolls the page on iOS)
  const reveal = (li, center) => {
    if (!li) return;
    const top = li.offsetTop, h = li.offsetHeight, view = list.clientHeight;
    if (center) list.scrollTop = top - view / 2 + h / 2;
    else if (top < list.scrollTop + 40) list.scrollTop = top - 40;
    else if (top + h > list.scrollTop + view) list.scrollTop = top + h - view;
  };
  // ----- browse tree (empty query): continent > country > biggest resorts, "show all" by region -----
  const tree = { cont: null, ctry: null, all: null };
  let groups = null;   // continent -> country -> resorts (by size rank)
  const buildGroups = () => {
    const g = new Map();
    for (const r of INDEX) {
      const c = r.cont || 'Other', k = r.countryName || r.country || 'Other';
      if (!g.has(c)) g.set(c, new Map());
      const m = g.get(c);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    const byCount = m => new Map([...m].sort((x, y) => size(y[1]) - size(x[1])));
    const size = v => v instanceof Map ? [...v.values()].reduce((n, l) => n + l.length, 0) : v.length;
    return byCount(new Map([...g].map(([c, m]) => [c, byCount(m)])));
  };
  // which resorts a country shows before "Show all": at least 20 km of runs, min 5, max 25; small countries show everything
  const topOf = list => list.length <= 12 ? list : list.slice(0, Math.min(25, Math.max(5, list.filter(r => r.runKm >= 20).length)));
  const km = r => `${fmt(r.runKm)} km of runs`;
  const row = (r, val, sub = [r.region, r.countryName || r.country].filter(Boolean).join(', ')) => {
    const k = picker.items.push({ r }) - 1;
    return `<li role="option" data-k="${k}" class="${r.id === cur ? 'cur' : ''}"><span class="n"><span class="nm">${esc(r.name)}</span> <span class="m">${esc(sub)}</span></span><span class="v">${val}</span><button class="other" data-o="${k}" title="Show on the other side" aria-label="Show ${esc(r.name)} on the other side">${otherIcon()}</button></li>`;
  };
  const renderTree = () => {
    groups ??= buildGroups();
    const here = sides[picker.side].resort;
    picker.items = []; picker.act = -1;
    let html = '';
    if (here) {
      html += `<li class="h1">Near ${esc(here.name)}</li>`;
      for (const [r, d] of nearestResorts(here, 8)) html += row(r, `${fmt(d)} km away`);
    }
    html += '<li class="h1">Browse</li>';
    for (const [c, countries] of groups) {
      const n = [...countries.values()].reduce((s, l) => s + l.length, 0), open = tree.cont === c;
      html += `<li class="node cont${open ? ' open' : ''}" data-cont="${esc(c)}" role="button" aria-expanded="${open}"><span class="tw"></span>${esc(c)}<span class="v">${fmt(n)}</span></li>`;
      if (!open) continue;
      for (const [k, list] of countries) {
        const openK = tree.ctry === k;
        html += `<li class="node ctry${openK ? ' open' : ''}" data-ctry="${esc(k)}" role="button" aria-expanded="${openK}"><span class="tw"></span>${esc(k)}<span class="v">${fmt(list.length)}</span></li>`;
        if (!openK) continue;
        const top = topOf(list);
        if (tree.all === k && top.length < list.length) {
          const regions = new Map();
          for (const r of list) { const g = r.region || 'Other'; if (!regions.has(g)) regions.set(g, []); regions.get(g).push(r); }
          const runKm = rs => rs.reduce((t, r) => t + (r.runKm || 0), 0);
          for (const [g, rs] of [...regions].sort((x, y) => runKm(y[1]) - runKm(x[1]))) {   // biggest regions first
            html += `<li class="h2 reg">${esc(g)} <span>${rs.length}</span></li>`;
            for (const r of rs) html += row(r, km(r), '');
          }
        } else {
          for (const r of top) html += row(r, km(r), r.region || '');
          if (top.length < list.length) html += `<li class="node more" data-all="${esc(k)}" role="button">Show all ${fmt(list.length)} in ${esc(k)}</li>`;
        }
      }
    }
    list.innerHTML = html;
    shown = picker.items.length;   // nothing left for the chunk loader
    count.textContent = 'Type to search 4,000+ resorts';
  };
  const render = () => {
    const q = norm(input.value.trim());
    const words = q.split(/\s+/).filter(Boolean);
    const here = sides[picker.side].resort;
    cur = here?.id;
    if (!words.length) {
      groups ??= buildGroups();
      if (here) {
        const c = here.cont || 'Other', k = here.countryName || here.country;
        const inCountry = groups.get(c)?.get(k) || [];
        Object.assign(tree, { cont: c, ctry: k, all: topOf(inCountry).includes(here) ? null : k });
      }
      renderTree();
      list.scrollTop = 0;
      // start at the top (Nearby); the tree is already open on the current resort
      return;
    }
    const hits = INDEX.filter(r => words.every(w => r._s.includes(w))).sort((a, b) => a.rank - b.rank);
    picker.items = hits.map(r => ({ r, val: km(r) }));
    count.textContent = `${fmt(hits.length)} match${hits.length === 1 ? '' : 'es'}`;
    picker.act = 0;
    list.innerHTML = ''; shown = 0;
    if (!picker.items.length) list.innerHTML = '<li class="h2">No resorts match</li>';
    more();
    list.scrollTop = 0;
  };
  list.addEventListener('click', e => {
    const n = e.target.closest('li.node');
    if (!n) return;
    const keepTop = n.getBoundingClientRect().top - list.getBoundingClientRect().top;
    let sel;
    if (n.dataset.cont != null) { const c = n.dataset.cont; tree.cont = tree.cont === c ? null : c; tree.ctry = null; tree.all = null; sel = `li.cont[data-cont="${CSS.escape(c)}"]`; }
    else if (n.dataset.ctry != null) { const k = n.dataset.ctry; tree.ctry = tree.ctry === k ? null : k; tree.all = null; sel = `li.ctry[data-ctry="${CSS.escape(k)}"]`; }
    else if (n.dataset.all != null) { tree.all = n.dataset.all; sel = `li.ctry[data-ctry="${CSS.escape(n.dataset.all)}"]`; }
    renderTree();
    const h = list.querySelector(sel);
    if (h) list.scrollTop = h.offsetTop - keepTop;   // keep the tapped header where it was
  });
  list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight > list.scrollHeight - 600) more(); }, { passive: true });
  // keep the sheet inside the visible area when the phone keyboard is up
  const vv = window.visualViewport;
  const fitSheet = () => {
    if (!vv || !SMALL_SCREEN) return;
    for (const el of [sheet, $('#about')]) { el.style.top = `${vv.offsetTop}px`; el.style.height = `${vv.height}px`; el.style.bottom = 'auto'; }
  };
  vv?.addEventListener('resize', fitSheet); vv?.addEventListener('scroll', fitSheet);
  const close = () => { sheet.hidden = true; document.documentElement.classList.remove('sheet-open'); input.blur(); window.scrollTo(0, 0); };
  window.openPicker = side => {
    picker.side = side;
    sheet.dataset.side = side;
    sheet.hidden = false;
    document.documentElement.classList.add('sheet-open');
    fitSheet();
    input.value = '';
    input.placeholder = `${sides[side].resort?.name ? `Replace ${sides[side].resort.name}…` : 'Search 4,000+ resorts…'}`;
    render();
    if (!SMALL_SCREEN) input.focus();  // on phones, don't throw the keyboard up over the list
  };
  const pick = k => { const r = picker.items[k]?.r; if (!r) return; close(); selectResort(picker.side, r.id); };
  // the small button at the end of each row puts that resort on the other side instead
  const pickOther = k => {
    const r = picker.items[k]?.r; if (!r) return;
    close();
    if (settings.mode === 'single') setMode(settings.pairMode || 'aligned');
    selectResort(1 - picker.side, r.id);
  };
  const otherIcon = () => {
    const o = 1 - picker.side, col = o ? 'var(--b)' : 'var(--a)', st = stacked;
    const a = st ? 'x="2" y="1" width="14" height="5.5"' : 'x="1" y="2" width="7" height="12"', b = st ? 'x="2" y="7.5" width="14" height="5.5"' : 'x="10" y="2" width="7" height="12"';
    return `<svg viewBox="0 0 18 16" width="18" height="16" aria-hidden="true"><rect ${o ? a : b} rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect ${o ? b : a} rx="1.5" fill="${col}"/></svg>`;
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      picker.act = Math.max(0, Math.min(picker.items.length - 1, picker.act + (e.key === 'ArrowDown' ? 1 : -1)));
      more(picker.act + 20);
      list.querySelectorAll('li.act').forEach(li => li.classList.remove('act'));
      const li = list.querySelector(`li[data-k="${picker.act}"]`); li?.classList.add('act'); reveal(li, false);
    } else if (e.key === 'Enter') { e.preventDefault(); pick(picker.act); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); closeAbout(); } });
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  $('#pickClose').addEventListener('click', close);
  list.addEventListener('click', e => {
    const o = e.target.closest('button.other');
    if (o) { e.stopPropagation(); pickOther(+o.dataset.o); return; }
    const li = e.target.closest('li[data-k]'); if (li) pick(+li.dataset.k);
  });
  panels.forEach((p, i) => $('.pick', p).addEventListener('click', () => openPicker(i)));
  $('#swap').addEventListener('click', () => {
    const a = sides[0].resort?.id, b = sides[1].resort?.id;
    if (a && b) Promise.all([selectResort(0, b, false), selectResort(1, a, false)]).then(fitCamera);
  });
  // about / credits
  const about = $('#about');
  window.closeAbout = () => { about.hidden = true; };
  const openAbout = () => { about.hidden = false; fitSheet(); $('#aboutClose').focus(); };
  $('#infoBtn').addEventListener('click', openAbout);
  $('#credit').addEventListener('click', openAbout);
  $('#aboutClose').addEventListener('click', closeAbout);
  about.addEventListener('click', e => { if (e.target === about) closeAbout(); });
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setupTools() {
  $('#reset').addEventListener('click', () => { settings.view = '3d'; fitCamera(); });
  $('#compass').addEventListener('click', () => animateAzimuth(0));
  $('#zoomIn').addEventListener('click', () => zoomBy(0.7));
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 0.7));
  let collapsed = false;
  collapsed = SMALL_SCREEN;
  try { const v = localStorage.getItem('sc.collapsed'); if (v) collapsed = v === '1'; } catch {}
  const applyCollapse = () => panels.forEach(p => { p.classList.toggle('collapsed', collapsed); $('.collapse', p).setAttribute('aria-expanded', String(!collapsed)); });
  panels.forEach(p => $('.collapse', p).addEventListener('click', () => {
    collapsed = !collapsed; applyCollapse();
    try { localStorage.setItem('sc.collapsed', collapsed ? '1' : '0'); } catch {}
  }));
  applyCollapse();
  $('#elevSingle').addEventListener('click', () => setMode('single'));
  $('#elevAligned').addEventListener('click', () => setMode('aligned'));
  $('#elevTrue').addEventListener('click', () => setMode('true'));
  let saved = 'aligned';
  try { saved = localStorage.getItem('sc.mode') || 'aligned'; } catch {}
  setMode(['single', 'aligned', 'true'].includes(saved) ? saved : 'aligned', false);
  updateElevIcons();
  window.addEventListener('resize', resize);
  updateLegend();
}

// ---------- resort selection ----------
async function selectResort(side, id, refit = true) {
  const S = sides[side];
  const meta = byId.get(id);
  if (!meta) return;
  const token = ++S.token;
  S.resort = meta;
  renderPanel(side, meta, null);
  setStatus(side, 'Loading resort data…');
  updateHash();
  try {
    const data = await (await fetch(`${RESORT_DIR}/${id}.json`)).json();
    if (token !== S.token) return;
    const progress = (n, t) => token === S.token && setStatus(side, `Loading terrain ${n}/${t} tiles…`);
    let terrain = null;
    if (data.terrain) {
      setStatus(side, 'Loading terrain…');
      terrain = await loadBakedTerrain(data.id, data.terrain).catch(err => { console.warn('baked terrain failed, using live tiles', err); return null; });
    }
    if (!terrain) terrain = await loadTerrain(data.bbox, progress, data.win);
    if (token !== S.token) return;
    setStatus(side, 'Loading trees and buildings…');
    const [landcover, features, places] = await Promise.all([
      loadLandcover(id).catch(err => { console.warn('no landcover', err); return null; }),
      fetch(`data/features/${id}.json`).then(r => r.ok ? r.json() : null).then(decodeFeatures).catch(() => null),
      fetch(`data/places/${id}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (token !== S.token) return;
    setStatus(side, 'Building model…');
    await new Promise(r => setTimeout(r, 0));
    buildSide(S, data, terrain, landcover, features, places);
    renderPanel(side, meta, S);
    setStatus(side, '');
    applyVertical();
    if (refit) fitCamera(); else requestRender();
  } catch (err) {
    console.error(err);
    if (token === S.token) setStatus(side, 'Failed to load: ' + err.message);
  }
}

const BASE = location.pathname.replace(/[^/]*$/, '');
function parseUrl() {
  const seg = decodeURIComponent(location.pathname.slice(BASE.length)).replace(/\.html$/, '');
  const frag = decodeURIComponent(location.hash.slice(1));
  let a = byId.has(seg) ? seg : null, b = null;
  if (frag.includes('=')) { const h = new URLSearchParams(frag); a = a || (byId.has(h.get('a')) ? h.get('a') : null); b = h.get('b'); }
  else b = frag;
  return { a, b: byId.has(b) ? b : null };
}
// Address bar: /<left>#<right>, or just /<resort> in single view. A new pair of resorts gets its own history
// entry (so Back returns to the previous pair); the mode, or both halves of a swap, only replace it.
let urlPair = null, urlTimer = 0;
function writeUrl() {
  const A = sides[0].resort, B = sides[1].resort;
  if (!A || !B) return;
  const pair = `${A.id}#${B.id}`;
  const url = BASE + (settings.mode === 'single' ? A.id : pair);
  if (url !== location.pathname + location.hash) {
    if (urlPair && pair !== urlPair) history.pushState({ a: A.id, b: B.id }, '', url);
    else history.replaceState({ a: A.id, b: B.id }, '', url);
  } else if (history.state?.a !== A.id || history.state?.b !== B.id) history.replaceState({ a: A.id, b: B.id }, '', url);
  urlPair = pair;
}
function updateHash() {
  const A = sides[0].resort, B = sides[1].resort;
  if (!A || !B) return;
  clearTimeout(urlTimer);
  urlTimer = setTimeout(writeUrl, 0);
  document.title = settings.mode === 'single' ? `${A.name} in 3D · Slope Spy` : `${A.name} vs ${B.name} · Slope Spy`;
  try { localStorage.setItem('sc.pair', JSON.stringify([A.id, B.id])); } catch {}
  renderAboutResort(A);
  updateElevIcons();
}

// The About dialog's section on the first resort: facts and nearby resorts to compare with.
function renderAboutResort(r) {
  const el = document.getElementById('aboutResort');
  if (!el) return;
  const where = [r.region, r.countryName].filter(Boolean).join(', ');
  const bits = [r.runKm ? `${fmt(r.runKm)} km of mapped runs` : null, r.lifts ? `${r.lifts} lifts` : null, r.vert ? `${fmt(r.vert)} m vertical` : null].filter(Boolean);
  el.innerHTML = `<h3>${esc(r.name)}</h3><p class="resort-facts">${esc(where)}. ${esc(bits.join(', '))}.</p>`
    + `<h3>Compare ${esc(r.name)} with</h3><ul class="links">`
    + nearestResorts(r, 12).map(([o]) => `<li><a href="#${o.id}">${esc(o.name)}</a></li>`).join('') + '</ul>'
    + '<p><a href="resorts">Browse all ski resorts</a></p>';
}

function setStatus(side, msg) {
  $('.status', panels[side]).textContent = msg;
  const sp = spinners[side];
  sp.hidden = !msg || msg.startsWith('Failed');
  sp.querySelector('span').textContent = msg;
}
const spinners = [0, 1].map(i => {
  const el = document.createElement('div');
  el.className = 'loading'; el.dataset.side = i; el.hidden = true;
  el.setAttribute('role', 'status');
  el.innerHTML = '<i></i><span></span>';
  document.getElementById('stage').appendChild(el);
  return el;
});

// ---------- terrain ----------
const tileCache = new Map();
function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, (async () => {
      const res = await fetchTileResponse(z, x, y);
      if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const h = new Float32Array(256 * 256);
      for (let k = 0; k < h.length; k++) h[k] = px[4 * k] * 256 + px[4 * k + 1] + px[4 * k + 2] / 256 - 32768;
      return h;
    })().catch(e => { tileCache.delete(key); throw e; }));
  }
  return tileCache.get(key);
}

// Pre-baked heightmap (scripts/bake_terrain.py): a Terrarium-encoded PNG resampled over the same window.
async function loadBakedTerrain(id, meta) {
  let blob;
  if (meta.png) {  // single-file bundle: PNG embedded as base64
    const bin = atob(meta.png), bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    blob = new Blob([bytes], { type: 'image/png' });
  } else {
    const res = await fetch(`data/terrain/${id}.png`);
    if (!res.ok) throw new Error(`terrain ${id}: HTTP ${res.status}`);
    blob = await res.blob();
  }
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { w, h, z, crop } = meta;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let k = 0; k < data.length; k++) data[k] = px[4 * k] * 256 + px[4 * k + 1] + px[4 * k + 2] / 256 - 32768;
  const sx = (w - 1) / (crop[2] - crop[0]), sy = (h - 1) / (crop[3] - crop[1]);
  const sampleGP = (gx, gy) => {
    let x = (gx - crop[0]) * sx, y = (gy - crop[1]) * sy;
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
  };
  return { z, crop, grid: [w, h], sample: (lon, lat) => sampleGP(lon2px(lon, z), lat2px(lat, z)), sampleGP };
}

async function loadTerrain(bbox, progress, win) {
  let [w, s, e, n] = bbox;
  let z = MAX_ZOOM, tx0, tx1, ty0, ty1, crop;
  if (win) {  // window precomputed by the data build, shared with the land-cover raster
    z = win.z; crop = win.crop;
    tx0 = Math.floor(crop[0] / 256); tx1 = Math.floor(crop[2] / 256);
    ty0 = Math.floor(crop[1] / 256); ty1 = Math.floor(crop[3] / 256);
  } else {
    const lat0 = (s + n) / 2;
    const mLat = EARTH_R * DEG, mLon = EARTH_R * DEG * Math.cos(lat0 * DEG);
    const pad = Math.max(1200, 0.12 * Math.max((e - w) * mLon, (n - s) * mLat));
    w -= pad / mLon; e += pad / mLon; s -= pad / mLat; n += pad / mLat;
    for (; z >= 6; z--) {
      tx0 = Math.floor(lon2px(w, z) / 256); tx1 = Math.floor(lon2px(e, z) / 256);
      ty0 = Math.floor(lat2px(n, z) / 256); ty1 = Math.floor(lat2px(s, z) / 256);
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES) break;
    }
    crop = [lon2px(w, z), lat2px(n, z), lon2px(e, z), lat2px(s, z)];
  }
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1, cols = nx * 256, rows = ny * 256;
  const data = new Float32Array(cols * rows);
  let done = 0; const total = nx * ny;
  progress(0, total);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(fetchTile(z, tx, ty).then(h => {
      const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
      for (let r = 0; r < 256; r++) data.set(h.subarray(r * 256, r * 256 + 256), (oy + r) * cols + ox);
      progress(++done, total);
    }));
  }
  await Promise.all(jobs);
  const ox = tx0 * 256, oy = ty0 * 256;
  // bilinear sample by global pixel coordinates
  const sampleGP = (gx, gy) => {
    let x = gx - ox - 0.5, y = gy - oy - 0.5;
    x = Math.max(0, Math.min(cols - 1.001, x)); y = Math.max(0, Math.min(rows - 1.001, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * cols + x0;
    return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + cols] * (1 - fx) + data[i + cols + 1] * fx) * fy;
  };
  return {
    z, crop,
    sample: (lon, lat) => sampleGP(lon2px(lon, z), lat2px(lat, z)),
    sampleGP,
  };
}

// ---------- model building ----------
function disposeTree(obj) {
  obj.traverse(o => { o.geometry?.dispose(); if (o.material) { lineMaterials.delete(o.material); o.material.dispose(); } });
}

function buildSide(S, data, terrain, landcover, features, places) {
  for (const g of [S.root, S.flat]) for (const c of [...g.children]) { g.remove(c); disposeTree(c); }
  if (hover?.S === S) setHover(null);
  S.labelsObj = null; S.placesObj = null; S.ground = null; S.liftList = []; S.trees = null; S.buildings = null; S.placedExag = null;
  const [cx, cy] = [(data.bbox[0] + data.bbox[2]) / 2, (data.bbox[1] + data.bbox[3]) / 2];
  const kx = EARTH_R * DEG * Math.cos(cy * DEG), ky = EARTH_R * DEG;
  const toX = lon => (lon - cx) * kx, toZ = lat => -(lat - cy) * ky;
  S.project = { toX, toZ, fromXZ: (x, z) => [cx + x / kx, cy - z / ky] };

  // --- terrain mesh ---
  const { z } = terrain;
  const [px0, py0, px1, py1] = terrain.crop;
  const span = Math.max(px1 - px0, py1 - py0);
  const step = Math.max(1, span / MAX_SEGMENTS);
  let nx = Math.ceil((px1 - px0) / step), ny = Math.ceil((py1 - py0) / step);
  if (terrain.grid && Math.max(...terrain.grid) - 1 <= MAX_SEGMENTS) [nx, ny] = [terrain.grid[0] - 1, terrain.grid[1] - 1];
  const vcount = (nx + 1) * (ny + 1);
  const pos = new Float32Array(vcount * 3);
  const heights = new Float32Array(vcount);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j <= ny; j++) {
    const gy = py0 + (py1 - py0) * j / ny, lat = px2lat(gy, z);
    for (let i = 0; i <= nx; i++) {
      const gx = px0 + (px1 - px0) * i / nx, lon = px2lon(gx, z);
      const k = j * (nx + 1) + i;
      const h = terrain.sampleGP(gx, gy);
      heights[k] = h; hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
      pos[3 * k] = toX(lon); pos[3 * k + 1] = h; pos[3 * k + 2] = toZ(lat);
    }
  }
  const idx = new Uint32Array(nx * ny * 6);
  let t = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const uv = new Float32Array(vcount * 2);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const k = j * (nx + 1) + i; uv[2 * k] = i / nx; uv[2 * k + 1] = 1 - j / ny; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  // colour by slope and position within the resort's elevation band
  const cols = new Float32Array(vcount * 3);
  const base = data.base ?? hmin, top = data.top ?? hmax;
  const [cValley, cMid, cSnow] = PAL.elev.map(c => new THREE.Color(c)), cRock = new THREE.Color(PAL.rock);
  const nrm = geo.attributes.normal.array, tmp = new THREE.Color();
  for (let k = 0; k < vcount; k++) {
    const h = heights[k];
    const u = THREE.MathUtils.clamp((h - (base - 150)) / Math.max(300, top - base + 150), 0, 1);
    if (u < 0.35) tmp.copy(cValley).lerp(cMid, u / 0.35); else tmp.copy(cMid).lerp(cSnow, Math.min(1, (u - 0.35) / 0.4));
    const slope = Math.acos(Math.min(1, nrm[3 * k + 1])) / DEG;
    const rock = THREE.MathUtils.smoothstep(slope, 36, 48);
    if (landcover) tmp.setRGB(1, 1, 1);  // the land-cover texture supplies colour; keep only the rock tint
    tmp.lerp(cRock, rock * (landcover ? PAL.rockAmt : 0.85));
    cols[3 * k] = tmp.r; cols[3 * k + 1] = tmp.g; cols[3 * k + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false });
  const mppC = 40075016 * Math.cos(cy * DEG) / worldPx(z);  // metres per mercator pixel at this zoom
  if (landcover) {
    S.ground = paintGround(landcover, features, terrain.crop, z, (px1 - px0) * mppC, data.boundary);
    mat.map = S.ground.tex;
    mat.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  mat.onBeforeCompile = shader => {
    shader.uniforms.uGrid = gridUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGridPos = position.xz;\nvElev = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;\nvarying float vElev;\nuniform float uGrid;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 gp = vGridPos / 1000.0;
        vec2 gw = fwidth(gp);
        vec2 gl = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-6));
        float gline = 1.0 - min(min(gl.x, gl.y), 1.0);
        gline *= 1.0 - smoothstep(0.08, 0.35, max(gw.x, gw.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.24, 0.34), gline * 0.45 * uGrid);
        // contour lines: every 20 m, stronger every 100 m; each set fades out before it gets too dense
        float c20 = vElev / 20.0, w20 = fwidth(c20);
        float l20 = (1.0 - min(abs(fract(c20 - 0.5) - 0.5) / max(w20, 1e-6), 1.0)) * (1.0 - smoothstep(0.12, 0.35, w20));
        float c100 = vElev / 100.0, w100 = fwidth(c100);
        float l100 = (1.0 - min(abs(fract(c100 - 0.5) - 0.5) / max(w100 * 1.3, 1e-6), 1.0)) * (1.0 - smoothstep(0.15, 0.45, w100));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${PAL.contour.join(', ')}), max(l20 * ${PAL.c20.toFixed(3)}, l100 * ${PAL.c100.toFixed(3)}));`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  S.root.add(mesh);

  // --- skirt (gives the model a solid "block" look) ---
  S.root.add(buildSkirt(pos, nx, ny, hmin - 150));

  // --- lines: runs, lifts, boundary ---
  const cell = (span / Math.max(nx, ny)) * (40075016 * Math.cos(cy * DEG) / worldPx(z));
  const drape = (lon, lat, lift) => [toX(lon), terrain.sample(lon, lat) + lift, toZ(lat)];
  const densify = (coords, lift, maxSeg, out, colorArr, col) => {
    for (let k = 0; k + 1 < coords.length; k++) {
      const [a0, a1] = coords[k], [b0, b1] = coords[k + 1];
      const dist = Math.hypot((b0 - a0) * kx, (b1 - a1) * ky);
      const nseg = Math.max(1, Math.min(200, Math.ceil(dist / maxSeg)));
      let prev = drape(a0, a1, lift);
      for (let q = 1; q <= nseg; q++) {
        const f = q / nseg;
        const cur = drape(a0 + (b0 - a0) * f, a1 + (b1 - a1) * f, lift);
        out.push(...prev, ...cur);
        colorArr.push(col.r, col.g, col.b, col.r, col.g, col.b);
        prev = cur;
      }
    }
  };
  const lineSets = (feats, fn) => {
    for (const f of feats) {
      if (f.t === 'LineString') fn(f, f.c);
      else if (f.t === 'MultiLineString' || f.t === 'Polygon') f.c.forEach(r => fn(f, r));
      else if (f.t === 'MultiPolygon') f.c.forEach(p => p.forEach(r => fn(f, r)));
    }
  };
  const conv = CONVENTIONS[data.conv] || CONVENTIONS.europe;
  const runPos = [], runCol = [];
  lineSets(data.runs, (f, ring) => {
    const key = conv[f.d] || ({ freeride: 'orange', extreme: 'orange' }[f.d]) || 'grey';
    densify(ring, 4, cell * 1.2, runPos, runCol, new THREE.Color(DIFF_COLORS[key]));
  });
  S.runsObj = makeLines(runPos, runCol, 2.2);
  S.root.add(S.runsObj);

  buildLifts(S, data, terrain);

  if (data.boundary) {
    const bp = [], bc = [];
    lineSets([data.boundary], (f, ring) => densify(ring, 6, cell * 1.5, bp, bc, new THREE.Color(BOUNDARY_COLOR)));
    S.boundaryObj = makeLines(bp, bc, 1.4, 0.75);
    S.root.add(S.boundaryObj);
  }

  // --- trees and buildings (true height, sitting on the exaggerated terrain) ---
  if (landcover) S.trees = buildTrees(S, landcover, terrain, toX, toZ, z);
  if (features?.b?.length) S.buildings = buildBuildings(S, features.b, terrain, toX, toZ);
  S.treeShare = landcover ? landcover.treeShare : null;
  S.buildingCount = features?.b?.length ?? null;

  // --- stats in local metres ---
  const xs = [], zs = [];
  lineSets(data.runs.concat(data.lifts), (f, ring) => ring.forEach(([lo, la]) => { xs.push(toX(lo)); zs.push(toZ(la)); }));
  S.footprint = [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
  S.area = data.boundary ? polyArea(data.boundary, toX, toZ) : null;
  S.website = data.website || null;
  S.osk = /^[0-9a-f]{40}$/.test(data.osk || '') ? data.osk : null;
  S.extent = Math.max((px1 - px0), (py1 - py0)) * (40075016 * Math.cos(cy * DEG) / worldPx(z));
  S.mid = ((data.top ?? hmax) + (data.base ?? hmin)) / 2;
  S.zoom = z;
  S.cell = cell;
  if (places) buildPlaceLabels(S, places, terrain);
  applyVisibility();
}

// ---------- base map colours ----------
// lc: ESA WorldCover class -> RGB. elev: vertex tint by height when there's no land cover. rock: steep-slope tint.
// Natural, satellite-like: meadow greens below, grey scree and snow above the trees
const PAL = {
  lc: { 0: [196, 192, 182], 10: [58, 92, 52], 20: [146, 158, 104], 30: [168, 180, 116], 40: [192, 186, 132], 50: [176, 166, 156], 60: [184, 178, 168], 70: [246, 248, 250], 80: [76, 120, 160], 90: [130, 152, 120], 95: [58, 92, 52], 100: [170, 172, 150] },
  elev: ['#8fa46a', '#c2bcae', '#f4f5f6'], rock: '#9b958b', rockAmt: 0.75,
  roads: { major: ['#ece6da', '#6f675c'], minor: ['#ddd7cb', '#7d756a'], service: ['#d2ccc0', '#857d72'] },
  parking: '#b9b2a6', bldFill: '#a8988a', bldLine: '#776a5e', bld3d: '#a08f80', tree: '#2f5230',
  contour: [0.30, 0.27, 0.22], c20: 0.10, c100: 0.22, shade: { inside: 0, outside: 30 },
};

// ---------- land cover, trees, buildings ----------
const LC_COLORS = PAL.lc;
const ROAD_STYLE = { major: [...PAL.roads.major, 14], minor: [...PAL.roads.minor, 8], service: [...PAL.roads.service, 5] };

// features files store rings as flat [x1, y1, x2, y2, ...] metres from an origin; turn them back into [lon, lat]
function decodeFeatures(f) {
  if (!f?.o) return f;
  const [lon0, lat0, kx, ky] = f.o;
  const ring = a => { const out = []; for (let k = 0; k + 1 < a.length; k += 2) out.push([lon0 + a[k] / kx, lat0 + a[k + 1] / ky]); return out; };
  const r = {};
  for (const k in f.r || {}) r[k] = f.r[k].map(ring);
  return { b: (f.b || []).map(a => [a[0], ring(a.slice(1))]), p: (f.p || []).map(ring), r };
}

async function loadLandcover(id) {
  const res = await fetch(`data/landcover/${id}.png`);
  if (!res.ok) throw new Error(`landcover ${id}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width, h = bmp.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const cls = new Uint8Array(w * h);
  let trees = 0;
  for (let k = 0; k < cls.length; k++) { cls[k] = px[4 * k]; if (cls[k] === 10) trees++; }
  return { w, h, cls, treeShare: trees / cls.length };
}

// Paint the ground texture: land cover, then parking lots, roads and building footprints.
function paintGround(lc, features, crop, z, widthM, boundary) {
  const small = new OffscreenCanvas(lc.w, lc.h);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(lc.w, lc.h);
  for (let k = 0; k < lc.cls.length; k++) {
    const col = LC_COLORS[lc.cls[k]] || LC_COLORS[0];
    img.data[4 * k] = col[0]; img.data[4 * k + 1] = col[1]; img.data[4 * k + 2] = col[2]; img.data[4 * k + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const W = TEX_SIZE, H = Math.max(2, Math.round(W * lc.h / lc.w));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, W, H);
  if (features) {
    const sx = W / (crop[2] - crop[0]), sy = H / (crop[3] - crop[1]);
    const P = ([lon, lat]) => [(lon2px(lon, z) - crop[0]) * sx, (lat2px(lat, z) - crop[1]) * sy];
    const path = ring => { ring.forEach((pt, i) => { const [x, y] = P(pt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
    const mPerTexPx = widthM / W;
    ctx.fillStyle = PAL.parking;
    for (const ring of features.p || []) { ctx.beginPath(); path(ring); ctx.closePath(); ctx.fill(); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const pass of [1, 0]) for (const k of ['service', 'minor', 'major']) {   // casings first, then fills
      const [fill, casing, wm] = ROAD_STYLE[k];
      const w = Math.max(k === 'major' ? 1.6 : 1, wm / mPerTexPx);
      ctx.strokeStyle = pass ? casing : fill; ctx.lineWidth = pass ? w + Math.max(1, w * 0.35) : w;
      ctx.beginPath();
      for (const line of features.r?.[k] || []) path(line);
      ctx.stroke();
    }
    ctx.fillStyle = PAL.bldFill; ctx.strokeStyle = PAL.bldLine; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [, ring] of features.b || []) { path(ring); ctx.closePath(); }
    ctx.fill(); ctx.stroke();
  }
  // Inside/outside shading is applied on top of a saved copy, so it can be re-tuned live.
  let mask = null;
  if (boundary) {
    const sx = W / (crop[2] - crop[0]), sy = H / (crop[3] - crop[1]);
    mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const g = mask.getContext('2d');
    g.fillStyle = '#fff';
    for (const poly of boundary.t === 'Polygon' ? [boundary.c] : boundary.c) {
      g.beginPath();
      for (const ring of poly) ring.forEach(([lon, lat], i) => { const x = (lon2px(lon, z) - crop[0]) * sx, y = (lat2px(lat, z) - crop[1]) * sy; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.fill('evenodd');
    }
  }
  const base = document.createElement('canvas'); base.width = W; base.height = H;
  base.getContext('2d').drawImage(cv, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const ground = { tex, cv, base, mask };
  applyShading(ground);
  return ground;
}

// Shading: -100 darkens to black, +100 lightens to white.
const shading = { ...PAL.shade };  // per-palette: lighten (+) or darken (-) inside / outside the ski area
let shadeTmp = null;
function applyShading(G) {
  const { cv, base, mask, tex } = G, W = cv.width, H = cv.height;
  const ctx = cv.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(base, 0, 0);
  if (mask) {
    if (!shadeTmp || shadeTmp.width !== W || shadeTmp.height !== H) { shadeTmp = document.createElement('canvas'); shadeTmp.width = W; shadeTmp.height = H; }
    const g = shadeTmp.getContext('2d');
    for (const [v, op] of [[shading.outside, 'destination-out'], [shading.inside, 'destination-in']]) {
      if (!v) continue;
      g.globalCompositeOperation = 'copy';
      g.fillStyle = v < 0 ? `rgba(0,0,0,${-v / 100})` : `rgba(255,255,255,${v / 100})`;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = op;
      g.drawImage(mask, 0, 0);
      ctx.drawImage(shadeTmp, 0, 0);
    }
  }
  tex.needsUpdate = true;
}

// Conifer-ish cones scattered over WorldCover tree pixels.
function buildTrees(S, lc, terrain, toX, toZ, z) {
  const [px0, py0, px1, py1] = terrain.crop;
  const cellX = (px1 - px0) / lc.w, cellY = (py1 - py0) / lc.h;
  const mpp = 40075016 * Math.cos(px2lat((py0 + py1) / 2, z) * DEG) / worldPx(z);
  const pixArea = cellX * cellY * mpp * mpp;
  const treesPerPx = pixArea / (22 * 22);              // ~1 tree per 22 m x 22 m
  const nTreePx = Math.round(lc.treeShare * lc.cls.length);
  const want = nTreePx * treesPerPx;
  const p = Math.min(want, MAX_TREES) / Math.max(1, nTreePx);  // expected trees per tree pixel
  const pts = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let j = 0; j < lc.h; j++) for (let i = 0; i < lc.w; i++) {
    if (lc.cls[j * lc.w + i] !== 10) continue;
    let n = Math.floor(p); if (rnd() < p - n) n++;
    for (let q = 0; q < n; q++) {
      const gx = px0 + (i + rnd()) * cellX, gy = py0 + (j + rnd()) * cellY;
      pts.push(gx, gy, 0.7 + rnd() * 0.6, rnd() * Math.PI * 2);
    }
  }
  const count = pts.length / 4;
  if (!count) return null;
  const geo = new THREE.ConeGeometry(4, 16, 6);
  geo.translate(0, 8, 0);
  const mat = new THREE.MeshStandardMaterial({ color: PAL.tree, roughness: 1, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const base = new Float32Array(count * 4);
  for (let k = 0; k < count; k++) {
    const gx = pts[4 * k], gy = pts[4 * k + 1];
    base[4 * k] = toX(px2lon(gx, z)); base[4 * k + 1] = terrain.sampleGP(gx, gy); base[4 * k + 2] = toZ(px2lat(gy, z));
    base[4 * k + 3] = pts[4 * k + 2];
  }
  mesh.userData.base = base;
  mesh.userData.rot = pts.filter((_, i) => i % 4 === 3);
  S.flat.add(mesh);
  return mesh;
}

function placeTrees(mesh, exag) {
  if (!mesh) return;
  const { base, rot } = mesh.userData, m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < mesh.count; k++) {
    const s = base[4 * k + 3];
    m.compose(v.set(base[4 * k], base[4 * k + 1] * exag - 1, base[4 * k + 2]), q.setFromAxisAngle(up, rot[k]), sc.set(s, s, s));
    mesh.setMatrixAt(k, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

// Extruded building footprints (roof + walls) in one merged mesh.
function buildBuildings(S, list, terrain, toX, toZ) {
  const pos = [], baseH = [], idx = [];
  for (const [height, ring] of list) {
    let pts = ring.map(([lo, la]) => new THREE.Vector2(toX(lo), toZ(la)));
    if (pts.length > 1 && pts[0].equals(pts[pts.length - 1])) pts.pop();
    if (pts.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    let g = Infinity;
    for (const [lo, la] of ring) g = Math.min(g, terrain.sample(lo, la));
    const start = pos.length / 3, n = pts.length;
    // roof vertices then ground vertices
    for (const p of pts) { pos.push(p.x, height, p.y); baseH.push(g); }
    for (const p of pts) { pos.push(p.x, -2, p.y); baseH.push(g); }
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) idx.push(start + a, start + c, start + b);
    for (let k = 0; k < n; k++) {
      const a = start + k, b = start + (k + 1) % n, a2 = a + n, b2 = b + n;
      idx.push(a, a2, b, b, a2, b2);
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  const local = new Float32Array(pos);
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: PAL.bld3d, roughness: 0.9, flatShading: true }));
  mesh.userData = { local, baseH: new Float32Array(baseH) };
  S.flat.add(mesh);
  return mesh;
}

function placeBuildings(mesh, exag) {
  if (!mesh) return;
  const { local, baseH } = mesh.userData, arr = mesh.geometry.attributes.position.array;
  for (let k = 0; k < baseH.length; k++) arr[3 * k + 1] = baseH[k] * exag + local[3 * k + 1];
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
}

// ---------- lifts: icons, labels, hover ----------
const SURFACE = new Set(['t-bar', 'j-bar', 'platter', 'drag_lift', 'rope_tow']);
const LIFT_KIND = {
  chair_lift: 'Chairlift', gondola: 'Gondola', cable_car: 'Cable car', mixed_lift: 'Chair/gondola combo', funicular: 'Funicular',
  railway: 'Rack railway', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter', drag_lift: 'Drag lift', rope_tow: 'Rope tow', magic_carpet: 'Magic carpet',
};
// 16x16 line icons, drawn with currentColor
const ICON_PATHS = {
  chair: '<path d="M1 3.5 15 1.5M9 2.6v4.4"/><path d="M5.5 7h6v3.2M5.5 7v5.5h6"/>',
  gondola: '<path d="M1 3.5 15 1.5M8 2.5v2.5"/><rect x="4" y="5" width="8" height="8.5" rx="2"/><path d="M4 8.5h8"/>',
  tram: '<path d="M1 2.5 15 1.5M1 4 15 3M8 3.3v2"/><rect x="2.5" y="5.3" width="11" height="8" rx="1.5"/><path d="M2.5 8.5h11"/>',
  funicular: '<path d="M1 14 15 6"/><path d="M4 11.5 4 8l7-4 0 3.4z"/>',
  surface: '<path d="M1 3.5 15 1.5M8 2.5v8M5 10.5h6"/>',
  carpet: '<path d="M1 12.5 15 8.5"/><rect x="1.5" y="9" width="13" height="2.6" rx="1.3" transform="rotate(-16 8 10.3)"/>',
  combo: '<path d="M1 3.5 15 1.5M5 3v2.5M11 2.2v3"/><path d="M2.5 5.5h4v3.5h-4"/><rect x="9" y="5.2" width="5" height="6" rx="1.2"/>',
};
const iconFor = k => k === 'chair_lift' ? 'chair' : k === 'gondola' ? 'gondola' : k === 'cable_car' ? 'tram'
  : k === 'funicular' || k === 'railway' ? 'funicular' : k === 'magic_carpet' ? 'carpet' : k === 'mixed_lift' ? 'combo' : 'surface';
const iconSvg = k => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICON_PATHS[iconFor(k)]}</svg>`;

// Generic words that the icon already says. Removed only when something else is left.
const LIFT_WORDS = /\b(chair ?lift|chair|lift|gondola|gondel(bahn)?|kabinenbahn|sessel(bahn|lift)|schlepp(lift)?|skilift|ski lift|t-?bar|tellerlift|télé(siège|cabine|ski|phérique)|tele(siege|cabine|ski)|seggiovia|cabinovia|sciovia|funivia|quad|triple|double|six[- ]?pack|detachable|high[- ]?speed|4er|6er|8er|2er|3er|kombibahn)\b/gi;
function liftName(f) {
  let name = f.n || '';
  if (name.includes(', ')) {  // "アルペンクワッドリフト, Alpen Quad" -> the latin-script part
    const latin = name.split(', ').filter(p => /^[\x00-ɏ\s'’.&()-]+$/.test(p));
    if (latin.length) name = latin[latin.length - 1];
  }
  const short = name.replace(LIFT_WORDS, ' ').replace(/\s*[-–]\s*$|^\s*[-–]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
  return { full: name, short: short.replace(/[^\p{L}]/gu, '').length >= 4 ? short : name };
}
function liftSeats(f) { return f.o && !SURFACE.has(f.k) && f.k !== 'magic_carpet' ? f.o : null; }


function liftInfo(L) {
  const f = L.f, { full } = liftName(f), seats = liftSeats(f);
  const kind = (f.dt && f.k === 'chair_lift' ? 'Express chair' : LIFT_KIND[f.k] || 'Lift') + (f.b ? ' with bubble' : '');
  const line1 = [kind, seats ? `${seats} per ${f.k === 'chair_lift' ? 'chair' : 'cabin'}` : null].filter(Boolean).join(' · ');
  const line2 = [`${(L.len / 1000).toFixed(L.len < 1000 ? 2 : 1)} km`, `${fmt(L.vert)} m vertical`,
    f.cap ? `${fmt(f.cap)}/h` : null, f.dur ? `${Math.round(f.dur / 60)} min ride` : null].filter(Boolean).join(' · ');
  return `<div class="t">${iconSvg(f.k)}${esc(full || 'Unnamed lift')}</div><div>${line1}</div><div class="m">${line2}</div>`;
}

function buildLifts(S, data, terrain) {
  const { toX, toZ } = S.project;
  S.liftList = [];
  const casing = [], casingCol = [], body = [], bodyCol = [], stations = [];
  const lc = new THREE.Color(LIFT_COLOR), dark = new THREE.Color('#111418');
  for (const f of data.lifts) {
    const line = f.t === 'MultiLineString' ? f.c.flat() : f.c;
    if (!line?.length || line.length < 2) continue;
    const pts = line.map(([lo, la]) => new THREE.Vector3(toX(lo), terrain.sample(lo, la) + 12, toZ(la)));
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      casing.push(a.x, a.y, a.z, b.x, b.y, b.z); casingCol.push(dark.r, dark.g, dark.b, dark.r, dark.g, dark.b);
      body.push(a.x, a.y, a.z, b.x, b.y, b.z); bodyCol.push(lc.r, lc.g, lc.b, lc.r, lc.g, lc.b);
    }
    const first = pts[0], last = pts[pts.length - 1];
    stations.push(first.x, first.y, first.z, last.x, last.y, last.z);
    let len = 0; for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
    const top = first.y > last.y ? first : last;
    let mid = first, acc = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      if (acc + d >= len / 2) { mid = pts[k].clone().lerp(pts[k + 1], d ? (len / 2 - acc) / d : 0); break; }
      acc += d;
    }
    S.liftList.push({ f, pts, len, vert: Math.abs(first.y - last.y), top: top.clone().add(new THREE.Vector3(0, 10, 0)), mid });
  }
  const g = new THREE.Group();
  const casingLines = makeLines(casing, casingCol, 5.2);
  casingLines.material.depthWrite = false;  // let the bright core draw over its own casing
  g.add(casingLines);
  const bodyLines = makeLines(body, bodyCol, 2.4);
  bodyLines.material.depthFunc = THREE.LessEqualDepth;
  bodyLines.renderOrder = 3;
  g.add(bodyLines);
  if (stations.length) {
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(stations, 3));
    const pm = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, map: DOT_TEX, alphaTest: 0.5, transparent: true });
    const pts = new THREE.Points(sg, pm); pts.renderOrder = 4;
    g.add(pts);
  }
  S.liftsObj = g;
  S.root.add(g);
  buildLiftLabels(S);
}

// Lift names sit inline on the lift itself, like OpenSkiMap: a flat strip of text centred on the straight
// line between the two stations. Each frame it only turns about the lift's own axis to face the camera, and
// flips end for end when the lift would read right-to-left, so it is never upside down and never draped
// over bumpy terrain. Its size is in metres, so it zooms with the model instead of re-flowing.
const LABEL_H = 90;       // metres, text height (shrunk to fit short lifts)
const LABEL_MIN_H = 18;
const LABEL_PX = 64;      // texture pixels per text height
const ICON_IMG = {};
function iconImage(k) {
  const key = iconFor(k);
  if (!ICON_IMG[key]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="64" height="64" fill="none" stroke="#ffd23f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</svg>`;
    const img = new Image();
    ICON_IMG[key] = { img, ready: new Promise(r => { img.onload = r; img.onerror = r; }) };
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  return ICON_IMG[key];
}
function labelCanvas(f) {
  const { short } = liftName(f), seats = liftSeats(f);
  const txt = short.length > 28 ? short.slice(0, 27).trimEnd() + '…' : short;
  const P = LABEL_PX, font = `600 ${Math.round(P * 0.62)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const c = document.createElement('canvas'), x = c.getContext('2d');
  x.font = font;
  const iconW = P * 0.78, seatW = seats ? x.measureText(String(seats)).width * 0.8 + P * 0.36 : 0;
  const pad = P * 0.14, gap = P * 0.12;
  const w = Math.ceil(pad + iconW + gap + (seats ? seatW + gap : 0) + x.measureText(txt).width + pad);
  c.width = w; c.height = P;
  const draw = () => {
    x.clearRect(0, 0, w, P);
    x.font = font; x.textBaseline = 'middle'; x.lineJoin = 'round';
    let cx = pad;
    const ic = iconImage(f.k).img;
    if (ic.complete && ic.naturalWidth) {
      x.shadowColor = '#111418'; x.shadowBlur = P * 0.08;
      x.drawImage(ic, cx, (P - iconW) / 2, iconW, iconW);
      x.shadowBlur = 0;
    }
    cx += iconW + gap;
    if (seats) {
      x.fillStyle = '#111418'; x.beginPath(); x.roundRect(cx - 2, P * 0.17 - 2, seatW + 4, P * 0.66 + 4, P * 0.14); x.fill();
      x.fillStyle = '#ffd23f'; x.beginPath(); x.roundRect(cx, P * 0.17, seatW, P * 0.66, P * 0.11); x.fill();
      x.fillStyle = '#111418'; x.font = `700 ${Math.round(P * 0.5)}px system-ui, sans-serif`; x.textAlign = 'center';
      x.fillText(String(seats), cx + seatW / 2, P * 0.52);
      x.font = font; x.textAlign = 'left';
      cx += seatW + gap;
    }
    x.strokeStyle = 'rgba(17,20,24,.92)'; x.lineWidth = P * 0.16; x.strokeText(txt, cx, P * 0.53);
    x.fillStyle = '#fff6d6'; x.fillText(txt, cx, P * 0.53);
  };
  draw();
  return { c, aspect: w / P, redraw: draw, ready: iconImage(f.k).ready };
}

function buildLiftLabels(S) {
  const g = new THREE.Group();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const pending = [];
  for (const L of S.liftList) {
    if (!L.f.n || L.len < 120) continue;
    const a = L.pts[0], b = L.pts[L.pts.length - 1];
    const chord = Math.hypot(b.x - a.x, (b.y - a.y) * settings.exag, b.z - a.z);
    const lab = labelCanvas(L.f);
    let H = LABEL_H, W = H * lab.aspect;
    const room = chord * 0.8;
    if (W > room) { H = Math.max(LABEL_MIN_H, H * room / W); W = H * lab.aspect; }
    if (W > chord * 1.1) continue;   // a name that can't fit along its lift would only clutter
    const tex = new THREE.CanvasTexture(lab.c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    mesh.renderOrder = 6;
    mesh.matrixAutoUpdate = false;
    mesh.userData = { a: a.clone(), b: b.clone(), H, flip: 1 };
    g.add(mesh);
    pending.push(lab.ready.then(() => { lab.redraw(); tex.needsUpdate = true; }));
  }
  g.visible = settings.labels;
  S.labelsObj = g;
  S.flat.add(g);   // unscaled group: the strip keeps its true shape whatever the vertical exaggeration
  Promise.all(pending).then(requestRender);
}

// ---------- peak and village names ----------
// Map-style labels that always face the screen at a fixed pixel size, like OpenSkiMap's base map: peaks with
// their height, towns and villages, and hamlets in small capitals. Where they would overlap, the more
// important one wins (towns, then villages, then the highest peaks, then hamlets).
const PLACE_STYLE = [
  { px: 17, font: '650 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#2b2b2b' },    // city
  { px: 15, font: '650 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#2b2b2b' },    // town
  { px: 13.5, font: '600 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#333' },     // village
  { px: 10.5, font: 'italic 500 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#5e5e5e', caps: true }, // hamlet
];
function placeCanvas(lines, styles, peak) {
  const dpr = Math.min(2, devicePixelRatio || 1), S = 2 * dpr;   // draw at 2x screen pixels for sharp text
  const c = document.createElement('canvas'), x = c.getContext('2d');
  const fonts = styles.map(st => st.font.replace('{s}', st.px * S));
  const tri = peak ? 9 * S : 0, gap = 2 * S, halo = 2.4 * S;
  let w = tri, h = tri ? tri + gap : 0;
  const metrics = lines.map((t, i) => { x.font = fonts[i]; if (styles[i].caps) x.letterSpacing = `${S}px`; const m = x.measureText(t).width; x.letterSpacing = '0px'; return m; });
  w = Math.max(w, ...metrics) + 2 * halo;
  h += styles.reduce((a, st) => a + st.px * S * 1.2, 0) + halo;
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  x.textAlign = 'center'; x.textBaseline = 'top'; x.lineJoin = 'round';
  let y = 0;
  if (peak) {
    x.fillStyle = '#6b5a48'; x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 2 * S;
    x.beginPath(); x.moveTo(w / 2, y + 1 * S); x.lineTo(w / 2 + tri * 0.45, y + tri - 1 * S); x.lineTo(w / 2 - tri * 0.45, y + tri - 1 * S); x.closePath();
    x.stroke(); x.fill();
    y += tri + gap;
  }
  lines.forEach((t, i) => {
    const st = styles[i];
    x.font = fonts[i]; if (st.caps) x.letterSpacing = `${S}px`;
    x.strokeStyle = 'rgba(255,255,255,.88)'; x.lineWidth = halo; x.strokeText(t, w / 2, y);
    x.fillStyle = st.fill; x.fillText(t, w / 2, y);
    x.letterSpacing = '0px';
    y += st.px * S * 1.2;
  });
  // anchor: the peak's triangle, or the middle of a place name
  return { c, w: c.width / S, h: c.height / S, ay: peak ? 1 - (tri / 2) / c.height : 0.5 };
}
function buildPlaceLabels(S, places, terrain) {
  const { toX, toZ } = S.project;
  const g = new THREE.Group(), items = [];
  const peakStyle = { px: 11.5, font: '600 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#5a4734' };
  const eleStyle = { px: 10, font: '500 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', fill: '#7a6a5a' };
  const short = n => n.split(' / ')[0];   // bilingual names ("Mont X / Monte X"): first one
  for (const [n, lon, lat, rank] of places.v || []) items.push({ lon, lat, pri: rank === 3 ? 3 : rank, lab: placeCanvas([rank === 3 ? short(n).toUpperCase() : short(n)], [PLACE_STYLE[rank]]) });
  (places.k || []).forEach(([n, lon, lat, ele], i) => items.push({ lon, lat, pri: 2.5 + i / 1000,
    lab: ele != null ? placeCanvas([short(n), `${fmt(ele)} m`], [peakStyle, eleStyle], true) : placeCanvas([short(n)], [peakStyle], true) }));
  items.sort((a, b) => a.pri - b.pri);
  for (const it of items) {
    const tex = new THREE.CanvasTexture(it.lab.c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
    sp.center.set(0.5, it.lab.ay);
    sp.renderOrder = 7;
    sp.userData = { x: toX(it.lon), y: terrain.sample(it.lon, it.lat), z: toZ(it.lat), w: it.lab.w, h: it.lab.h, ay: it.lab.ay };
    g.add(sp);
  }
  g.visible = settings.labels;
  S.placesObj = g;
  S.groundAt = (x, z) => terrain.sample(...S.project.fromXZ(x, z));
  S.flat.add(g);
}
// Place the names for this frame: fixed pixel size, hidden when a ridge stands between them and the camera,
// and thinned out wherever they would overlap.
const _pp = new THREE.Vector3(), _pc = new THREE.Vector3();
function hiddenByTerrain(S, from, to, ex) {
  for (let i = 1; i < 24; i++) {
    const t = i / 24, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
    if (y < S.groundAt(x, z) * ex - 8) return true;
  }
  return false;
}
function layoutPlaces(S) {
  const g = S.placesObj;
  if (!g?.visible) return;
  const ex = settings.exag, k = 2 / (camera.projectionMatrix.elements[5] * viewH);   // screen px -> sprite scale
  _pc.copy(camera.position).sub(S.flat.position);
  const taken = [];
  for (const sp of g.children) {
    const u = sp.userData;
    sp.position.set(u.x, u.y * ex + 6, u.z);
    sp.scale.set(u.w * k, u.h * k, 1);
    // screen rectangle
    _pp.copy(sp.position).add(S.flat.position).project(camera);
    const sx = (_pp.x + 1) / 2 * viewW, sy = (1 - _pp.y) / 2 * viewH;
    const top = sy - (1 - u.ay) * u.h, r = { x0: sx - u.w / 2, x1: sx + u.w / 2, y0: top, y1: top + u.h };
    let ok = _pp.z < 1 && r.x0 > 2 && r.x1 < viewW - 2 && r.y0 > 2 && r.y1 < viewH - 2;
    if (ok) for (const t of taken) if (r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0) { ok = false; break; }
    if (ok) ok = !hiddenByTerrain(S, sp.position, _pc, ex);
    sp.visible = ok;
    if (ok) taken.push(r);
  }
}

// Turn each lift label about its lift to face the camera (called before every render).
const _la = new THREE.Vector3(), _lb = new THREE.Vector3(), _ld = new THREE.Vector3(), _ln = new THREE.Vector3(),
  _lu = new THREE.Vector3(), _lc = new THREE.Vector3(), _lr = new THREE.Vector3();
function orientLabels(S) {
  const g = S.labelsObj;
  if (!g?.visible) return;
  const ex = settings.exag;
  _lc.copy(camera.position).sub(S.flat.position);          // camera in the group's frame
  _lr.setFromMatrixColumn(camera.matrixWorld, 0);           // screen right
  for (const m of g.children) {
    const { a, b, H } = m.userData;
    _la.set(a.x, a.y * ex, a.z); _lb.set(b.x, b.y * ex, b.z);
    _ld.subVectors(_lb, _la).normalize();
    // read left to right on screen; a little hysteresis stops flicker when the lift points at the camera
    const dr = _ld.dot(_lr);
    if (dr * m.userData.flip < -0.08) m.userData.flip *= -1;
    _ld.multiplyScalar(m.userData.flip);
    const mid = _la.add(_lb).multiplyScalar(0.5);
    _ln.subVectors(_lc, mid);
    _ln.addScaledVector(_ld, -_ln.dot(_ld)).normalize();   // towards the camera, square to the lift
    _lu.crossVectors(_ln, _ld);
    m.matrix.makeBasis(_ld, _lu, _ln);
    m.matrix.setPosition(mid.addScaledVector(_ln, H * 0.6)); // lifted off the cable so terrain doesn't clip it
    m.matrixWorldNeedsUpdate = true;
  }
}

const DOT_TEX = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = '#111418'; x.beginPath(); x.arc(16, 16, 15, 0, 7); x.fill();
  x.fillStyle = '#fff4c2'; x.beginPath(); x.arc(16, 16, 9, 0, 7); x.fill();
  return new THREE.CanvasTexture(c);
})();

// hover: nearest lift to the pointer in screen space
const _v = new THREE.Vector3();
let hover = null;
const tooltip = document.createElement('div');
tooltip.className = 'lift-tip'; tooltip.hidden = true;
stage.appendChild(tooltip);

function setHover(S, L, at) {
  if (hover && (!S || hover.L !== L)) {
    hover.S.root.remove(hover.obj); disposeTree(hover.obj);
    hover.L.el?.classList.remove('hot');
    hover = null;
  }
  if (!S || !L) { tooltip.hidden = true; requestRender(); return; }
  if (!hover) {
    const p = [], c = [], col = new THREE.Color('#fff6b0');
    for (let k = 0; k + 1 < L.pts.length; k++) { const a = L.pts[k], b = L.pts[k + 1]; p.push(a.x, a.y, a.z, b.x, b.y, b.z); c.push(col.r, col.g, col.b, col.r, col.g, col.b); }
    const obj = makeLines(p, c, 6);
    obj.material.depthTest = false; obj.renderOrder = 10;
    S.root.add(obj);
    L.el?.classList.add('hot');
    hover = { S, L, obj };
  }
  tooltip.innerHTML = liftInfo(L);
  tooltip.hidden = false;
  const r = stage.getBoundingClientRect();
  let x, y;
  if (at) { x = at[0]; y = at[1]; } else {
    _v.copy(L.top).applyMatrix4(S.root.matrixWorld).project(camera);
    const [ox, oy] = viewOrigin(S.i);
    x = ox + (_v.x + 1) / 2 * viewW; y = oy + (1 - _v.y) / 2 * viewH;
  }
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.transform = `translate(${Math.round(Math.min(Math.max(4, x + 14), r.width - tw - 4))}px, ${Math.round(Math.min(Math.max(4, y + 14), r.height - th - 4))}px)`;
  requestRender();
}

function viewOrigin(i) {  // top-left of side i's viewport in stage CSS pixels
  return stacked ? [0, i === 0 ? 0 : stage.clientHeight - viewH] : [i === 0 ? 0 : stage.clientWidth - viewW, 0];
}

let hoverQueued = null;
canvas.addEventListener('pointermove', e => {
  if (e.buttons) { if (hover) setHover(null); return; }
  hoverQueued = e;
});
canvas.addEventListener('pointerleave', () => setHover(null));
function processHover() {
  const e = hoverQueued; hoverQueued = null;
  if (!e || !settings.lifts) return;
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const i = settings.mode === 'single' ? 0 : stacked ? (my < viewH ? 0 : 1) : (mx < viewW ? 0 : 1);
  const S = sides[i];
  if (!S.liftList?.length) return setHover(null);
  const [ox, oy] = viewOrigin(i);
  S.root.updateMatrixWorld();
  let best = null, bestD = 9;
  const a2 = new THREE.Vector2(), b2 = new THREE.Vector2();
  for (const L of S.liftList) {
    let prev = null;
    for (const p of L.pts) {
      _v.copy(p).applyMatrix4(S.root.matrixWorld).project(camera);
      const cur = _v.z < 1 ? b2.set(ox + (_v.x + 1) / 2 * viewW, oy + (1 - _v.y) / 2 * viewH) : null;
      if (prev && cur) {
        const dx = cur.x - prev.x, dy = cur.y - prev.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((mx - prev.x) * dx + (my - prev.y) * dy) / l2));
        const d = Math.hypot(prev.x + t * dx - mx, prev.y + t * dy - my);
        if (d < bestD) { bestD = d; best = L; }
      }
      prev = cur ? a2.copy(cur) : null;
    }
  }
  if (best) setHover(S, best, [mx, my]); else if (hover) setHover(null);
  canvas.style.cursor = best ? 'pointer' : '';
}

function buildSkirt(pos, nx, ny, floor) {
  const edge = [];
  for (let i = 0; i <= nx; i++) edge.push(i);
  for (let j = 1; j <= ny; j++) edge.push(j * (nx + 1) + nx);
  for (let i = nx - 1; i >= 0; i--) edge.push(ny * (nx + 1) + i);
  for (let j = ny - 1; j >= 0; j--) edge.push(j * (nx + 1));
  const p = new Float32Array(edge.length * 2 * 3);
  edge.forEach((k, e) => {
    p.set([pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]], e * 6);
    p.set([pos[3 * k], floor, pos[3 * k + 2]], e * 6 + 3);
  });
  const idx = [];
  for (let e = 0; e + 1 < edge.length; e++) { const a = 2 * e, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, c, b, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#5b5249', roughness: 1, side: THREE.DoubleSide }));
}

function makeLines(posArr, colArr, width, opacity = 1) {
  const g = new LineSegmentsGeometry();
  if (posArr.length) { g.setPositions(posArr); g.setColors(colArr); }
  const m = new LineMaterial({ linewidth: width, vertexColors: true, worldUnits: false, transparent: opacity < 1, opacity });
  m.resolution.set(viewW, viewH);
  lineMaterials.add(m);
  const l = new LineSegments2(g, m);
  l.renderOrder = 2;
  return l;
}

function polyArea(b, toX, toZ) {
  const ring = r => { let a = 0; for (let k = 0; k + 1 < r.length; k++) a += toX(r[k][0]) * toZ(r[k + 1][1]) - toX(r[k + 1][0]) * toZ(r[k][1]); return Math.abs(a) / 2; };
  const poly = p => ring(p[0]) - p.slice(1).reduce((s, h) => s + ring(h), 0);
  return b.t === 'Polygon' ? poly(b.c) : b.c.reduce((s, p) => s + poly(p), 0);
}

function applyVisibility() {
  sides.forEach(S => {
    if (S.runsObj) S.runsObj.visible = settings.runs;
    if (S.liftsObj) S.liftsObj.visible = settings.lifts;
    if (S.trees) S.trees.visible = settings.trees;
    if (S.buildings) S.buildings.visible = settings.town;
  });
  requestRender();
}

function applyVertical() {
  const loaded = sides.filter(S => S.resort && S.extent);
  const shared = loaded.length ? loaded.reduce((s, S) => s + S.mid, 0) / loaded.length : 0;
  sides.forEach(S => {
    const ref = settings.absElev ? shared : S.mid;
    S.root.scale.y = settings.exag;
    S.root.position.y = -ref * settings.exag;
    S.flat.position.y = -ref * settings.exag;
    if (S.placedExag !== settings.exag) { placeTrees(S.trees, settings.exag); placeBuildings(S.buildings, settings.exag); S.placedExag = settings.exag; }
  });
  requestRender();
}

// ---------- panels ----------
const fmt = (v, d = 0) => v == null || !isFinite(v) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
function renderPanel(side, r, S) {
  const p = panels[side];
  $('.pick', p).innerHTML = `<span class="nm">${esc(r.name)}</span><svg class="srch" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6"/><path d="m10.3 10.3 4 4"/></svg><small>${esc([r.region, r.countryName].filter(Boolean).join(', '))}</small>`;
  $('.pick', p).title = 'Choose another resort';
  const vert = r.top != null && r.base != null ? r.top - r.base : null;
  const rows = [
    ['Mapped runs', `${fmt(r.runKm)} km`],
    ['Lift-served vertical', `${fmt(vert)} m`],
    ['Top / base', `${fmt(r.top)} / ${fmt(r.base)} m`, 1],
    ['Lifts', fmt(r.lifts)],
  ];
  if (S?.footprint) rows.push(['Footprint (runs + lifts)', `${fmt(S.footprint[0] / 1000, 1)} × ${fmt(S.footprint[1] / 1000, 1)} km`]);
  if (S?.area) rows.push(['Mapped ski-area boundary', `${fmt(S.area / 1e6, 1)} km²`, 1]);
  if (S?.treeShare != null) rows.push(['Tree cover in view', `${fmt(S.treeShare * 100)}%`, 1]);
  if (S?.buildingCount) rows.push(['Buildings', fmt(S.buildingCount), 1]);
  if (S?.cell) rows.push(['Terrain detail', `~${fmt(S.cell)} m grid`, 1]);
  rows.push(['Size rank', `#${r.rank} of ${INDEX.length}`, 1]);
  const links = [];
  try { const u = new URL(S?.website || ''); if (/^https?:$/.test(u.protocol)) links.push(`<a class="site" href="${esc(u.href)}" target="_blank" rel="noopener">${esc(u.hostname.replace(/^www\./, ''))} ↗</a>`); } catch {}
  if (S?.osk) links.push(`<a class="site" href="https://openskimap.org/?obj=${S.osk}" target="_blank" rel="noopener">OpenSkiMap ↗</a>`);
  else if (S) links.push(`<a class="site" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent([r.name, r.region, r.countryName].filter(Boolean).join(', '))}" target="_blank" rel="noopener">Google Maps ↗</a>`);
  $('.stats', p).innerHTML = rows.map(([k, v, x]) => `<dt${x ? ' class="x"' : ''}>${k}</dt><dd${x ? ' class="x"' : ''}>${v}</dd>`).join('')
    + (links.length ? `<dd class="site-row">${links.join('')}</dd>` : '');
  updateLegend();
}

// The two elevation icons: each resort as a little peak, its height its vertical.
// "Side by side" stands both on the same baseline; "true elevation" draws them at their real heights.
// View mode: 'single' (just the first resort, full width), 'aligned' (side by side, each centred
// on its own height) or 'true' (side by side at real elevations). Remembered across visits.
function setMode(mode, refit = true) {
  const was = settings.mode;
  settings.mode = mode;
  if (mode !== 'single') settings.pairMode = mode;
  settings.absElev = mode === 'true';
  for (const [id, m] of [['#elevSingle', 'single'], ['#elevAligned', 'aligned'], ['#elevTrue', 'true']]) {
    $(id).classList.toggle('on', mode === m); $(id).setAttribute('aria-checked', String(mode === m));
  }
  stage.classList.toggle('single', mode === 'single');
  try { localStorage.setItem('sc.mode', mode); } catch {}
  updateHash();
  resize();
  applyVertical();
  if (refit && (was === 'single') !== (mode === 'single')) fitCamera();
}

// The mountain shapes from the logo, in units of peak height (peak at 0,0, base at y = 1).
const ICON_PEAKS = [
  { body: [[-19, 34], [0, 0], [9, 14], [13.5, 7], [35, 34]], snow: [[0, 0], [-5.4, 9.5], [-1.7, 7.6], [.5, 10.4], [3.3, 7.6], [5.2, 8.6]], h: 34, fill: '#4fa3ff' },
  { body: [[-22, 38], [0, 0], [24, 38]], snow: [[0, 0], [-6.2, 10.5], [-2.3, 8.5], [.4, 11.7], [3.4, 8.3], [6.4, 10.1]], h: 38, fill: '#ff8a3d' },
];
function elevIcon(aligned) {
  const r = sides.map(S => S.resort);
  const W = 32, H = 18, pad = 1;
  const lo = r.map(x => x?.base ?? 0), hi = r.map((x, i) => x?.top ?? lo[i] + 500);
  if (!aligned) {
    // keep the two clearly apart even when the resorts sit at similar heights: the higher one
    // (by mid-elevation) is lifted until its base is at least a quarter of the drawing above the other's
    const up = (lo[1] + hi[1]) / 2 > (lo[0] + hi[0]) / 2 ? 1 : 0, dn = 1 - up;
    const range = Math.max(...hi) - Math.min(...lo), need = range * 0.3 - (lo[up] - lo[dn]);
    if (need > 0) { lo[up] += need; hi[up] += need; }
  }
  let y0 = Math.min(...lo), y1 = Math.max(...hi);
  if (aligned) { y0 = 0; y1 = Math.max(hi[0] - lo[0], hi[1] - lo[1]); }
  const sy = v => H - pad - (v - y0) / Math.max(1, y1 - y0) * (H - 2 * pad);
  const mountain = (i, cx) => {
    const P = ICON_PEAKS[i];
    const yb = sy(aligned ? 0 : lo[i]), yt = Math.min(yb - 2.5, sy(aligned ? hi[i] - lo[i] : hi[i]));
    const k = (yb - yt) / P.h;
    const pts = a => a.map(([x, y]) => `${(cx + x * k).toFixed(1)},${(yt + y * k).toFixed(1)}`).join(' ');
    return `<polygon points="${pts(P.body)}" fill="${P.fill}"/>` + (k * P.h > 6 ? `<polygon points="${pts(P.snow)}" fill="#fff"/>` : '');
  };
  const base = aligned ? `<path d="M1 ${H - pad + .4} H${W - 1}" stroke="currentColor" stroke-width="1" opacity=".5"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><defs><clipPath id="ic${+aligned}"><rect width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#ic${+aligned})">${mountain(0, 11)}${mountain(1, 21)}</g>${base}</svg>`;
}
function singleIcon() {
  const W = 22, H = 18, P = ICON_PEAKS[0], k = 15.5 / P.h, cx = 9.5, yt = 1.5;
  const pts = a => a.map(([x, y]) => `${(cx + x * k).toFixed(1)},${(yt + y * k).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polygon points="${pts(P.body)}" fill="${P.fill}"/><polygon points="${pts(P.snow)}" fill="#fff"/></svg>`;
}
function updateElevIcons() {
  const A = sides[0].resort, B = sides[1].resort;
  $('#elevSingle').innerHTML = singleIcon() + '<span class="sr">Single resort</span>';
  $('#elevAligned').innerHTML = elevIcon(true) + '<span class="sr">Side by side</span>';
  $('#elevTrue').innerHTML = elevIcon(false) + '<span class="sr">True elevation</span>';
  if (A && B) $('#elevTrue').title = `True elevation: ${A.name} ${fmt(A.base)}–${fmt(A.top)} m, ${B.name} ${fmt(B.base)}–${fmt(B.top)} m`;
}

function updateLegend() {
  const convs = new Set(sides.map(S => S.resort?.conv).filter(Boolean));
  const items = [];
  const add = (c, label) => items.push(`<span><i style="background:${c}"></i>${label}</span>`);
  if (convs.has('europe') || convs.size === 0) { add(DIFF_COLORS.blue, 'Easy'); add(DIFF_COLORS.red, 'Intermediate'); }
  if (convs.has('north_america') || convs.has('japan')) { add(DIFF_COLORS.green, 'Green'); add(convs.has('japan') ? DIFF_COLORS.red : DIFF_COLORS.blue, 'Blue/red'); }
  add(DIFF_COLORS.black, 'Black'); add(DIFF_COLORS.orange, 'Freeride');
  items.push(`<span><i style="background:${LIFT_COLOR};outline:2px solid #111418"></i>Lift</span>`); add(BOUNDARY_COLOR, 'Ski-area boundary');
  add(PAL.tree, 'Trees'); add(PAL.roads.major[0], 'Roads'); add(PAL.parking, 'Parking'); add(PAL.bld3d, 'Buildings');
  $('#legend').innerHTML = items.join('');
}

// ---------- camera ----------
function fitCamera() {
  const ext = Math.max(...(settings.mode === 'single' ? sides.slice(0, 1) : sides).map(S => S.extent || 0), 2000);
  const vfov = camera.fov * DEG;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const d = (ext * 0.55) / Math.tan(Math.min(vfov, hfov) / 2);
  const phi = { '3d': 58 * DEG, top: 0.0001 }[settings.view] ?? 58 * DEG;
  const dist = settings.view === '3d' ? d * 0.85 : d;
  controls.target.set(0, 0, 0);
  camera.position.set(0, dist * Math.cos(phi), dist * Math.sin(phi));
  camera.up.set(0, 1, 0);
  controls.update();
  idle.since = performance.now(); idle.active = false;
  requestRender();
}

// ---------- idle rocking, compass, zoom ----------
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const idle = { since: performance.now(), active: false, baseAz: 0, t0: 0 };
const markActive = () => { idle.since = performance.now(); if (idle.active) { idle.active = false; } };
controls.addEventListener('start', markActive);
canvas.addEventListener('wheel', markActive, { passive: true });
canvas.addEventListener('pointerdown', markActive);
window.addEventListener('keydown', markActive);
const IDLE_MS = 4000, ROCK_AMP = 9 * DEG, ROCK_PERIOD = 14000;
const _sph = new THREE.Spherical(), _off = new THREE.Vector3();
function setAzimuth(az) {
  _off.copy(camera.position).sub(controls.target);
  _sph.setFromVector3(_off); _sph.theta = az;
  camera.position.copy(controls.target).add(_off.setFromSpherical(_sph));
  camera.lookAt(controls.target);
}
function rock(now) {
  if (reduceMotion || settings.view === 'top' || document.hidden || !sides.every(S => S.extent)) return false;
  if (now - idle.since < IDLE_MS) return false;
  if (!idle.active) { idle.active = true; idle.baseAz = controls.getAzimuthalAngle(); idle.t0 = now; }
  const t = now - idle.t0, ramp = Math.min(1, t / 4000);
  setAzimuth(idle.baseAz + ROCK_AMP * ramp * Math.sin(2 * Math.PI * t / ROCK_PERIOD));
  return true;
}
let compassAnim = null;
function animateAzimuth(to) {
  const from = controls.getAzimuthalAngle(), start = performance.now();
  let d = to - from; d = Math.atan2(Math.sin(d), Math.cos(d));
  compassAnim = now => {
    const k = Math.min(1, (now - start) / 600), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    setAzimuth(from + d * e);
    if (k >= 1) compassAnim = null;
  };
  markActive();
}
function zoomBy(f) {
  _off.copy(camera.position).sub(controls.target).multiplyScalar(f);
  camera.position.copy(controls.target).add(_off);
  markActive(); requestRender();
}
function updateCompass() {
  $('#compass .needle').style.transform = `rotate(${controls.getAzimuthalAngle() / DEG}deg)`;
}

// ---------- render ----------
let viewW = 1, viewH = 1, needRender = true, stacked = false;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  const single = settings.mode === 'single';
  stacked = !single && w < h * 0.9;  // portrait screens: one resort above the other
  stage.classList.toggle('stacked', stacked);
  if (single) { viewW = w; viewH = h; } else if (stacked) { viewW = w; viewH = Math.floor(h / 2); } else { viewW = Math.floor(w / 2); viewH = h; }
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
  lineMaterials.forEach(m => m.resolution.set(viewW, viewH));
  requestRender();
}
function requestRender() { needRender = true; }

function updateScaleBar() {
  const dist = camera.position.distanceTo(controls.target);
  const mPerPx = 2 * dist * Math.tan(camera.fov * DEG / 2) / viewH;
  const target = mPerPx * Math.min(140, viewW * 0.4);
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map(m => m * pow).find(v => v <= target) || pow;
  $('#scalebar .bar').style.width = `${nice / mPerPx}px`;
  $('#scalebar span').textContent = (nice >= 1000 ? `${nice / 1000} km` : `${nice} m`) + (settings.view === 'top' ? '' : ' (at centre)');
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  if (compassAnim) { compassAnim(now); needRender = true; }
  else if (rock(now)) needRender = true;
  if (controls.update()) needRender = true;
  if (hoverQueued) processHover();
  if (!needRender) return;
  needRender = false;
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(1, dist / 2000); camera.far = dist * 50;
  camera.updateProjectionMatrix();
  const W = stage.clientWidth, H = stage.clientHeight;
  sides.forEach((S, i) => {
    if (i === 1 && settings.mode === 'single') return;
    const x = stacked || i === 0 ? 0 : W - viewW;
    const y = !stacked || i === 1 ? 0 : H - viewH;
    renderer.setViewport(x, y, viewW, viewH);
    renderer.setScissor(x, y, viewW, viewH);
    orientLabels(S);
    layoutPlaces(S);
    renderer.render(S.scene, camera);
  });
  updateScaleBar();
  updateCompass();
}

window.skiCompare = { camera, controls, sides, settings, requestRender }; // handy for debugging from the console
frame();
init().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p style="color:#f66;padding:16px">Failed to start: ${esc(e.message)}</p>`); });
