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
const factory = viewer => ({ format: 'stl', colors: 'mono', relief: true, label: true, width: 150, size: 'width', scale: 50000, exag: viewer.exag, area: 'model', margin: 20, shape: 'rect', specs: true, base: 4 });
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

// The area printed, in mercator pixels at the terrain's zoom: the whole terrain, or runs and lifts plus a margin
function regionOf(src, o) {
  const { data, terrain } = src, z = terrain.z, crop = terrain.crop;
  let [px0, py0, px1, py1] = crop;
  if (o.area === 'ski') {   // runs, lifts and the boundary plus a margin (a share of the larger side)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const visit = c => { if (typeof c[0] === 'number') { const x = lon2px(c[0], z), y = lat2px(c[1], z); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } else c.forEach(visit); };
    for (const f of data.runs.concat(data.lifts)) visit(f.c);
    if (data.boundary) visit(data.boundary.c);
    if (isFinite(x0)) {
      const m = Math.max(x1 - x0, y1 - y0) * (o.margin ?? 20) / 100, mx = m, my = m;
      px0 = Math.max(crop[0], x0 - mx); py0 = Math.max(crop[1], y0 - my); px1 = Math.min(crop[2], x1 + mx); py1 = Math.min(crop[3], y1 + my);
    }
  }
  return { px0, py0, px1, py1 };
}
// Which way is "up the mountain": lifts run from the base to the top, so their low-to-high directions,
// summed, point the way someone standing at the base looks. Returned as quarter turns from north-up
// (0 north, 1 east, 2 south, 3 west), or 0 when the lifts disagree too much to say.
function uphillTurns(src) {
  const { data, terrain } = src, z = terrain.z;
  let vx = 0, vy = 0, tot = 0;
  for (const f of data.lifts) {
    const line = f.t === 'MultiLineString' ? f.c.flat() : f.c;
    if (!line || line.length < 2) continue;
    const a = line[0], b = line[line.length - 1];
    const ax = lon2px(a[0], z), ay = lat2px(a[1], z), bx = lon2px(b[0], z), by = lat2px(b[1], z);
    const ha = terrain.sampleGP(ax, ay), hb = terrain.sampleGP(bx, by), len = Math.hypot(bx - ax, by - ay);
    if (!len || Math.abs(hb - ha) < 20) continue;
    const s = hb > ha ? 1 : -1;
    vx += s * (bx - ax); vy += s * (by - ay); tot += len;
  }
  if (!tot || Math.hypot(vx, vy) < 0.2 * tot) return 0;
  const ang = Math.atan2(vx, -vy);                      // 0 = north, clockwise
  return ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
}
// Fixed scales (1:n) make prints of different resorts comparable; the width then follows from the area
const SCALES = [25000, 50000, 75000, 100000, 150000];
function resolveWidth(src, o) {
  if (o.size === 'width' || !+o.size) return o;
  const { px0, py0, px1, py1 } = regionOf(src, o), z = src.terrain.z;
  const mPerPx = 40075016 * Math.cos(px2lat((py0 + py1) / 2, z) * DEG) / worldPx(z);
  return { ...o, width: Math.max(px1 - px0, py1 - py0) * mPerPx * 1000 / +o.size };
}

// ---------- the model ----------
// Returns heights (mm) on a regular grid plus a colour slot per grid point.
function buildGrid(src, o, cell) {
  const { data, terrain, landcover, features } = src;
  const z = terrain.z, crop = terrain.crop;
  const { px0, py0, px1, py1 } = regionOf(src, o);
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

  // cut to the ski area: everything within the margin of a run, lift or the boundary, holes filled, one piece
  let inside = null;
  if (o.shape === 'cut' && o.area === 'ski') {
    const ski = raster(g => {
      g.lineWidth = lw(1.1); g.beginPath(); rings(data.runs, (f, r) => path(g, r)); rings(data.lifts, (f, r) => path(g, r)); g.stroke();
      if (data.boundary) { g.beginPath(); rings([data.boundary], (f, r) => { path(g, r); g.closePath(); }); g.fill('evenodd'); }
    });
    inside = shapeMask(ski, nx, ny, Math.max(2, (o.margin ?? 20) / 100 * Math.max(nx - 1, ny - 1) * cell) / cell);
  }
  const rot = uphillTurns(src);
  const text = o.label && src.name ? placeLabel({ nx, ny, cell, Z0, Z, lift, run, inside }, src.name, o.width, o.nameAt, rot) : null;

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
  const G = { nx, ny, cell, Z, slot, pal, size: [(nx - 1) * cell, (ny - 1) * cell, zmax], scale: 1000 / mmPerM, rot,
    region: { z, px0, py0, px1, py1, mmPerPx }, nameBox: text?.box || null, elev: [hmin, hmax], inside };
  if (o.specs !== false) G.under = engraveSpecs(G, src, o);
  return G;
}

// The print's details, engraved 0.6 mm into the underside, mirrored so they read with the print turned over
// Big, heavy lettering: an FDM nozzle (0.4 mm) needs strokes of a few widths, and the build plate's texture
// swallows anything shallow, so letters are at least ~2.4 mm tall (body), 1 mm deep, and thickened.
const ENGRAVE = 1.0, TITLE = 1.55;
function specLines(G, src, o) {
  const r = src.meta || {}, fmt = v => Math.round(v).toLocaleString('en-US');
  const { px0, py0, px1, py1, z } = G.region;
  const lat = px2lat((py0 + py1) / 2, z), lon = ((px0 + px1) / 2) / worldPx(z) * 360 - 180;
  return [
    src.name || '',
    [r.region, r.countryName].filter(Boolean).join(', '),
    `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}   ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`,
    `1:${fmt(Math.round(G.scale / 100) * 100)}  ·  ${o.exag}× vertical`,
    `${fmt(G.size[0])} × ${fmt(G.size[1])} × ${fmt(G.size[2])} mm`,
    `${fmt(G.elev[0])}–${fmt(G.elev[1])} m`,
    `slopespy.com  ·  ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);
}
function engraveSpecs(G, src, o) {
  const { nx, ny, cell } = G;
  if (o.base < 1.5) return null;
  const all = specLines(G, src, o);
  const font = (wt, px) => `${wt} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const m = new OffscreenCanvas(8, 8).getContext('2d');
  const widthOf = (ls, fs) => Math.max(...ls.map((t, i) => { m.font = font(i ? 700 : 800, (i ? 1 : TITLE) * fs); return m.measureText(t).width + t.length * (i ? 1 : TITLE) * fs * 0.06 + fs * 0.1; }));
  // a narrower layout: long lines broken at their middle separator
  // where the panel may go: inside the outline (cut prints) with a cell to spare, as near the middle as it can be
  const sOut = (() => { if (!G.inside) return null; const t = new Float64Array((nx + 1) * (ny + 1));
    for (let j = 0; j < ny; j++) { let row = 0; for (let i = 0; i < nx; i++) { row += G.inside[j * nx + i] ? 0 : 1; t[(j + 1) * (nx + 1) + i + 1] = t[j * (nx + 1) + i + 1] + row; } }
    return (i0, j0, w, h) => t[(j0 + h) * (nx + 1) + i0 + w] - t[j0 * (nx + 1) + i0 + w] - t[(j0 + h) * (nx + 1) + i0] + t[j0 * (nx + 1) + i0]; })();
  let cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  if (G.inside) { let sx = 0, sy = 0, n = 0; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (G.inside[j * nx + i]) { sx += i; sy += j; n++; } cx = sx / n; cy = sy / n; }
  const fit = (bw, bh) => {
    let best = null;
    const step = Math.max(1, Math.round(1 / cell));
    for (let j0 = 2; j0 + bh < ny - 2; j0 += step) for (let i0 = 2; i0 + bw < nx - 2; i0 += step) {
      if (sOut && sOut(i0 - 1, j0 - 1, bw + 3, bh + 3)) continue;
      const d = (i0 + bw / 2 - cx) ** 2 + (j0 + bh / 2 - cy) ** 2;
      if (!best || d < best.d) best = { d, i0, j0 };
    }
    return best;
  };
  let lines = null, fs = 0, bw = 0, bh = 0, bi0 = 0, bj0 = 0;
  // biggest letters that fit, preferring fewer, larger lines to many small ones
  const pick = idx => idx.map(i => all[i]).filter(Boolean);
  const n = all.length, essentials = pick([0, n - 4, n - 3, n - 1]), minimal = pick([0, n - 4, n - 3]);
  const start = Math.min(6, Math.max(3, G.size[0] * 0.04));
  search: for (let f = start; f >= 2.4 - 1e-9; f -= 0.2) for (const ls of f >= 3.2 || f === start ? [all, essentials] : [all, essentials, minimal]) {
    const lh = f * 1.32, wmm = widthOf(ls, f) + 2 * f, hmm = lh * (ls.length + TITLE - 1 + 0.3) + f * 0.6;
    const w = Math.ceil(wmm / cell), h = Math.ceil(hmm / cell);
    if (w + 4 >= nx || h + 4 >= ny) continue;
    const p = G.inside ? fit(w, h) : { i0: Math.round((nx - 1 - w) / 2), j0: Math.round((ny - 1 - h) / 2) };
    if (!p) continue;
    lines = ls; fs = f; bw = w; bh = h; bi0 = p.i0; bj0 = p.j0;
    break search;
  }
  if (!lines) return null;                                                       // no room for legible text
  const lh = fs * 1.32, depthMM = Math.min(ENGRAVE, o.base * 0.4);
  const SS = 3, cv = new OffscreenCanvas(bw * SS, bh * SS), x = cv.getContext('2d', { willReadFrequently: true });
  const k = SS / cell;
  x.translate(bw * SS, 0); x.scale(-1, 1);                                        // mirrored: read from below
  x.fillStyle = x.strokeStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
  let y = fs * 0.5;
  lines.forEach((t, i) => {
    const sz = (i ? 1 : TITLE) * fs, rowH = i ? lh : lh * TITLE;
    x.font = font(i ? 700 : 800, sz * k);
    x.lineWidth = sz * 0.025 * k; x.letterSpacing = `${(sz * 0.06 * k).toFixed(2)}px`;   // a touch heavier, and air between letters
    const cy = (y + rowH / 2) * k;
    x.fillText(t, bw * SS / 2, cy); x.strokeText(t, bw * SS / 2, cy);
    y += rowH + (i === 0 ? lh * 0.3 : 0);
  });
  const px = x.getImageData(0, 0, bw * SS, bh * SS).data, depth = new Float32Array((bw + 1) * (bh + 1));
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    let a = 0;
    for (let b = 0; b < SS; b++) for (let c = 0; c < SS; c++) a += px[4 * ((j * SS + b) * bw * SS + i * SS + c) + 3];
    depth[j * (bw + 1) + i] = depthMM * Math.min(1, 1.3 * a / (255 * SS * SS));   // full depth except at letter edges
  }
  return { i0: bi0, j0: bj0, w: bw, h: bh, depth, lines, fs };
}

// The resort's name, raised 1 mm, in the flattest low-lying spot that no run or lift crosses (usually a valley floor).
// Smooths away the textures under it so the letters read. Returns the letter mask (0..1 per grid point).
function placeLabel(g, name, width, at, rot = 0) {   // at: centre and size in mm, to reuse a spot found earlier; rot: quarter turns
  const { nx, ny, cell, Z0, Z } = g;
  const font = px => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const meas = new OffscreenCanvas(8, 8).getContext('2d');
  meas.font = font(100);
  const per100 = meas.measureText(name).width / 100;
  let fs0 = Math.max(4, width * 0.045) / cell;                    // letter height in cells
  fs0 = Math.min(fs0, (rot % 2 ? ny : nx) * 0.8 / Math.max(1, per100));   // long names get smaller letters
  const dims = fs => {
    const tw = Math.ceil(per100 * fs + fs * 0.8), th = Math.ceil(fs * 1.6);   // the text's own width and height
    return rot % 2 ? [th, tw] : [tw, th];                                      // its footprint on the grid
  };
  const margin = Math.ceil(2 / cell);
  let zlo = Infinity;
  for (let k = 0; k < Z0.length; k++) if (Z0[k] < zlo) zlo = Z0[k];
  // Summed-area tables: lifts (grown by ~2 mm so their names clear it too, never crossed), runs (avoided strongly),
  // off the print (for a cut shape), height and height²
  const grow = Math.max(1, Math.round(2 / cell));
  const liftD = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (g.lift[j * nx + i] > 0.2)
    for (let b = Math.max(0, j - grow); b <= Math.min(ny - 1, j + grow); b++) for (let a = Math.max(0, i - grow); a <= Math.min(nx - 1, i + grow); a++) liftD[b * nx + a] = 1;
  const sat = f => { const t = new Float64Array((nx + 1) * (ny + 1));
    for (let j = 0; j < ny; j++) { let row = 0; for (let i = 0; i < nx; i++) { row += f(j * nx + i); t[(j + 1) * (nx + 1) + i + 1] = t[j * (nx + 1) + i + 1] + row; } }
    return (i0, j0, w, h) => t[(j0 + h) * (nx + 1) + i0 + w] - t[j0 * (nx + 1) + i0 + w] - t[(j0 + h) * (nx + 1) + i0] + t[j0 * (nx + 1) + i0]; };
  const sLift = sat(k => liftD[k]), sRun = sat(k => g.run[k] > 0.3 ? 1 : 0), sZ = sat(k => Z0[k]), sZ2 = sat(k => Z0[k] * Z0[k]);
  const sOut = g.inside ? sat(k => g.inside[k] ? 0 : 1) : () => 0;
  const search = (fs, offOk) => {
    const [bw, bh] = dims(fs);
    if (bw + 2 * margin >= nx || bh + 2 * margin >= ny) return null;
    const step = Math.max(1, Math.round(fs / 4)), n = (bw + 1) * (bh + 1);
    let best = null;
    for (let j0 = margin; j0 + bh < ny - margin; j0 += step) for (let i0 = margin; i0 + bw < nx - margin; i0 += step) {
      const lifts = sLift(i0, j0, bw + 1, bh + 1), runs = sRun(i0, j0, bw + 1, bh + 1) / n, out = sOut(i0 - 1, j0 - 1, bw + 3, bh + 3);
      const mean = sZ(i0, j0, bw + 1, bh + 1) / n, sd = Math.sqrt(Math.max(0, sZ2(i0, j0, bw + 1, bh + 1) / n - mean * mean));
      // flat, low, clear of runs; crossing a lift or leaving a cut print is disqualifying unless nothing else is free
      const score = 3 * sd + 0.5 * (mean - zlo) + 60 * runs + (lifts ? 1e6 + lifts : 0) + (out && !offOk ? 1e9 + out : 0);
      if (!best || score < best.score) best = { score, i0, j0, fs, bw, bh };
    }
    return best;
  };
  let best = null;
  if (at) {
    const fs = at.size / cell, [bw, bh] = dims(fs);
    best = { fs, bw, bh, i0: Math.max(0, Math.min(nx - 1 - bw, Math.round(at.x / cell - bw / 2))), j0: Math.max(0, Math.min(ny - 1 - bh, Math.round(at.y / cell - bh / 2))) };
  } else {
    // a cut print: shrink the letters (down to 3 mm) until a clear spot fits inside the outline;
    // failing that, place it at full size and let the outline grow around it
    const sizes = g.inside ? [1, 0.85, 0.72, 0.6].map(f => Math.max(fs0 * f, Math.min(fs0, 3 / cell))) : [fs0];
    for (const fs of sizes) { const b = search(fs, false); if (b && b.score < 1e6) { best = b; break; } if (!best || (b && b.score < best.score)) best = b; }
    if (g.inside && best && best.score >= 1e6) { const b = search(fs0, true); if (b && b.score < 1e6) best = b; }
  }
  if (!best) return null;
  const { fs, bw, bh } = best;
  if (g.inside) {   // the outline always takes in the name, with 1 mm to spare
    const pad = Math.ceil(1 / cell);
    for (let j = Math.max(0, best.j0 - pad); j <= Math.min(ny - 1, best.j0 + bh + pad); j++)
      for (let i = Math.max(0, best.i0 - pad); i <= Math.min(nx - 1, best.i0 + bw + pad); i++) g.inside[j * nx + i] = 1;
  }
  const SS = 3, cv = new OffscreenCanvas(bw * SS, bh * SS), x = cv.getContext('2d', { willReadFrequently: true });
  x.font = font(fs * SS); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.translate(bw * SS / 2, bh * SS / 2); x.rotate(rot * Math.PI / 2);
  x.fillText(name, 0, fs * SS * 0.05);
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
  mask.box = { x: (best.i0 + bw / 2) * cell, y: (best.j0 + bh / 2) * cell, size: fs * cell, w: bw * cell, h: bh * cell, rot };
  return mask;
}

// Grid points within r cells of the ski area (chamfer distance), with enclosed holes filled, largest piece only
function shapeMask(ski, nx, ny, r) {
  const N = nx * ny, d = new Float32Array(N), D = Math.SQRT2;
  for (let k = 0; k < N; k++) d[k] = ski[k] > 0.3 ? 0 : 1e9;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + 1);
    if (j > 0) { v = Math.min(v, d[k - nx] + 1); if (i > 0) v = Math.min(v, d[k - nx - 1] + D); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + D); }
    d[k] = v;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let v = d[k];
    if (i < nx - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < ny - 1) { v = Math.min(v, d[k + nx] + 1); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + D); if (i > 0) v = Math.min(v, d[k + nx - 1] + D); }
    d[k] = v;
  }
  const inside = new Uint8Array(N);
  for (let k = 0; k < N; k++) inside[k] = d[k] <= r ? 1 : 0;
  const flood = (seeds, ok, mark) => {
    const st = seeds.slice(), got = []; for (const k of st) mark[k] = 1;
    while (st.length) {
      const k = st.pop(); got.push(k);
      const i = k % nx, j = (k - i) / nx;
      for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) if (q >= 0 && !mark[q] && ok(q)) { mark[q] = 1; st.push(q); }
    }
    return got;
  };
  // holes: anything outside that the outer edge can't reach
  const out = new Uint8Array(N), edge = [];
  for (let i = 0; i < nx; i++) edge.push(i, (ny - 1) * nx + i);
  for (let j = 0; j < ny; j++) edge.push(j * nx, j * nx + nx - 1);
  flood(edge.filter(k => !inside[k]), q => !inside[q], out);
  for (let k = 0; k < N; k++) if (!out[k]) inside[k] = 1;
  // keep the biggest piece
  const seen = new Uint8Array(N); let best = [];
  for (let k = 0; k < N; k++) if (inside[k] && !seen[k]) { const got = flood([k], q => inside[q], seen); if (got.length > best.length) best = got; }
  inside.fill(0); for (const k of best) inside[k] = 1;
  return inside;
}

// Watertight mesh for a cut print: top and bottom triangles wherever all three corners are inside the shape,
// walls along every edge only one top triangle uses. Diagonal halves of cells keep the outline from stair-stepping.
function buildMeshCut(G) {
  const { nx, ny, cell, Z, inside: In } = G, N = nx * ny, U = G.under;
  const pos = new Float32Array(N * 2 * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = i * cell, y = (ny - 1 - j) * cell;
    pos.set([x, y, Z[k]], 3 * k); pos.set([x, y, 0], 3 * (N + k));
  }
  for (let j = 0; U && j <= U.h; j++) for (let i = 0; i <= U.w; i++) pos[3 * (N + (U.j0 + j) * nx + U.i0 + i) + 2] = U.depth[j * (U.w + 1) + i];
  const top = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    // split along the diagonal that keeps the most of a partly-inside cell
    if (In[a] && In[b] && In[c] && In[d]) top.push(a, c, b, b, c, d);
    else if (In[a] && In[c] && In[b]) top.push(a, c, b);
    else if (In[b] && In[c] && In[d]) top.push(b, c, d);
    else if (In[a] && In[c] && In[d]) top.push(a, c, d);
    else if (In[a] && In[d] && In[b]) top.push(a, d, b);
  }
  const nTop = top.length / 3;
  // boundary edges: directed edges whose reverse no top triangle uses
  const key = (u, v) => u * N + v, edges = new Set();
  for (let f = 0; f < top.length; f += 3) for (let e = 0; e < 3; e++) edges.add(key(top[f + e], top[f + (e + 1) % 3]));
  const rim = [];
  for (let f = 0; f < top.length; f += 3) for (let e = 0; e < 3; e++) {
    const u = top[f + e], v = top[f + (e + 1) % 3];
    if (!edges.has(key(v, u))) rim.push(u, v);
  }
  const tri = new Uint32Array((nTop * 2 + rim.length) * 3);
  tri.set(top);
  let t = top.length;
  for (let r = 0; r < rim.length; r += 2) { const u = rim[r], v = rim[r + 1]; tri[t++] = v; tri[t++] = u; tri[t++] = u + N; tri[t++] = v; tri[t++] = u + N; tri[t++] = v + N; }
  for (let f = 0; f < top.length; f += 3) { tri[t++] = top[f] + N; tri[t++] = top[f + 2] + N; tri[t++] = top[f + 1] + N; }
  return { pos, tri, nTop };
}

function flipIfInside(M) {   // turn every face if the signed volume came out negative
  const { pos, tri } = M; let vol = 0;
  for (let f = 0; f < tri.length; f += 3) {
    const a = 3 * tri[f], b = 3 * tri[f + 1], c = 3 * tri[f + 2];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let f = 0; f < tri.length; f += 3) { const x = tri[f + 1]; tri[f + 1] = tri[f + 2]; tri[f + 2] = x; }
  return M;
}

// Watertight mesh: top surface, four walls down to z=0, a flat bottom; outward-facing triangles.
function buildMesh(G) {
  if (G.inside) return flipIfInside(buildMeshCut(G));
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
  const U = G.under;
  for (let j = 0; U && j <= U.h; j++) for (let i = 0; i <= U.w; i++) pos[3 * (N + (U.j0 + j) * nx + U.i0 + i) + 2] = U.depth[j * (U.w + 1) + i];
  const nWall = (loop.length - 1) * 2, nBot = U ? 2 * U.w * U.h + 2 * (nx - 1 + ny - 1 + U.w + U.h) : loop.length - 3;
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
  const bot0 = t;
  if (!U) for (let k = 1; k < loop.length - 2; k++) { tri[t++] = loop[0] + N; tri[t++] = loop[k + 1] + N; tri[t++] = loop[k] + N; }
  else {
    // engraved panel as a grid, joined to the rim by four trapezoids
    for (let j = 0; j < U.h; j++) for (let i = 0; i < U.w; i++) {
      const a = N + (U.j0 + j) * nx + U.i0 + i, b = a + 1, c = a + nx, d = c + 1;
      tri[t++] = a; tri[t++] = b; tri[t++] = c; tri[t++] = b; tri[t++] = d; tri[t++] = c;
    }
    const zip = (A, B) => {
      let i = 0, j = 0;
      while (i < A.length - 1 || j < B.length - 1) {
        if (j === B.length - 1 || (i < A.length - 1 && (i + 1) / (A.length - 1) <= (j + 1) / (B.length - 1))) { tri[t++] = A[i]; tri[t++] = A[i + 1]; tri[t++] = B[j]; i++; }
        else { tri[t++] = A[i]; tri[t++] = B[j + 1]; tri[t++] = B[j]; j++; }
      }
    };
    const row = (j, i0, i1) => Array.from({ length: i1 - i0 + 1 }, (_, n) => N + j * nx + i0 + n);
    const col = (i, j0, j1) => Array.from({ length: j1 - j0 + 1 }, (_, n) => N + (j0 + n) * nx + i);
    const I1 = U.i0 + U.w, J1 = U.j0 + U.h;
    zip(row(0, 0, nx - 1), row(U.j0, U.i0, I1));
    zip(row(ny - 1, 0, nx - 1), row(J1, U.i0, I1));
    zip(col(0, 0, ny - 1), col(U.i0, U.j0, J1));
    zip(col(nx - 1, 0, ny - 1), col(I1, U.j0, J1));
  }
  // flip everything if the volume came out negative (mirror from the north-up flip)
  let vol = 0;
  for (let f = 0; f < tri.length; f += 3) {
    const a = 3 * tri[f], b = 3 * tri[f + 1], c = 3 * tri[f + 2];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let f = 0; f < tri.length; f += 3) { const x = tri[f + 1]; tri[f + 1] = tri[f + 2]; tri[f + 2] = x; }
  // the underside always faces down (judged from the triangles' footprint, which stays well-shaped where letters dip)
  for (let f = bot0; U && f < tri.length; f += 3) {
    const a = 3 * tri[f], b = 3 * tri[f + 1], c = 3 * tri[f + 2];
    if ((pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a]) > 0) { const x = tri[f + 1]; tri[f + 1] = tri[f + 2]; tri[f + 2] = x; }
  }
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
  if (G.nameBox) {   // peak and place names keep clear of the resort's name
    const b = G.nameBox, sx = W / G.size[0], sy = H / G.size[1];
    taken.push({ x0: (b.x - b.w / 2) * sx, x1: (b.x + b.w / 2) * sx, y0: (b.y - b.h / 2) * sy, y1: (b.y + b.h / 2) * sy });
  }
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
    g.save(); g.translate(b.x * W / G.size[0], b.y * H / G.size[1]); g.rotate((b.rot || 0) * Math.PI / 2);
    g.fillText(src.name, 0, b.size * H / G.size[1] * 0.05); g.restore();
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

const row = (label, ctl, cls = '') => `<div class="prow ${cls}"><span class="plab">${label}</span><div class="pctl">${ctl}</div></div>`;
const seg = (name, opts) => `<div class="pseg" role="radiogroup">${opts.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}"><span>${t}</span></label>`).join('')}</div>`;
function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('div');
  dlg.id = 'print'; dlg.className = 'sheet modal'; dlg.hidden = true;
  dlg.innerHTML = `
  <div class="sheet-card print-card" role="dialog" aria-modal="true" aria-labelledby="printTitle">
    <div class="sheet-head"><h2 id="printTitle">3D print</h2><button class="btn icon" data-close aria-label="Close">✕</button></div>
    <div class="print-body">
      <div class="print-preview"><canvas></canvas><div class="print-busy" hidden>Building…</div></div>
      <div class="print-side">
      <p class="print-info"></p>
      <form class="print-form">
        ${row('Format', seg('format', [['stl', 'STL'], ['3mf', '3MF'], ['obj', 'OBJ']]))}
        ${row('Colors', seg('colors', [['mono', 'Single'], ['4', '4'], ['8', '8'], ['full', 'Full']]))}
        ${row('Size', seg('sizeMode', [['width', 'Fixed width'], ['scale', 'Fixed scale']]))}
        ${row('', `<select name="width" aria-label="Width">${[100, 150, 200, 250].map(v => `<option value="${v}">${v} mm wide</option>`).join('')}</select>
          <select name="scale" aria-label="Scale">${SCALES.map(v => `<option value="${v}">1:${v.toLocaleString('en-US')}</option>`).join('')}</select>
          <small class="hint size-hint">Same scale, comparable prints</small>`, 'sub')}
        ${row('Vertical', seg('exag', [1, 1.5, 2, 3].map(v => [v, `${v}×`])))}
        ${row('Base', seg('base', [2, 4, 6, 10].map(v => [v, `${v} mm`])))}
        ${row('Area', seg('area', [['ski', 'Ski area'], ['model', 'Whole model']]))}
        ${row('Shape', seg('shape', [['rect', 'Rectangle'], ['cut', 'Cut to ski area']]), 'margin-row')}
        ${row('Margin', seg('margin', [[0, 'None'], [5, '5%'], [10, '10%'], [20, '20%']]), 'margin-row')}
        <div class="prow opts"><span class="plab">Details</span><div class="pctl">
          <label class="opt"><input type="checkbox" name="relief"><span>Relief textures<small>Forest bumps, engraved runs, raised lifts, buildings and boundary</small></span></label>
          <label class="opt"><input type="checkbox" name="label"><span>Resort name<small>Raised 1 mm in a low, open spot, reading from the base up the mountain</small></span></label>
          <label class="opt"><input type="checkbox" name="specs"><span>Specs underneath<small>Place, scale, size and date engraved into the bottom</small></span></label>
        </div></div>
      </form>
      <div class="print-legend"></div>
      <div class="print-actions"><p class="print-note"></p><div class="print-btns"><button class="btn" data-reset>Reset</button><button class="btn primary" data-go>Download</button></div></div>
      </div>
    </div>
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
  return { format, colors, relief: form.relief.checked, label: form.label.checked, specs: form.specs.checked, margin: +pick('margin'), shape: pick('shape') || 'rect', width: +form.width.value, scale: +form.scale.value,
    size: pick('sizeMode') === 'scale' ? form.scale.value : 'width', exag: +pick('exag'), base: +pick('base'), area: pick('area') };
}
// STL carries no colour, so it always prints single-colour (the colour choice is kept for when 3MF is picked again)
// OBJ is for full-colour printers (Stratasys PolyJet, HP MJF, Mimaki), so it always carries the texture
const effective = o => o.format === 'stl' ? { ...o, colors: 'mono' } : o.format === 'obj' ? { ...o, colors: 'full' } : o;
function writeForm(form, o) {
  form.dataset.colors = o.colors;   // the 3MF colour choice, kept while STL or OBJ force their own
  form.dataset.format = o.format;
  for (const k of ['format', 'colors', 'area', 'shape', 'margin', 'exag', 'base']) { const el = form.querySelector(`[name="${k}"][value="${o[k]}"]`); if (el) el.checked = true; }
  form.relief.checked = o.relief; form.label.checked = o.label; form.specs.checked = o.specs !== false;
  for (const el of form.querySelectorAll('.margin-row')) el.hidden = o.area !== 'ski';
  const byScale = o.size !== 'width';
  form.querySelector(`[name="sizeMode"][value="${byScale ? 'scale' : 'width'}"]`).checked = true;
  form.width.hidden = byScale; form.scale.hidden = !byScale; form.querySelector('.size-hint').hidden = !byScale;
  form.scale.value = String(byScale ? o.size : o.scale || 50000);
  form.width.value = String(o.width);
  for (const el of form.querySelectorAll('[name="colors"]')) el.disabled = o.format === 'stl' || (o.format === 'obj' && el.value !== 'full');
  { const el = form.querySelector(`[name="colors"][value="${effective(o).colors}"]`); if (el) el.checked = true; }

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
  const M = buildMesh(G), N = G.nx * G.ny, NV = M.pos.length / 3;
  // walls get their own copies of the rim's top corners, so they take the side colour (not a smear of the top's)
  // and a crisp edge where they meet the top
  const tri = M.tri.slice(), dup = new Map(), extra = [];
  for (let f = M.nTop * 3; f < tri.length; f++) {
    const v = tri[f];
    if (v < N) { let d = dup.get(v); if (d === undefined) { d = NV + extra.length; extra.push(v); dup.set(v, d); } tri[f] = d; }
  }
  const orig = k => k < NV ? k : extra[k - NV], top = k => k < N;   // preview vertex -> mesh vertex; on the top surface?
  const geo = new THREE.BufferGeometry();
  // three.js is y-up: model x -> x, model z (height) -> y, model y (north) -> -z
  const NP = NV + extra.length, p = new Float32Array(NP * 3);
  for (let k = 0; k < NP; k++) { const i = 3 * orig(k); p[3 * k] = M.pos[i] - G.size[0] / 2; p[3 * k + 1] = M.pos[i + 2]; p[3 * k + 2] = -(M.pos[i + 1] - G.size[1] / 2); }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setIndex(new THREE.BufferAttribute(tri, 1));
  geo.computeVertexNormals();
  let mat;
  if (T) {
    const { uv, base } = uvOf(G, T), u2 = new Float32Array(NP * 2);
    for (let k = 0; k < NP; k++) { if (top(k)) { u2[2 * k] = uv[2 * k]; u2[2 * k + 1] = uv[2 * k + 1]; } else { u2[2 * k] = base[0]; u2[2 * k + 1] = base[1]; } }
    geo.setAttribute('uv', new THREE.BufferAttribute(u2, 2));
    const tex = new THREE.CanvasTexture(T.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = true;
    tex.anisotropy = view.renderer.capabilities.getMaxAnisotropy();
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  } else if (G.pal) {
    const cols = G.pal.map(c => new THREE.Color(c.hex)), col = new Float32Array(p.length);
    for (let k = 0; k < NP; k++) { const c = top(k) ? cols[G.slot[k]] : cols[0]; col.set([c.r, c.g, c.b], 3 * k); }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  } else mat = new THREE.MeshStandardMaterial({ color: '#d9d6cf', roughness: 0.6 });
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.map?.dispose(); view.mesh.material.dispose(); }
  view.mesh = new THREE.Mesh(geo, mat);
  view.scene.add(view.mesh);
  const r = Math.max(G.size[0], G.size[1]);
  if (!refit && view.r && Math.abs(r / view.r - 1) > 1e-3) {   // new size: same view, scaled with the model
    const k = r / view.r;
    view.camera.position.multiplyScalar(k); view.controls.target.multiplyScalar(k);
    view.camera.near = r / 100; view.camera.far = r * 20; view.camera.updateProjectionMatrix();
  }
  view.r = r;
  if (refit) {
    view.controls.target.set(0, G.size[2] * 0.35, 0);
    view.camera.position.set(-r * 0.15, r * 0.85, r * 1.25).applyAxisAngle(new THREE.Vector3(0, 1, 0), -(G.rot || 0) * Math.PI / 2);   // from the base, looking up
    view.camera.near = r / 100; view.camera.far = r * 20; view.camera.updateProjectionMatrix();
  }
}

export function openPrint({ S, viewer }) {
  ensureDialog();
  const form = dlg.querySelector('form'), canvas = dlg.querySelector('canvas'), info = dlg.querySelector('.print-info');
  const legend = dlg.querySelector('.print-legend'), busy = dlg.querySelector('.print-busy'), note = dlg.querySelector('.print-note');
  const r = S.resort, src = { ...S.src, name: r.name, meta: r };
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
    o = resolveWidth(src, o);
    const key = JSON.stringify([r.id, effective(o).colors, o.relief, o.label, o.specs, o.margin, o.shape, o.width, o.exag, o.base, o.area]);
    if (key === lastKey && !refit) return;
    lastKey = key;
    busy.hidden = false;
    clearTimeout(timer);
    const seq = ++updSeq;
    timer = setTimeout(async () => {
      const eo = effective(o);
      const G = buildGrid(src, eo, Math.max(0.25, o.width / PREVIEW_CELLS));
      const T = eo.colors === 'full' ? await bakeTexture(src, G, PREVIEW_TEX) : null;
      if (seq !== updSeq) return;
      showPreview(G, o, refit, T);
      const full = Math.max(0.25, o.width / MAX_CELLS);
      const cells = Math.round(G.size[0] / full + 1) * Math.round(G.size[1] / full + 1);
      const tris = cells * 2 + 4 * Math.sqrt(cells) * 2;
      const mb = o.format === 'stl' ? tris * 50 / 1e6 : eo.colors === 'full' ? tris * 16 / 1e6 + 12 : tris * (eo.colors === 'mono' ? 14 : 18) / 1e6;
      const big = Math.max(G.size[0], G.size[1]) > 256;
      info.innerHTML = `<b>${Math.round(G.size[0])} × ${Math.round(G.size[1])} × ${Math.round(G.size[2])} mm</b><span>1:${(Math.round(G.scale / 100) * 100).toLocaleString('en-US')} · about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB</span>${big ? '<em>Larger than a 256 mm print bed</em>' : ''}`;
      legend.innerHTML = G.pal ? `<span class="plab">Filaments</span><div>${G.pal.map((p, i) => `<span><i style="background:${p.hex}"></i><b>${i + 1}</b> ${esc(p.name)}</span>`).join('')}</div>` : '';
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
      o = resolveWidth(src, effective(readForm(form)));
      // the name's spot is searched for on the preview's grid, so the file matches what the preview showed
      const nb = o.label ? buildGrid(src, { ...o, colors: 'mono', specs: false }, Math.max(0.25, o.width / PREVIEW_CELLS)).nameBox : null;
      const G = buildGrid(src, { ...o, nameAt: nb }, Math.max(0.25, o.width / MAX_CELLS));
      const M = buildMesh(G);
      const name = `${r.name} · Slope Spy`;
      const file = `slopespy-${r.id}-${o.size === 'width' ? `${o.width}mm` : `1to${o.size / 1000}k`}${o.colors === 'mono' ? '' : o.colors === 'full' ? '-fullcolor' : `-${o.colors}color`}`;
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
export const _internals = { buildGrid, buildMesh, toSTL, to3MF, to3MFTextured, toOBJ, bakeTexture, loadOpts, factory, resolveWidth };
