// 3D-print export: builds a watertight relief model of one resort in the browser and downloads it as
// STL (single colour) or 3MF (single colour, or 4 / 8 colours painted for Bambu Studio, OrcaSlicer and PrusaSlicer).
// Loaded on demand from app.js when someone opens the Print dialog.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
const worldPx = z => 256 * 2 ** z;
const lon2px = (lon, z) => (lon + 180) / 360 * worldPx(z);
const lat2px = (lat, z) => { const s = Math.sin(lat * DEG); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z); };
const px2lat = (py, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / worldPx(z)))) / DEG;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- settings (remembered per browser) ----------
const KEY = 'sc.print';
const factory = viewer => ({ format: 'stl', colors: 'mono', relief: true, label: true, width: 150, exag: viewer.exag, area: 'model', base: 4 });
function loadOpts(viewer) {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  return { ...factory(viewer), ...o };
}
const saveOpts = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };

// ---------- colours ----------
// slot 0 is the ground; later slots paint over earlier ones
const RUN_HEX = { green: '#35b24f', blue: '#2a66d0', red: '#d93a2f', black: '#1b1d21' };
function palette(mode, conv) {
  if (mode === '4') return [
    { name: 'Ground', hex: '#ece9e2' }, { name: 'Forest', hex: '#2f5a35' }, { name: 'Runs', hex: '#2a66d0' }, { name: 'Lifts', hex: '#f2c230' }];
  if (mode === '8') return [
    { name: 'Ground', hex: '#ece9e2' }, { name: 'Forest', hex: '#2f5a35' }, { name: 'Water', hex: '#6fa3d6' }, { name: 'Buildings', hex: '#9a7a62' },
    { name: 'Easy runs', hex: RUN_HEX[conv.easy] || RUN_HEX.green }, { name: 'Intermediate runs', hex: RUN_HEX[conv.intermediate] || RUN_HEX.blue },
    { name: 'Advanced runs', hex: RUN_HEX.black }, { name: 'Lifts', hex: '#f2c230' }];
  return null;   // single colour, or full colour (a texture instead of slots)
}
const RUN_LEVEL = { novice: 0, easy: 0, intermediate: 1, advanced: 2, expert: 2, freeride: 2, extreme: 2 };

// ---------- the model ----------
// Returns heights (mm) on a regular grid plus a colour slot per grid point.
function buildGrid(src, o, cell) {
  const { data, terrain, landcover, features } = src;
  const z = terrain.z, crop = terrain.crop;
  let [px0, py0, px1, py1] = crop;
  if (o.area === 'ski') {   // runs and lifts plus a 20% margin
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const visit = c => { if (typeof c[0] === 'number') { const x = lon2px(c[0], z), y = lat2px(c[1], z); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } else c.forEach(visit); };
    for (const f of data.runs.concat(data.lifts)) visit(f.c);
    if (isFinite(x0)) {
      const mx = (x1 - x0) * 0.2 + 30, my = (y1 - y0) * 0.2 + 30;
      px0 = Math.max(crop[0], x0 - mx); py0 = Math.max(crop[1], y0 - my); px1 = Math.min(crop[2], x1 + mx); py1 = Math.min(crop[3], y1 + my);
    }
  }
  const spanX = px1 - px0, spanY = py1 - py0;
  const mmPerPx = o.width / Math.max(spanX, spanY);
  const nx = Math.round(spanX * mmPerPx / cell) + 1, ny = Math.round(spanY * mmPerPx / cell) + 1, N = nx * ny;
  const gx = i => px0 + i * cell / mmPerPx, gy = j => py0 + j * cell / mmPerPx;
  const H = new Float32Array(N);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const h = terrain.sampleGP(gx(i), gy(j)); H[j * nx + i] = h;
    if (h < hmin) hmin = h; if (h > hmax) hmax = h;
  }
  const mPerPx = 40075016 * Math.cos(px2lat((py0 + py1) / 2, z) * DEG) / worldPx(z);
  const mmPerM = mmPerPx / mPerPx;
  const Z0 = new Float32Array(N);
  for (let k = 0; k < N; k++) Z0[k] = (H[k] - hmin) * mmPerM * o.exag + o.base;

  // feature masks: drawn 2x oversampled on a canvas, averaged back to the grid (0..1)
  const SS = 2, W = nx * SS, Hc = ny * SS;
  const P = (lon, lat) => [(lon2px(lon, z) - px0) * mmPerPx / cell * SS + SS / 2, (lat2px(lat, z) - py0) * mmPerPx / cell * SS + SS / 2];
  const lw = mm => Math.max(1, mm / cell * SS);
  const raster = draw => {
    const cv = new OffscreenCanvas(W, Hc), g = cv.getContext('2d', { willReadFrequently: true });
    g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    draw(g);
    const px = g.getImageData(0, 0, W, Hc).data, m = new Float32Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let b = 0; b < SS; b++) for (let a = 0; a < SS; a++) s += px[4 * ((j * SS + b) * W + i * SS + a)];
      m[j * nx + i] = s / (255 * SS * SS);
    }
    return m;
  };
  const rings = (feats, fn) => { for (const f of feats) {
    if (f.t === 'LineString') fn(f, f.c);
    else if (f.t === 'MultiLineString' || f.t === 'Polygon') f.c.forEach(r => fn(f, r));
    else if (f.t === 'MultiPolygon') f.c.forEach(p => p.forEach(r => fn(f, r)));
  } };
  const path = (g, ring) => ring.forEach((c, i) => { const [x, y] = P(c[0], c[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  const runLevel = [0, 1, 2].map(level => raster(g => {
    g.lineWidth = lw(1.1); g.beginPath();
    rings(data.runs, (f, r) => { if ((RUN_LEVEL[f.d] ?? 1) === level) path(g, r); });
    g.stroke();
  }));
  const run = new Float32Array(N);
  for (let k = 0; k < N; k++) run[k] = Math.min(1, runLevel[0][k] + runLevel[1][k] + runLevel[2][k]);
  const runWide = raster(g => { g.lineWidth = lw(2.7); g.beginPath(); rings(data.runs, (f, r) => path(g, r)); g.stroke(); });
  const lift = raster(g => { g.lineWidth = lw(0.7); g.beginPath(); rings(data.lifts, (f, r) => path(g, r)); g.stroke(); });
  const bnd = data.boundary ? raster(g => { g.lineWidth = lw(0.5); g.beginPath(); rings([data.boundary], (f, r) => { path(g, r); g.closePath(); }); g.stroke(); }) : null;
  const bld = features?.b?.length ? raster(g => {
    g.beginPath();
    for (const [, ring] of features.b) { path(g, ring); g.closePath(); }
    g.fill();
  }) : null;

  // forest and water from the land-cover grid (which covers the terrain window), lightly smoothed
  const forest = new Float32Array(N), water = new Float32Array(N);
  if (landcover) {
    const raw = new Float32Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const li = Math.min(landcover.w - 1, Math.max(0, Math.floor((gx(i) - crop[0]) / (crop[2] - crop[0]) * landcover.w)));
      const lj = Math.min(landcover.h - 1, Math.max(0, Math.floor((gy(j) - crop[1]) / (crop[3] - crop[1]) * landcover.h)));
      const c = landcover.cls[lj * landcover.w + li];
      raw[j * nx + i] = c === 10 || c === 95 ? 1 : 0;
      water[j * nx + i] = c === 80 ? 1 : 0;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const jj = j + b, ii = i + a; if (jj >= 0 && jj < ny && ii >= 0 && ii < nx) { s += raw[jj * nx + ii]; n++; } }
      forest[j * nx + i] = s / n;
    }
  }

  // relief textures (mm): see the proposal doc for the sizes
  const Z = Float32Array.from(Z0);
  if (o.relief) {
    // forest: scattered trees of different sizes (jittered grid, a hash per cell), not a regular field of bumps
    const pitch = 1.35;
    const hash = (a, b, n) => { let h = Math.imul(a * 374761393 + b * 668265263 + n * 2246822519, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = i * cell, y = j * cell;
      let dz = 0;
      if (forest[k] > 0) {
        const ci = Math.floor(x / pitch), cj = Math.floor(y / pitch);
        let tree = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          const u = ci + a, v = cj + b;
          if (hash(u, v, 0) > 0.82) continue;                      // some gaps
          const tx = (u + 0.15 + 0.7 * hash(u, v, 1)) * pitch, ty = (v + 0.15 + 0.7 * hash(u, v, 2)) * pitch;
          const r = 0.42 + 0.38 * hash(u, v, 3), h = 0.25 + 0.35 * hash(u, v, 4);
          const d2 = ((x - tx) ** 2 + (y - ty) ** 2) / (r * r);
          if (d2 < 1) tree = Math.max(tree, h * (1 - d2) ** 0.7);
        }
        dz += tree * Math.min(1, forest[k] * 1.3) * Math.max(0, 1 - runWide[k] - lift[k]);
      }
      if (water[k]) dz += -0.3 + 0.12 * Math.sin(y * 2 * Math.PI / 0.8);
      if (run[k] > 0) {
        const rib = runLevel[2][k] > 0.5 && Math.sin((x + y) * 2 * Math.PI / 0.9) > 0 ? 0.18 : 0;
        dz -= run[k] * (0.6 - rib);
      }
      if (bnd) dz += 0.4 * bnd[k] * (1 - run[k]);
      let zz = Z0[k] + dz;
      if (bld && bld[k] > 0.5) zz = Math.max(zz, Z0[k] + 0.8);
      zz = Math.max(zz, Z0[k] + 1.2 * lift[k]);
      Z[k] = Math.max(0.6, zz);
    }
  }

  const text = o.label && src.name ? placeLabel({ nx, ny, cell, Z0, Z, busy: k => run[k] + lift[k] }, src.name, o.width) : null;

  // colour slot per grid point
  const pal = palette(o.colors, src.conv);
  let slot = null;
  if (pal) {
    slot = new Uint8Array(N);
    const idx = Object.fromEntries(pal.map((p, i) => [p.name, i]));
    for (let k = 0; k < N; k++) {
      let s = 0;
      if (forest[k] > 0.5) s = idx.Forest;
      if (idx.Water != null && water[k]) s = idx.Water;
      if (idx.Buildings != null && bld && bld[k] > 0.5) s = idx.Buildings;
      if (run[k] > 0.5) {
        if (idx.Runs != null) s = idx.Runs;
        else s = idx[['Easy runs', 'Intermediate runs', 'Advanced runs'][runLevel[2][k] > 0.5 ? 2 : runLevel[1][k] > 0.5 ? 1 : 0]];
      }
      if (lift[k] > 0.5) s = idx.Lifts;
      if (text && text[k] > 0.5) s = idx['Advanced runs'] ?? idx.Runs;
      slot[k] = s;
    }
  }
  let zmax = 0; for (let k = 0; k < N; k++) if (Z[k] > zmax) zmax = Z[k];
  return { nx, ny, cell, Z, slot, pal, size: [(nx - 1) * cell, (ny - 1) * cell, zmax], scale: 1000 / mmPerM,
    region: { z, px0, py0, px1, py1, mmPerPx }, nameBox: text?.box || null };
}

// The resort's name, raised 1 mm, in the flattest low-lying spot that no run or lift crosses (usually a valley floor).
// Smooths away the textures under it so the letters read. Returns the letter mask (0..1 per grid point).
function placeLabel(g, name, width) {
  const { nx, ny, cell, Z0, Z, busy } = g;
  let fs = Math.max(4, width * 0.045) / cell;                    // letter height in cells
  const font = px => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const meas = new OffscreenCanvas(8, 8).getContext('2d');
  meas.font = font(100);
  const per100 = meas.measureText(name).width / 100;
  fs = Math.min(fs, nx * 0.8 / Math.max(1, per100));               // long names get smaller letters
  const bw = Math.ceil(per100 * fs + fs * 0.8), bh = Math.ceil(fs * 1.6);
  const margin = Math.ceil(2 / cell);
  if (bw + 2 * margin >= nx || bh + 2 * margin >= ny) return null;
  let zlo = Infinity, zhi = -Infinity;
  for (let k = 0; k < Z0.length; k++) { if (Z0[k] < zlo) zlo = Z0[k]; if (Z0[k] > zhi) zhi = Z0[k]; }
  const step = Math.max(1, Math.round(fs / 3)), sub = Math.max(1, Math.round(fs / 5));
  let best = null;
  for (let j0 = margin; j0 + bh < ny - margin; j0 += step) for (let i0 = margin; i0 + bw < nx - margin; i0 += step) {
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0, hit = 0;
    for (let j = j0; j <= j0 + bh; j += sub) for (let i = i0; i <= i0 + bw; i += sub) {
      const k = j * nx + i, v = Z0[k];
      if (v < lo) lo = v; if (v > hi) hi = v; sum += v; n++; hit += busy(k) > 0.3 ? 1 : 0;
    }
    const score = (hi - lo) + 0.5 * (sum / n - zlo) + 25 * hit / n;   // flat, low, clear of runs and lifts
    if (!best || score < best.score) best = { score, i0, j0, lo, hi };
  }
  if (!best) return null;
  const SS = 3, cv = new OffscreenCanvas(bw * SS, bh * SS), x = cv.getContext('2d', { willReadFrequently: true });
  x.font = font(fs * SS); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(name, bw * SS / 2, bh * SS / 2 + fs * SS * 0.05);
  const px = x.getImageData(0, 0, bw * SS, bh * SS).data, mask = new Float32Array(Z.length);
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    let a = 0;
    for (let b = 0; b < SS; b++) for (let c = 0; c < SS; c++) a += px[4 * ((j * SS + b) * bw * SS + i * SS + c) + 3];
    a /= 255 * SS * SS;
    const k = (best.j0 + j) * nx + best.i0 + i;
    mask[k] = a;
    // no textures around the letters; the letters follow the ground 1 mm proud of it
    Z[k] = Z0[k] + 1.0 * a;
  }
  mask.box = { x: (best.i0 + bw / 2) * cell, y: (best.j0 + bh / 2) * cell, size: fs * cell };
  return mask;
}

// Watertight mesh: top surface, four walls down to z=0, a flat bottom; outward-facing triangles.
function buildMesh(G) {
  const { nx, ny, cell, Z } = G, N = nx * ny;
  const pos = new Float32Array(N * 2 * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = i * cell, y = (ny - 1 - j) * cell;   // north up
    pos.set([x, y, Z[k]], 3 * k); pos.set([x, y, 0], 3 * (N + k));
  }
  const nTop = (nx - 1) * (ny - 1) * 2;
  const loop = [];
  for (let i = 0; i < nx; i++) loop.push(i);
  for (let j = 1; j < ny; j++) loop.push(j * nx + nx - 1);
  for (let i = nx - 2; i >= 0; i--) loop.push((ny - 1) * nx + i);
  for (let j = ny - 2; j > 0; j--) loop.push(j * nx);
  loop.push(0);
  loop.reverse();   // run the rim the opposite way to the top surface's own boundary edges
  const nWall = (loop.length - 1) * 2, nBot = loop.length - 3;
  const tri = new Uint32Array((nTop + nWall + nBot) * 3);
  let t = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    tri[t++] = a; tri[t++] = c; tri[t++] = b; tri[t++] = b; tri[t++] = c; tri[t++] = d;
  }
  for (let k = 0; k + 1 < loop.length; k++) {
    const p = loop[k], q = loop[k + 1];
    tri[t++] = q; tri[t++] = p; tri[t++] = p + N; tri[t++] = q; tri[t++] = p + N; tri[t++] = q + N;
  }
  for (let k = 1; k < loop.length - 2; k++) { tri[t++] = loop[0] + N; tri[t++] = loop[k + 1] + N; tri[t++] = loop[k] + N; }
  // flip everything if the volume came out negative (mirror from the north-up flip)
  let vol = 0;
  for (let f = 0; f < tri.length; f += 3) {
    const a = 3 * tri[f], b = 3 * tri[f + 1], c = 3 * tri[f + 2];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let f = 0; f < tri.length; f += 3) { const x = tri[f + 1]; tri[f + 1] = tri[f + 2]; tri[f + 2] = x; }
  return { pos, tri, nTop };
}

// ---------- writers ----------
function toSTL(M, name) {
  const { pos, tri } = M, n = tri.length / 3;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const head = new TextEncoder().encode(`Slope Spy: ${name}`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let f = 0; f < tri.length; f += 3) {
    const a = 3 * tri[f], b = 3 * tri[f + 1], c = 3 * tri[f + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
    for (const v of [a, b, c]) { dv.setFloat32(o, pos[v], true); dv.setFloat32(o + 4, pos[v + 1], true); dv.setFloat32(o + 8, pos[v + 2], true); o += 12; }
    o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

// Bambu Studio / OrcaSlicer (paint_color) and PrusaSlicer (mmu_segmentation) store a painted facet's filament
// as a reversed hex string: filament 1 -> "4", 2 -> "8", 3 -> "0C", 4 -> "1C", ...
const paintCode = s => s < 3 ? (s << 2).toString(16).toUpperCase() : (s - 3).toString(16).toUpperCase() + 'C';

async function to3MF(M, G, name) {
  const { pos, tri, nTop } = M, { slot, pal, nx } = G;
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n`);
  parts.push(`<metadata name="Title">${esc(name)}</metadata>\n<metadata name="Application">Slope Spy</metadata>\n<resources>\n`);
  if (pal) parts.push('<basematerials id="1">' + pal.map(p => `<base name="${esc(p.name)}" displaycolor="${p.hex.toUpperCase()}FF"/>`).join('') + '</basematerials>\n');
  parts.push(`<object id="2" type="model"${pal ? ' pid="1" pindex="0"' : ''}><mesh><vertices>\n`);
  let chunk = '';
  for (let v = 0; v < pos.length; v += 3) {
    chunk += `<vertex x="${pos[v].toFixed(3)}" y="${pos[v + 1].toFixed(3)}" z="${pos[v + 2].toFixed(3)}"/>`;
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk, '\n</vertices><triangles>\n'); chunk = '';
  for (let f = 0, k = 0; f < tri.length; f += 3, k++) {
    let attr = '';
    if (pal) {
      const s = k < nTop ? slot[tri[f]] : 0;   // top faces take the colour of their first corner; walls and base are slot 0
      attr = ` pid="1" p1="${s}"` + (s ? ` paint_color="${paintCode(s + 1)}" slic3rpe:mmu_segmentation="${paintCode(s + 1)}"` : '');
    }
    chunk += `<triangle v1="${tri[f]}" v2="${tri[f + 1]}" v3="${tri[f + 2]}"${attr}/>`;
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk, '\n</triangles></mesh></object>\n</resources>\n<build><item objectid="2"/></build>\n</model>\n');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', parts],
  ];
  return zip(files, 'model/3mf');
}

// minimal ZIP writer (deflate via CompressionStream where available, else stored)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes, crc = 0xFFFFFFFF) { for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8); return crc; }
async function zip(files, type) {
  const enc = new TextEncoder(), out = [], central = [];
  let offset = 0;
  for (const [name, content, store] of files) {
    const chunks = content instanceof Blob ? [new Uint8Array(await content.arrayBuffer())] : (Array.isArray(content) ? content : [content]).map(s => enc.encode(s));
    let crc = 0xFFFFFFFF, size = 0;
    for (const c of chunks) { crc = crc32(c, crc); size += c.length; }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    let data = new Blob(chunks), method = 0;
    if (!store && typeof CompressionStream !== 'undefined') {
      data = await new Response(data.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob(); method = 8;
    }
    const nm = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, method, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.size, true); local.setUint32(22, size, true); local.setUint16(26, nm.length, true);
    out.push(local.buffer, nm, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(10, method, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.size, true); cen.setUint32(24, size, true); cen.setUint16(28, nm.length, true); cen.setUint32(42, offset, true);
    central.push(cen.buffer, nm);
    offset += 30 + nm.length + data.size;
  }
  const cenSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...out, ...central, end.buffer], { type });
}

// ---------- full colour: the main view baked into a texture ----------
// The ground texture the viewer shows (land cover, roads, shading), then runs, boundary, lifts, lift names,
// peak and place names and the resort's name, drawn flat at print scale. Text sizes are in millimetres on the print.
const TEX_BASE = '#5e5850';   // walls and base
async function bakeTexture(src, G, maxPx) {
  const { z, px0, py0, px1, py1, mmPerPx } = G.region;
  const spanX = px1 - px0, spanY = py1 - py0;
  const scale = maxPx / Math.max(spanX, spanY);                  // texture px per mercator px
  const W = Math.round(spanX * scale), H = Math.round(spanY * scale);
  const pxPerMM = scale / mmPerPx;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H + 8;   // + a strip of base colour
  const g = cv.getContext('2d');
  g.fillStyle = TEX_BASE; g.fillRect(0, 0, W, H + 8);
  const crop = src.terrain.crop;
  if (src.ground) {
    const gw = src.ground.width, gh = src.ground.height;
    const sx = (px0 - crop[0]) / (crop[2] - crop[0]) * gw, sy = (py0 - crop[1]) / (crop[3] - crop[1]) * gh;
    const sw = spanX / (crop[2] - crop[0]) * gw, sh = spanY / (crop[3] - crop[1]) * gh;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src.ground, sx, sy, sw, sh, 0, 0, W, H);
  } else { g.fillStyle = '#c2bcae'; g.fillRect(0, 0, W, H); }
  // what the viewer adds in its shader: grey rock on steep slopes, contour lines every 20 m and 100 m
  {
    const mPerTex = mmPerPx / (1000 / G.scale) / scale;          // ground metres per texture pixel
    const tp = src.terrain.sampleGP, inv = 1 / scale;
    const img = g.getImageData(0, 0, W, H), d = img.data;
    const rock = [0x9b, 0x95, 0x8b], cc = [0.30, 0.27, 0.22].map(v => v * 255);
    const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    let prev = new Float32Array(W + 1), cur = new Float32Array(W + 1);
    for (let i = 0; i <= W; i++) prev[i] = tp(px0 + i * inv, py0);
    for (let y = 0; y < H; y++) {
      for (let i = 0; i <= W; i++) cur[i] = tp(px0 + i * inv, py0 + (y + 1) * inv);
      for (let x = 0; x < W; x++) {
        const h = (prev[x] + prev[x + 1] + cur[x] + cur[x + 1]) / 4;
        const gx = (prev[x + 1] - prev[x] + cur[x + 1] - cur[x]) / 2, gy = (cur[x] - prev[x] + cur[x + 1] - prev[x + 1]) / 2;
        const grad = Math.hypot(gx, gy);                            // metres of height per texture pixel
        const slope = Math.atan(grad / mPerTex) * 57.2958;
        const r = sstep(36, 48, slope) * 0.75;
        // anti-aliased contour lines about 0.12 mm (100 m) and 0.08 mm (20 m) wide on the print
        const line = (step, wmm) => {
          const wpx = wmm * pxPerMM, dist = Math.abs(((h / step) % 1 + 1.5) % 1 - 0.5) * step / Math.max(grad, 1e-6);
          return Math.max(0, Math.min(1, wpx / 2 + 0.5 - dist));
        };
        const sp20 = 20 / Math.max(grad, 1e-6) / pxPerMM, sp100 = sp20 * 5;   // line spacing in mm
        const c = Math.max(line(20, 0.08) * 0.10 * (1 - sstep(0.25, 0.6, 1 / sp20)), line(100, 0.12) * 0.22 * (1 - sstep(0.3, 0.8, 1 / sp100)));
        const k = 4 * (y * W + x);
        for (let ch = 0; ch < 3; ch++) { let v = d[k + ch] * (1 - r) + d[k + ch] * rock[ch] / 255 * r; d[k + ch] = v * (1 - c) + cc[ch] * c; }
      }
      [prev, cur] = [cur, prev];
    }
    g.putImageData(img, 0, 0);
  }
  const P = (lon, lat) => [(lon2px(lon, z) - px0) * scale, (lat2px(lat, z) - py0) * scale];
  const mm = v => v * pxPerMM;
  const rings = (feats, fn) => { for (const f of feats) {
    if (f.t === 'LineString') fn(f, f.c);
    else if (f.t === 'MultiLineString' || f.t === 'Polygon') f.c.forEach(r => fn(f, r));
    else if (f.t === 'MultiPolygon') f.c.forEach(p => p.forEach(r => fn(f, r)));
  } };
  const path = ring => { g.beginPath(); ring.forEach((c, i) => { const [x, y] = P(c[0], c[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
  g.lineCap = 'round'; g.lineJoin = 'round';
  const { data } = src, conv = src.conv;
  if (data.boundary) { g.strokeStyle = '#c27ff0'; g.lineWidth = mm(0.35); rings([data.boundary], (f, r) => { path(r); g.closePath(); g.stroke(); }); }
  const RUNC = { green: '#2fa354', blue: '#2f6fd6', red: '#d93a2f', black: '#15181c', orange: '#f08c1a', grey: '#7d8790' };
  g.lineWidth = mm(0.45);
  rings(data.runs, (f, r) => { g.strokeStyle = RUNC[conv[f.d] || ({ freeride: 'orange', extreme: 'orange' }[f.d]) || 'grey']; path(r); g.stroke(); });
  for (const [col, w] of [['#111418', 0.75], ['#ffd23f', 0.4]]) { g.strokeStyle = col; g.lineWidth = mm(w); rings(data.lifts, (f, r) => { path(r); g.stroke(); }); }
  g.fillStyle = '#111418';
  rings(data.lifts, (f, r) => { for (const c of [r[0], r[r.length - 1]]) { const [x, y] = P(c[0], c[1]); g.beginPath(); g.arc(x, y, mm(0.45), 0, 7); g.fill(); } });
  g.fillStyle = '#fff4c2';
  rings(data.lifts, (f, r) => { for (const c of [r[0], r[r.length - 1]]) { const [x, y] = P(c[0], c[1]); g.beginPath(); g.arc(x, y, mm(0.25), 0, 7); g.fill(); } });

  // lift names inline on the lift, never upside down (the viewer's own label artwork)
  const taken = [];
  const free = b => !taken.some(t => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
  if (src.labelCanvas) {
    const labs = [];
    for (const f of data.lifts) {
      const line = f.t === 'MultiLineString' ? f.c.flat() : f.c;
      if (!f.n || !line || line.length < 2) continue;
      const [ax, ay] = P(...line[0]), [bx, by] = P(...line[line.length - 1]);
      const len = Math.hypot(bx - ax, by - ay);
      const lab = src.labelCanvas(f);
      let h = mm(2.2), w = h * lab.aspect;
      if (w > len * 0.85) { h = len * 0.85 / lab.aspect; w = h * lab.aspect; }
      if (h < mm(1.1)) continue;
      let ang = Math.atan2(by - ay, bx - ax);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      labs.push({ lab, x: (ax + bx) / 2, y: (ay + by) / 2, w, h, ang });
    }
    await Promise.all(labs.map(l => l.lab.ready));
    for (const l of labs) {
      l.lab.redraw();
      g.save(); g.translate(l.x, l.y); g.rotate(l.ang); g.drawImage(l.lab.c, -l.w / 2, -l.h / 2, l.w, l.h); g.restore();
      const ex = Math.abs(Math.cos(l.ang)) * l.w / 2 + Math.abs(Math.sin(l.ang)) * l.h / 2, ey = Math.abs(Math.sin(l.ang)) * l.w / 2 + Math.abs(Math.cos(l.ang)) * l.h / 2;
      taken.push({ x0: l.x - ex, x1: l.x + ex, y0: l.y - ey, y1: l.y + ey });
    }
  }
  // peaks and places, most important first, skipping any that would overlap
  const font = (wt, px, it = '') => `${it}${wt} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const text = (t, x, y, f, fill) => { g.font = f; g.lineWidth = mm(0.5); g.strokeStyle = 'rgba(255,255,255,.9)'; g.strokeText(t, x, y); g.fillStyle = fill; g.fillText(t, x, y); };
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const short = n => n.split(' / ')[0];
  const items = [];
  const ps = src.places || {};
  for (const [n, lon, lat, rank] of ps.v || []) items.push({ pri: rank === 3 ? 3 : rank, lon, lat, kind: 'place', n: rank === 3 ? short(n).toUpperCase() : short(n), rank });
  (ps.k || []).forEach(([n, lon, lat, ele], i) => items.push({ pri: 2.5 + i / 1000, lon, lat, kind: 'peak', n: short(n), ele }));
  items.sort((a, b) => a.pri - b.pri);
  const SZ = [3.4, 3.0, 2.6, 1.9];
  for (const it of items) {
    const [x, y] = P(it.lon, it.lat);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    if (it.kind === 'place') {
      const px = mm(SZ[it.rank]); const f = font(it.rank === 3 ? 500 : 650, px, it.rank === 3 ? 'italic ' : '');
      g.font = f; const w = g.measureText(it.n).width;
      const b = { x0: x - w / 2, x1: x + w / 2, y0: y - px * 0.6, y1: y + px * 0.6 };
      if (b.x0 < 0 || b.x1 > W || !free(b)) continue;
      text(it.n, x, y, f, it.rank === 3 ? '#4a4a4a' : '#222'); taken.push(b);
    } else {
      const px = mm(2.1), e = it.ele != null ? `${it.ele.toLocaleString()} m` : '';
      g.font = font(600, px); const w = Math.max(g.measureText(it.n).width, e ? g.measureText(e).width * 0.85 : 0);
      const b = { x0: x - w / 2, x1: x + w / 2, y0: y - mm(1), y1: y + mm(1) + px * (e ? 2.2 : 1.2) };
      if (b.x0 < 0 || b.x1 > W || b.y1 > H || !free(b)) continue;
      g.fillStyle = '#4b3b2c'; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = mm(0.3);
      g.beginPath(); g.moveTo(x, y - mm(0.8)); g.lineTo(x + mm(0.8), y + mm(0.6)); g.lineTo(x - mm(0.8), y + mm(0.6)); g.closePath(); g.stroke(); g.fill();
      text(it.n, x, y + mm(0.9) + px * 0.6, font(600, px), '#4b3b2c');
      if (e) text(e, x, y + mm(0.9) + px * 1.65, font(500, px * 0.85), '#6b5a48');
      taken.push(b);
    }
  }
  // the resort's name (raised on the print) in dark ink
  if (G.nameBox) {
    const b = G.nameBox;
    g.font = font(700, b.size * W / G.size[0]);
    g.fillStyle = '#15181c';
    g.fillText(src.name, b.x * W / G.size[0], b.y * H / G.size[1] + b.size * H / G.size[1] * 0.05);
  }
  return { canvas: cv, W, H };
}
// UV for grid point (i, j): u across, v up (texture row 0 is the north edge); walls and base use the base-colour strip
const uvOf = (G, T) => {
  const uv = new Float32Array(G.nx * G.ny * 2), tot = T.H + 8;
  for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
    const k = j * G.nx + i;
    uv[2 * k] = (i / (G.nx - 1) * (T.W - 1) + 0.5) / T.W;
    uv[2 * k + 1] = 1 - (j / (G.ny - 1) * (T.H - 1) + 0.5) / tot;
  }
  return { uv, base: [0.5, 1 - (T.H + 4) / tot] };
};
const pngOf = canvas => new Promise(res => canvas.toBlob(res, 'image/png'));

async function to3MFTextured(M, G, T, name) {
  const { pos, tri, nTop } = M, N = G.nx * G.ny, { uv, base } = uvOf(G, T);
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n`);
  parts.push(`<metadata name="Title">${esc(name)}</metadata>\n<metadata name="Application">Slope Spy</metadata>\n<resources>\n`);
  parts.push('<m:texture2d id="3" path="/3D/Textures/map.png" contenttype="image/png" tilestyleu="clamp" tilestylev="clamp" filter="linear"/>\n<m:texture2dgroup id="4" texid="3">');
  let chunk = '';
  for (let k = 0; k < N; k++) { chunk += `<m:tex2coord u="${uv[2 * k].toFixed(5)}" v="${uv[2 * k + 1].toFixed(5)}"/>`; if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; } }
  chunk += `<m:tex2coord u="${base[0]}" v="${base[1].toFixed(5)}"/>`;
  parts.push(chunk, '</m:texture2dgroup>\n<object id="2" type="model" pid="4" pindex="' + N + '"><mesh><vertices>\n'); chunk = '';
  for (let v = 0; v < pos.length; v += 3) { chunk += `<vertex x="${pos[v].toFixed(3)}" y="${pos[v + 1].toFixed(3)}" z="${pos[v + 2].toFixed(3)}"/>`; if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; } }
  parts.push(chunk, '\n</vertices><triangles>\n'); chunk = '';
  for (let f = 0, k = 0; f < tri.length; f += 3, k++) {
    const a = tri[f], b = tri[f + 1], c = tri[f + 2];
    chunk += k < nTop ? `<triangle v1="${a}" v2="${b}" v3="${c}" pid="4" p1="${a}" p2="${b}" p3="${c}"/>` : `<triangle v1="${a}" v2="${b}" v3="${c}" pid="4" p1="${N}"/>`;
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk, '\n</triangles></mesh></object>\n</resources>\n<build><item objectid="2"/></build>\n</model>\n');
  const png = await pngOf(T.canvas);
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodeltexture"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/_rels/3dmodel.model.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/Textures/map.png" Id="tex0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/></Relationships>'],
    ['3D/3dmodel.model', parts],
    ['3D/Textures/map.png', png, true],
  ], 'model/3mf');
}

// OBJ + MTL + PNG in a zip (GrabCAD Print, most colour-printing services)
async function toOBJ(M, G, T, base) {
  const { pos, tri, nTop } = M, N = G.nx * G.ny, { uv, base: bv } = uvOf(G, T);
  const parts = [`# ${base} · Slope Spy · millimetres\nmtllib ${base}.mtl\nusemtl map\n`];
  let chunk = '';
  for (let v = 0; v < pos.length; v += 3) { chunk += `v ${pos[v].toFixed(3)} ${pos[v + 1].toFixed(3)} ${pos[v + 2].toFixed(3)}\n`; if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; } }
  for (let k = 0; k < N; k++) { chunk += `vt ${uv[2 * k].toFixed(5)} ${uv[2 * k + 1].toFixed(5)}\n`; if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; } }
  chunk += `vt ${bv[0]} ${bv[1].toFixed(5)}\n`;
  for (let f = 0, k = 0; f < tri.length; f += 3, k++) {
    const a = tri[f] + 1, b = tri[f + 1] + 1, c = tri[f + 2] + 1;
    chunk += k < nTop ? `f ${a}/${a} ${b}/${b} ${c}/${c}\n` : `f ${a}/${N + 1} ${b}/${N + 1} ${c}/${N + 1}\n`;
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  const mtl = `newmtl map\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 1\nmap_Kd ${base}.png\n`;
  return zip([[`${base}.obj`, parts], [`${base}.mtl`, mtl], [`${base}.png`, await pngOf(T.canvas), true]], 'application/zip');
}

// ---------- dialog ----------
let dlg = null, view = null;
const PREVIEW_CELLS = 480;   // grid points along the long side for the live preview
const MAX_CELLS = 900;       // and for the download (0.25 mm at 150-225 mm)
const SMALL = matchMedia('(pointer: coarse)').matches || innerWidth < 800;
const PREVIEW_TEX = SMALL ? 1024 : 2048;   // full-colour texture, long side
const fullTex = width => Math.min(SMALL ? 4096 : 8192, Math.ceil(width * 25));   // ~25 px/mm, a little past PolyJet's ~600 dpi

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('div');
  dlg.id = 'print'; dlg.className = 'sheet modal'; dlg.hidden = true;
  dlg.innerHTML = `
  <div class="sheet-card print-card" role="dialog" aria-modal="true" aria-labelledby="printTitle">
    <div class="sheet-head"><h2 id="printTitle">3D print</h2><button class="btn icon" data-close aria-label="Close">✕</button></div>
    <div class="print-body">
      <div class="print-preview"><canvas></canvas><div class="print-busy" hidden>Building…</div></div>
      <p class="print-info"></p>
      <form class="print-form">
        <fieldset><legend>Format</legend>
          <label><input type="radio" name="format" value="stl"> STL</label>
          <label><input type="radio" name="format" value="3mf"> 3MF</label>
          <label><input type="radio" name="format" value="obj"> OBJ <span class="muted">zip</span></label></fieldset>
        <fieldset><legend>Colors</legend>
          <label><input type="radio" name="colors" value="mono"> Single color</label>
          <label><input type="radio" name="colors" value="4"> 4 colors</label>
          <label><input type="radio" name="colors" value="8"> 8 colors</label>
          <label><input type="radio" name="colors" value="full"> Full color</label></fieldset>
        <fieldset class="wide"><label class="check"><input type="checkbox" name="relief"> Relief textures <span class="muted">forest bumps, engraved runs, raised lifts, buildings and boundary</span></label>
          <label class="check"><input type="checkbox" name="label"> Resort name <span class="muted">raised 1 mm, following the ground in a low spot</span></label></fieldset>
        <fieldset><legend>Width</legend><select name="width">${[100, 150, 200, 250].map(v => `<option value="${v}">${v} mm</option>`).join('')}</select></fieldset>
        <fieldset><legend>Vertical</legend><select name="exag">${[1, 1.5, 2, 3].map(v => `<option value="${v}">${v}×</option>`).join('')}</select></fieldset>
        <fieldset><legend>Base</legend><select name="base">${[2, 4, 6, 10].map(v => `<option value="${v}">${v} mm</option>`).join('')}</select></fieldset>
        <fieldset><legend>Area</legend>
          <label><input type="radio" name="area" value="model"> Whole model</label>
          <label><input type="radio" name="area" value="ski"> Ski area only</label></fieldset>
      </form>
      <div class="print-legend"></div>
    </div>
    <div class="print-foot"><button class="btn" data-reset>Reset</button><span class="print-note muted"></span><button class="btn primary" data-go>Download</button></div>
  </div>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.hidden = true; };
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) close(); });
  return dlg;
}

function readForm(form) {
  const pick = n => form.querySelector(`[name="${n}"]:checked`)?.value;   // (disabled radios still count)
  const format = pick('format');
  const colors = format === '3mf' && form.dataset.format === '3mf' ? pick('colors') || 'mono' : form.dataset.colors || 'mono';
  return { format, colors, relief: form.relief.checked, label: form.label.checked, width: +form.width.value, exag: +form.exag.value, base: +form.base.value, area: pick('area') };
}
// STL carries no colour, so it always prints single-colour (the colour choice is kept for when 3MF is picked again)
// OBJ is for full-colour printers (Stratasys PolyJet, HP MJF, Mimaki), so it always carries the texture
const effective = o => o.format === 'stl' ? { ...o, colors: 'mono' } : o.format === 'obj' ? { ...o, colors: 'full' } : o;
function writeForm(form, o) {
  form.dataset.colors = o.colors;   // the 3MF colour choice, kept while STL or OBJ force their own
  form.dataset.format = o.format;
  for (const k of ['format', 'colors', 'area']) { const el = form.querySelector(`[name="${k}"][value="${o[k]}"]`); if (el) el.checked = true; }
  form.relief.checked = o.relief; form.label.checked = o.label;
  for (const k of ['width', 'exag', 'base']) form[k].value = String(o[k]);
  for (const el of form.querySelectorAll('[name="colors"]')) el.disabled = o.format === 'stl' || (o.format === 'obj' && el.value !== 'full');
  { const el = form.querySelector(`[name="colors"][value="${effective(o).colors}"]`); if (el) el.checked = true; }
  form.querySelector('[name="colors"]').closest('fieldset').classList.toggle('off', o.format === 'stl');
}

function setupView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1b2129');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-1, 0.9, 0.6); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const v = { renderer, scene, camera, controls, mesh: null, raf: 0 };
  const loop = () => { v.raf = requestAnimationFrame(loop); if (dlg.hidden) return; controls.update(); renderer.render(scene, camera); };
  loop();
  return v;
}
function showPreview(G, o, refit, T) {
  const M = buildMesh(G);
  const geo = new THREE.BufferGeometry();
  // three.js is y-up: model x -> x, model z (height) -> y, model y (north) -> -z
  const p = new Float32Array(M.pos.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = M.pos[i] - G.size[0] / 2; p[i + 1] = M.pos[i + 2]; p[i + 2] = -(M.pos[i + 1] - G.size[1] / 2); }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setIndex(new THREE.BufferAttribute(M.tri, 1));
  geo.computeVertexNormals();
  let mat;
  if (T) {
    const { uv, base } = uvOf(G, T), N = G.nx * G.ny, u2 = new Float32Array(N * 4);
    u2.set(uv); for (let k = N; k < 2 * N; k++) { u2[2 * k] = base[0]; u2[2 * k + 1] = base[1]; }
    geo.setAttribute('uv', new THREE.BufferAttribute(u2, 2));
    const tex = new THREE.CanvasTexture(T.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = true;
    tex.anisotropy = view.renderer.capabilities.getMaxAnisotropy();
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  } else if (G.pal) {
    const cols = G.pal.map(c => new THREE.Color(c.hex)), N = G.nx * G.ny, col = new Float32Array(p.length);
    for (let k = 0; k < N * 2; k++) { const c = k < N ? cols[G.slot[k]] : cols[0]; col.set([c.r, c.g, c.b], 3 * k); }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  } else mat = new THREE.MeshStandardMaterial({ color: '#d9d6cf', roughness: 0.6 });
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.map?.dispose(); view.mesh.material.dispose(); }
  view.mesh = new THREE.Mesh(geo, mat);
  view.scene.add(view.mesh);
  if (refit) {
    const r = Math.max(G.size[0], G.size[1]);
    view.controls.target.set(0, G.size[2] * 0.35, 0);
    view.camera.position.set(-r * 0.15, r * 0.85, r * 1.25);
    view.camera.near = r / 100; view.camera.far = r * 20; view.camera.updateProjectionMatrix();
  }
}

export function openPrint({ S, viewer }) {
  ensureDialog();
  const form = dlg.querySelector('form'), canvas = dlg.querySelector('canvas'), info = dlg.querySelector('.print-info');
  const legend = dlg.querySelector('.print-legend'), busy = dlg.querySelector('.print-busy'), note = dlg.querySelector('.print-note');
  const r = S.resort, src = { ...S.src, name: r.name };
  dlg.querySelector('#printTitle').textContent = `3D print: ${r.name}`;
  let o = loadOpts(viewer);
  writeForm(form, o);
  dlg.hidden = false;
  view ??= setupView(canvas);
  window.skiPrint = view;   // debugging
  const sizeCanvas = () => {
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
    view.renderer.setSize(w, h, false); view.camera.aspect = w / h; view.camera.updateProjectionMatrix();
  };
  sizeCanvas();
  if (!view.ro) { view.ro = new ResizeObserver(sizeCanvas); view.ro.observe(canvas.parentElement); }
  let lastKey = '', timer = 0, updSeq = 0;
  const update = (refit = false) => {
    o = readForm(form); writeForm(form, o); saveOpts(o);
    const key = JSON.stringify([r.id, effective(o).colors, o.relief, o.label, o.width, o.exag, o.base, o.area]);
    if (key === lastKey && !refit) return;
    const areaChanged = !lastKey || JSON.parse(lastKey)[7] !== o.area || JSON.parse(lastKey)[4] !== o.width;
    lastKey = key;
    busy.hidden = false;
    clearTimeout(timer);
    const seq = ++updSeq;
    timer = setTimeout(async () => {
      const eo = effective(o);
      const G = buildGrid(src, eo, Math.max(0.25, o.width / PREVIEW_CELLS));
      const T = eo.colors === 'full' ? await bakeTexture(src, G, PREVIEW_TEX) : null;
      if (seq !== updSeq) return;
      showPreview(G, o, refit || areaChanged, T);
      const full = Math.max(0.25, o.width / MAX_CELLS);
      const cells = Math.round(G.size[0] / full + 1) * Math.round(G.size[1] / full + 1);
      const tris = cells * 2 + 4 * Math.sqrt(cells) * 2;
      const mb = o.format === 'stl' ? tris * 50 / 1e6 : eo.colors === 'full' ? tris * 16 / 1e6 + 12 : tris * (eo.colors === 'mono' ? 14 : 18) / 1e6;
      info.textContent = `${Math.round(G.size[0])} × ${Math.round(G.size[1])} mm, ${Math.round(G.size[2])} mm tall · scale 1:${(Math.round(G.scale / 100) * 100).toLocaleString()} · about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
      legend.innerHTML = G.pal ? G.pal.map((p, i) => `<span><i style="background:${p.hex}"></i>${i + 1} ${esc(p.name)}</span>`).join('') : '';
      note.textContent = eo.colors === 'full' ? 'Textured, for full-color printers: Stratasys PolyJet via GrabCAD Print, HP Multi Jet Fusion, Mimaki, and print services'
        : o.format === '3mf' && eo.colors !== 'mono' ? 'Colors are painted for Bambu Studio, OrcaSlicer and PrusaSlicer' : '';
      busy.hidden = true;
    }, 60);
  };
  form.onchange = () => update();
  dlg.querySelector('[data-reset]').onclick = () => { o = factory(viewer); writeForm(form, o); update(); };
  dlg.querySelector('[data-go]').onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Building…';
    await new Promise(res => setTimeout(res, 30));
    try {
      o = effective(readForm(form));
      const G = buildGrid(src, o, Math.max(0.25, o.width / MAX_CELLS));
      const M = buildMesh(G);
      const name = `${r.name} · Slope Spy`;
      const file = `slopespy-${r.id}-${o.width}mm${o.colors === 'mono' ? '' : o.colors === 'full' ? '-fullcolor' : `-${o.colors}color`}`;
      const T = o.colors === 'full' ? await bakeTexture(src, G, fullTex(o.width)) : null;
      const blob = o.format === 'stl' ? toSTL(M, name) : o.format === 'obj' ? await toOBJ(M, G, T, file) : T ? await to3MFTextured(M, G, T, name) : await to3MF(M, G, name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${file}.${o.format === 'obj' ? 'zip' : o.format}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (err) { console.error(err); note.textContent = 'Export failed: ' + err.message; }
    btn.disabled = false; btn.textContent = label;
  };
  update(true);
}

// exposed for tests
export const _internals = { buildGrid, buildMesh, toSTL, to3MF, to3MFTextured, toOBJ, bakeTexture, loadOpts, factory };
