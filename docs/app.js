import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// ---------- constants ----------
const RESORT_DIR = window.RESORT_DIR || 'data/resorts'; // the Artifact build uses single-file bundles in data/r
const EARTH_R = 6371008.8;               // mean Earth radius (m), used for local metric coordinates
const DEG = Math.PI / 180;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
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
const LIFT_COLOR = '#a743d9';
const SMALL_SCREEN = matchMedia('(pointer: coarse)').matches || innerWidth < 800;
const TEX_SIZE = SMALL_SCREEN ? 2048 : 4096;       // ground texture width (land cover + roads + parking)
const MAX_TREES = SMALL_SCREEN ? 30000 : 120000;   // per side
const BOUNDARY_COLOR = '#c9a227';

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

const settings = { exag: 3, absElev: false, runs: true, lifts: true, labels: true, trees: true, town: true, grid: true, view: '3d' };
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
  const labelLayer = document.querySelector(`.labels[data-side="${i}"]`);
  return { i, scene, root, flat, labelLayer, labels: [], resort: null, token: 0, mid: 0, extent: 0, runsObj: null, liftsObj: null };
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
  const h = new URLSearchParams(location.hash.slice(1));
  const a = byId.has(h.get('a')) ? h.get('a') : 'whistler-blackcomb';
  const b = byId.has(h.get('b')) ? h.get('b') : 'vail';
  resize();
  await Promise.all([selectResort(0, a, false), selectResort(1, b, false)]);
  fitCamera();
}

// ---------- search pickers ----------
function setupPickers() {
  document.querySelectorAll('.picker').forEach(p => {
    const side = +p.dataset.side;
    const input = $('input', p), list = $('.results', p);
    let items = [], act = 0;
    const show = () => {
      const q = norm(input.value.trim());
      const words = q.split(/\s+/).filter(Boolean);
      items = INDEX.filter(r => words.every(w => r._s.includes(w)));
      if (q) items.sort((x, y) => (norm(y.name).startsWith(q) - norm(x.name).startsWith(q)) || x.rank - y.rank);
      items = items.slice(0, 80);
      act = 0;
      list.innerHTML = items.map((r, k) => `<li role="option" data-k="${k}"${k === 0 ? ' class="act"' : ''}><span>${esc(r.name)} <span class="m">${esc(r.countryName || r.country)}</span></span><span class="m">${r.runKm} km</span></li>`).join('')
        || '<li class="m">No match</li>';
      list.classList.add('open');
    };
    const pick = k => { const r = items[k]; if (!r) return; list.classList.remove('open'); input.blur(); selectResort(side, r.id); };
    input.addEventListener('focus', () => { input.select(); show(); });
    input.addEventListener('input', show);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        act = Math.max(0, Math.min(items.length - 1, act + (e.key === 'ArrowDown' ? 1 : -1)));
        [...list.children].forEach((li, k) => li.classList.toggle('act', k === act));
        list.children[act]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); pick(act); }
      else if (e.key === 'Escape') { list.classList.remove('open'); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => {
      list.classList.remove('open');
      const r = sides[side].resort; if (r) input.value = r.name;
    }, 150));
    list.addEventListener('mousedown', e => { const li = e.target.closest('li[data-k]'); if (li) { e.preventDefault(); pick(+li.dataset.k); } });
  });
  $('#swap').addEventListener('click', () => {
    const a = sides[0].resort?.id, b = sides[1].resort?.id;
    if (a && b) Promise.all([selectResort(0, b, false), selectResort(1, a, false)]).then(fitCamera);
  });
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setupTools() {
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    settings.view = b.dataset.view; fitCamera();
  }));
  const exag = $('#exag'), exagOut = $('#exagOut');
  exag.value = settings.exag; exagOut.textContent = `${settings.exag}×`;
  exag.addEventListener('input', e => { settings.exag = +e.target.value; exagOut.textContent = `${settings.exag}×`; applyVertical(); });
  $('#showLabels').addEventListener('change', e => { settings.labels = e.target.checked; requestRender(); });
  $('#showTrees').addEventListener('change', e => { settings.trees = e.target.checked; applyVisibility(); });
  $('#showTown').addEventListener('change', e => { settings.town = e.target.checked; applyVisibility(); });
  $('#absElev').addEventListener('change', e => { settings.absElev = e.target.checked; applyVertical(); });
  $('#showRuns').addEventListener('change', e => { settings.runs = e.target.checked; applyVisibility(); });
  $('#showLifts').addEventListener('change', e => { settings.lifts = e.target.checked; applyVisibility(); });
  $('#showGrid').addEventListener('change', e => { settings.grid = e.target.checked; gridUniform.value = +settings.grid; requestRender(); });
  window.addEventListener('resize', resize);
  updateLegend();
}

// ---------- resort selection ----------
async function selectResort(side, id, refit = true) {
  const S = sides[side];
  const meta = byId.get(id);
  if (!meta) return;
  const token = ++S.token;
  $(`.picker[data-side="${side}"] input`).value = meta.name;
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
    const [landcover, features] = await Promise.all([
      loadLandcover(id).catch(err => { console.warn('no landcover', err); return null; }),
      fetch(`data/features/${id}.json`).then(r => r.ok ? r.json() : null).then(decodeFeatures).catch(() => null),
    ]);
    if (token !== S.token) return;
    setStatus(side, 'Building model…');
    await new Promise(r => setTimeout(r, 0));
    buildSide(S, data, terrain, landcover, features);
    renderPanel(side, meta, S);
    setStatus(side, '');
    applyVertical();
    if (refit) fitCamera(); else requestRender();
  } catch (err) {
    console.error(err);
    if (token === S.token) setStatus(side, 'Failed to load: ' + err.message);
  }
}

function updateHash() {
  const a = sides[0].resort?.id, b = sides[1].resort?.id;
  if (a && b) history.replaceState(null, '', `#a=${a}&b=${b}`);
}

function setStatus(side, msg) { $('.status', panels[side]).textContent = msg; }

// ---------- terrain ----------
const tileCache = new Map();
function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, (async () => {
      const res = await fetch(TILE_URL(z, x, y), { mode: 'cors' });
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

function buildSide(S, data, terrain, landcover, features) {
  for (const g of [S.root, S.flat]) for (const c of [...g.children]) { g.remove(c); disposeTree(c); }
  S.labelLayer.innerHTML = ''; S.labels = []; S.trees = null; S.buildings = null; S.placedExag = null;
  const [cx, cy] = [(data.bbox[0] + data.bbox[2]) / 2, (data.bbox[1] + data.bbox[3]) / 2];
  const kx = EARTH_R * DEG * Math.cos(cy * DEG), ky = EARTH_R * DEG;
  const toX = lon => (lon - cx) * kx, toZ = lat => -(lat - cy) * ky;
  S.project = { toX, toZ };

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
  const cValley = new THREE.Color('#7f9a7a'), cMid = new THREE.Color('#cfd6d2'), cSnow = new THREE.Color('#fbfcfd'), cRock = new THREE.Color('#8b857c');
  const nrm = geo.attributes.normal.array, tmp = new THREE.Color();
  for (let k = 0; k < vcount; k++) {
    const h = heights[k];
    const u = THREE.MathUtils.clamp((h - (base - 150)) / Math.max(300, top - base + 150), 0, 1);
    if (u < 0.35) tmp.copy(cValley).lerp(cMid, u / 0.35); else tmp.copy(cMid).lerp(cSnow, Math.min(1, (u - 0.35) / 0.4));
    const slope = Math.acos(Math.min(1, nrm[3 * k + 1])) / DEG;
    const rock = THREE.MathUtils.smoothstep(slope, 36, 48);
    if (landcover) tmp.setRGB(1, 1, 1);  // the land-cover texture supplies colour; keep only the rock tint
    tmp.lerp(cRock, rock * (landcover ? 0.6 : 0.85));
    cols[3 * k] = tmp.r; cols[3 * k + 1] = tmp.g; cols[3 * k + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false });
  const mppC = 40075016 * Math.cos(cy * DEG) / worldPx(z);  // metres per mercator pixel at this zoom
  if (landcover) {
    mat.map = paintGround(landcover, features, terrain.crop, z, (px1 - px0) * mppC);
    mat.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  mat.onBeforeCompile = shader => {
    shader.uniforms.uGrid = gridUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGridPos = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;\nuniform float uGrid;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 gp = vGridPos / 1000.0;
        vec2 gw = fwidth(gp);
        vec2 gl = abs(fract(gp - 0.5) - 0.5) / max(gw, vec2(1e-6));
        float gline = 1.0 - min(min(gl.x, gl.y), 1.0);
        gline *= 1.0 - smoothstep(0.08, 0.35, max(gw.x, gw.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.24, 0.34), gline * 0.45 * uGrid);`);
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

  const liftPos = [], liftCol = [];
  const lc = new THREE.Color(LIFT_COLOR);
  lineSets(data.lifts, (f, line) => {
    for (let k = 0; k + 1 < line.length; k++) {
      liftPos.push(...drape(line[k][0], line[k][1], 12), ...drape(line[k + 1][0], line[k + 1][1], 12));
      liftCol.push(lc.r, lc.g, lc.b, lc.r, lc.g, lc.b);
    }
  });
  S.liftsObj = makeLines(liftPos, liftCol, 2.6);
  S.root.add(S.liftsObj);
  buildLiftLabels(S, data, terrain);

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
  S.extent = Math.max((px1 - px0), (py1 - py0)) * (40075016 * Math.cos(cy * DEG) / worldPx(z));
  S.mid = ((data.top ?? hmax) + (data.base ?? hmin)) / 2;
  S.zoom = z;
  S.cell = cell;
  applyVisibility();
}

// ---------- land cover, trees, buildings ----------
// ESA WorldCover classes -> winter map colours
const LC_COLORS = {
  0: [244, 246, 248], 10: [63, 92, 66], 20: [214, 222, 214], 30: [244, 246, 248], 40: [238, 240, 242],
  50: [208, 204, 198], 60: [236, 238, 240], 70: [255, 255, 255], 80: [160, 192, 214], 90: [226, 232, 234],
  95: [80, 110, 85], 100: [238, 240, 242],
};
const ROAD_STYLE = { major: ['#8a8580', 14], minor: ['#9c9893', 8], service: ['#aaa6a1', 5] };

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
function paintGround(lc, features, crop, z, widthM) {
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
    ctx.fillStyle = '#b4b2ae';
    for (const ring of features.p || []) { ctx.beginPath(); path(ring); ctx.closePath(); ctx.fill(); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const k of ['service', 'minor', 'major']) {
      const [col, wm] = ROAD_STYLE[k];
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(k === 'major' ? 1.6 : 1, wm / mPerTexPx);
      ctx.beginPath();
      for (const line of features.r?.[k] || []) path(line);
      ctx.stroke();
    }
    ctx.fillStyle = '#7d746b';
    ctx.beginPath();
    for (const [, ring] of features.b || []) { path(ring); ctx.closePath(); }
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
  const mat = new THREE.MeshStandardMaterial({ color: '#2f4a33', roughness: 1, flatShading: true });
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#a39586', roughness: 0.9, flatShading: true }));
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

// ---------- lift labels ----------
const LIFT_ICONS = {
  chair_lift: '🪑', gondola: '🚡', cable_car: '🚠', mixed_lift: '🪑🚡', funicular: '🚞', railway: '🚞',
  't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter', drag_lift: 'Drag lift', rope_tow: 'Rope tow', magic_carpet: 'Carpet',
};
function liftLabel(f) {
  const icon = LIFT_ICONS[f.k] || 'Lift';
  let name = f.n;
  if (name && name.includes(', ')) {  // "アルペンクワッドリフト, Alpen Quad" -> prefer the latin-script part
    const latin = name.split(', ').filter(p => /^[\x00-\u024f\s'’.&()-]+$/.test(p));
    if (latin.length) name = latin[latin.length - 1];
  }
  let seats = f.o && ['chair_lift', 'gondola', 'cable_car', 'mixed_lift'].includes(f.k) ? `${f.o} ` : '';
  if (seats && name && new RegExp(`\\b${f.o}\\b`).test(name)) seats = '';  // "Skyline 2" already says it
  f = { ...f, n: name };
  const isWord = /^[A-Za-z]/.test(icon);
  if (f.n && isWord && f.n.toLowerCase().includes(icon.toLowerCase().split('-')[0].split(' ')[0])) return `${f.n}${seats ? ' ' + seats.trim() : ''}`;
  const kind = `${seats}${icon}`;
  return f.n ? `${f.n} ${kind}` : kind;
}

function buildLiftLabels(S, data, terrain) {
  const { toX, toZ } = S.project;
  for (const f of data.lifts) {
    const line = f.t === 'MultiLineString' ? f.c.flat() : f.c;
    if (!line?.length) continue;
    const a = line[0], b = line[line.length - 1];
    const ha = terrain.sample(a[0], a[1]), hb = terrain.sample(b[0], b[1]);
    const [lo, la, h] = ha > hb ? [a[0], a[1], ha] : [b[0], b[1], hb];
    const len = Math.hypot(toX(a[0]) - toX(b[0]), toZ(a[1]) - toZ(b[1]));
    const el = document.createElement('div');
    el.className = 'lift-label';
    el.textContent = liftLabel(f);
    el.title = `${f.n || 'Unnamed lift'} · ${(f.k || 'lift').replace(/_/g, ' ')}${f.o ? ` · ${f.o} per carrier` : ''} · ${Math.round(Math.abs(ha - hb))} m vertical`;
    S.labelLayer.appendChild(el);
    S.labels.push({ el, pos: new THREE.Vector3(toX(lo), h + 15, toZ(la)), len, w: 0, h: 0 });
  }
  S.labels.sort((p, q) => q.len - p.len);  // longest lifts win when labels collide
}

const _v = new THREE.Vector3();
function updateLabels(S, ox, oy) {
  if (!S.labels.length) return;
  const show = settings.lifts && settings.labels;
  S.labelLayer.style.display = show ? '' : 'none';
  if (!show) return;
  S.root.updateMatrixWorld();
  const placed = [];
  for (const L of S.labels) {
    _v.copy(L.pos).applyMatrix4(S.root.matrixWorld).project(camera);
    const x = (_v.x + 1) / 2 * viewW, y = (1 - _v.y) / 2 * viewH;
    if (_v.z > 1 || x < -50 || y < -20 || x > viewW + 50 || y > viewH + 20) { L.el.style.display = 'none'; continue; }
    if (!L.w) { L.el.style.display = ''; L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
    const r = [x - L.w / 2, y - L.h - 4, x + L.w / 2, y - 4];
    if (placed.some(p => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) { L.el.style.display = 'none'; continue; }
    placed.push(r);
    L.el.style.display = '';
    L.el.style.transform = `translate(${Math.round(ox + r[0])}px, ${Math.round(oy + r[1])}px)`;
  }
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
  $('.title', p).innerHTML = `${esc(r.name)}<small>${esc([r.region, r.countryName].filter(Boolean).join(', '))}</small>`;
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
  $('.stats', p).innerHTML = rows.map(([k, v, x]) => `<dt${x ? ' class="x"' : ''}>${k}</dt><dd${x ? ' class="x"' : ''}>${v}</dd>`).join('');
  updateLegend();
}

function updateLegend() {
  const convs = new Set(sides.map(S => S.resort?.conv).filter(Boolean));
  const items = [];
  const add = (c, label) => items.push(`<span><i style="background:${c}"></i>${label}</span>`);
  if (convs.has('europe') || convs.size === 0) { add(DIFF_COLORS.blue, 'Easy'); add(DIFF_COLORS.red, 'Intermediate'); }
  if (convs.has('north_america') || convs.has('japan')) { add(DIFF_COLORS.green, 'Green'); add(convs.has('japan') ? DIFF_COLORS.red : DIFF_COLORS.blue, 'Blue/red'); }
  add(DIFF_COLORS.black, 'Black'); add(DIFF_COLORS.orange, 'Freeride'); add(LIFT_COLOR, 'Lift'); add(BOUNDARY_COLOR, 'Ski-area boundary');
  add('#3f5c42', 'Trees'); add('#8a8580', 'Roads'); add('#b4b2ae', 'Parking'); add('#a39586', 'Buildings');
  $('#legend').innerHTML = items.join('');
}

// ---------- camera ----------
function fitCamera() {
  const ext = Math.max(...sides.map(S => S.extent || 0), 2000);
  const vfov = camera.fov * DEG;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const d = (ext * 0.55) / Math.tan(Math.min(vfov, hfov) / 2);
  const phi = { '3d': 58 * DEG, top: 0.0001, side: 86 * DEG }[settings.view];
  const dist = settings.view === '3d' ? d * 0.85 : d;
  controls.target.set(0, 0, 0);
  camera.position.set(0, dist * Math.cos(phi), dist * Math.sin(phi));
  camera.up.set(0, 1, 0);
  controls.update();
  requestRender();
}

// ---------- render ----------
let viewW = 1, viewH = 1, needRender = true, stacked = false;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  stacked = w < h * 0.9;  // portrait screens: one resort above the other
  stage.classList.toggle('stacked', stacked);
  if (stacked) { viewW = w; viewH = Math.floor(h / 2); } else { viewW = Math.floor(w / 2); viewH = h; }
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
  if (controls.update()) needRender = true;
  if (!needRender) return;
  needRender = false;
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(1, dist / 2000); camera.far = dist * 50;
  camera.updateProjectionMatrix();
  const W = stage.clientWidth, H = stage.clientHeight;
  sides.forEach((S, i) => {
    const x = stacked || i === 0 ? 0 : W - viewW;
    const y = !stacked || i === 1 ? 0 : H - viewH;
    renderer.setViewport(x, y, viewW, viewH);
    renderer.setScissor(x, y, viewW, viewH);
    renderer.render(S.scene, camera);
    updateLabels(S, x, H - y - viewH);
  });
  updateScaleBar();
}

window.skiCompare = { camera, controls, sides, settings, requestRender }; // handy for debugging from the console
frame();
init().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p style="color:#f66;padding:16px">Failed to start: ${esc(e.message)}</p>`); });
