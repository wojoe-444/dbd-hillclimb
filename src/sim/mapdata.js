// Map preparation: rasterises the map JSON onto the 1 m grid. Done once per map object (WeakMap cache) and
// shared (read-only) by every match on that map -- the expensive/static part of match setup.
//
// Cell kinds (grid.kind):
//   0 free   1 solid (obstacle / outside outline / generator candidate)
//   2 window (axis x)  3 window (axis z)   4 pallet (axis x)  5 pallet (axis z)
// Windows are collision-solid (only enterable by vaulting). Pallet cells are free while up, solid while dropped.
// ALL generator candidates are solid low blocks; the 7 unused candidates are inert "wrecks" (documented deviation:
// it keeps the nav grid static so distance fields can be cached across matches).

import { deepFreeze } from './config.js';

export const K_FREE = 0, K_SOLID = 1, K_WIN_X = 2, K_WIN_Z = 3, K_PAL_X = 4, K_PAL_Z = 5;

const cache = new WeakMap();

export function prepareMap(map) {
  let md = cache.get(map);
  if (!md) { md = build(map); cache.set(map, md); }
  return md;
}

function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function build(map) {
  if (!map || !map.size) throw new Error('prepareMap: map.size missing');
  const w = map.size.w, h = map.size.h, N = w * h;
  const kind = new Uint8Array(N);
  const sight = new Int32Array(N);
  const palIdx = new Int16Array(N);
  const eye = map.eyeHeight ?? 1.6;
  const outline = map.outline && map.outline.length ? map.outline : [[0, 0], [w, 0], [w, h], [0, h]];

  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!pointInPoly(i + 0.5, j + 0.5, outline)) { kind[j * w + i] = K_SOLID; sight[j * w + i] = -1; }
  }

  let sid = 0;
  const inb = (i, j) => i >= 0 && j >= 0 && i < w && j < h;

  for (const o of map.obstacles || []) {
    const tall = o.height >= eye;
    const id = ++sid;
    const i1 = Math.ceil(o.x + o.w), j1 = Math.ceil(o.z + o.d);
    for (let j = Math.floor(o.z); j < j1; j++) for (let i = Math.floor(o.x); i < i1; i++) {
      if (!inb(i, j)) continue;
      const c = j * w + i;
      kind[c] = K_SOLID;
      if (tall) sight[c] = -1; else if (sight[c] !== -1) sight[c] = id;
    }
  }

  const windows = [];
  for (const wd of map.windows || []) {
    const c = wd.z * w + wd.x;
    kind[c] = wd.axis === 'x' ? K_WIN_X : K_WIN_Z;
    sight[c] = ++sid;
    windows.push({ id: wd.id, x: wd.x, z: wd.z, axis: wd.axis, cell: c });
  }

  const pallets = [];
  (map.pallets || []).forEach((p, index) => {
    const len = p.length || 1;
    const id = ++sid;
    const cells = [];
    let x0 = p.x, z0 = p.z, x1, z1;
    if (p.axis === 'x') { x1 = p.x + 1; z1 = p.z + len; } else { x1 = p.x + len; z1 = p.z + 1; }
    for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) {
      const c = j * w + i;
      kind[c] = p.axis === 'x' ? K_PAL_X : K_PAL_Z;
      sight[c] = id;
      palIdx[c] = index + 1;
      cells.push(c);
    }
    pallets.push({ index, id: p.id, x: p.x, z: p.z, axis: p.axis, length: len, x0, z0, x1, z1, cells, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
  });

  const genCands = [];
  for (const g of map.generators || []) {
    const i = Math.floor(g.x), j = Math.floor(g.z), c = j * w + i;
    kind[c] = K_SOLID;
    sight[c] = ++sid;
    genCands.push({ id: g.id, x: g.x, z: g.z, i, j, cell: c, x0: i, z0: j, x1: i + 1, z1: j + 1 });
  }

  // static move mask: bit d of nbMask[u] set iff a character may step u -> u+(DX[d],DZ[d]) (symmetric).
  // 8-connected, no corner cutting, windows/pallets only enterable along their axis. Pallet cells count as
  // walkable here; dropped-pallet blocking for the hunter is applied dynamically by the nav layer.
  const nbMask = new Uint8Array(N);
  const NDX = [1, -1, 0, 0, 1, 1, -1, -1], NDZ = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const u = j * w + i, ku = kind[u];
    let m = 0;
    for (let d = 0; d < 8; d++) {
      const ni = i + NDX[d], nj = j + NDZ[d];
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const v = nj * w + ni, kv = kind[v], dx = NDX[d], dz = NDZ[d];
      if (kv === K_SOLID) continue;
      if (dx !== 0 && dz !== 0) {
        if (kv !== 0 || (ku !== 0 && ku !== K_SOLID)) continue;
        if (kind[u + dx] !== 0 || kind[u + dz * w] !== 0) continue;   // (in-bounds: both neighbours exist since v does)
      } else {
        if (kv >= K_WIN_X && ((kv === K_WIN_X || kv === K_PAL_X) ? dz !== 0 : dx !== 0)) continue;
        if (ku >= K_WIN_X && ((ku === K_WIN_X || ku === K_PAL_X) ? dz !== 0 : dx !== 0)) continue;
      }
      m |= 1 << d;
    }
    nbMask[u] = m;
  }

  // "map feature" cells: nav always uses canonical (cacheable) field descent for these targets (see nav.js)
  const keyCell = new Uint8Array(N);
  const keyAt = (x, z) => { const i = Math.floor(x), j = Math.floor(z); if (i >= 0 && j >= 0 && i < w && j < h) keyCell[j * w + i] = 1; };
  for (const g of genCands) keyCell[g.cell] = 1;
  for (const p of pallets) for (const c of p.cells) keyCell[c] = 1;
  for (const wd of windows) keyCell[wd.cell] = 1;
  for (const hk of map.hooks || []) keyAt(hk.x, hk.z);
  for (const gt of map.exitGates || []) { keyAt(gt.lever.x, gt.lever.z); keyAt(gt.exit.x, gt.exit.z); }
  for (const s of map.spawns?.hunter || []) keyAt(s.x, s.z);
  for (const s of map.spawns?.survivors || []) keyAt(s.x, s.z);

  // collision grid at match start: windows/solid blocked, pallets (up) free
  const coll0 = new Uint8Array(N);
  for (let c = 0; c < N; c++) { const k = kind[c]; coll0[c] = (k === K_SOLID || k === K_WIN_X || k === K_WIN_Z) ? 1 : 0; }

  const info = deepFreeze({
    id: map.id, name: map.name, size: { w, h }, w, h, eyeHeight: eye, outline: map.outline,
    obstacles: map.obstacles || [],
    windows: windows.map(({ id, x, z, axis }) => ({ id, x, z, axis })),
    pallets: pallets.map(p => ({ id: p.id, x: p.x, z: p.z, axis: p.axis, length: p.length, x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, cx: p.cx, cz: p.cz })),
    generatorCandidates: genCands.map(({ id, x, z }) => ({ id, x, z })),
    hooks: (map.hooks || []).map(hk => ({ id: hk.id, x: hk.x, z: hk.z })),
    exitGates: (map.exitGates || []).map(g => ({ id: g.id, lever: { ...g.lever }, exit: { ...g.exit } })),
    spawns: { hunter: (map.spawns?.hunter || []).map(s => ({ x: s.x, z: s.z })), survivors: (map.spawns?.survivors || []).map(s => ({ x: s.x, z: s.z })) },
  });

  return {
    map, w, h, N, kind, sight, palIdx, nbMask, keyCell, coll0, windows, pallets, genCands, info,
    hooks: info.hooks, gates: info.exitGates, spawns: info.spawns,
    nav: null, // lazily created NavShared (fields cache + scratch buffers)
  };
}
