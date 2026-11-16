// Generic tile-layout map generator. A layout spec (see layouts/gas-heaven.js) fixes the outline, landmark
// slots and weighted tile pools; this module rolls tiles, rotations, mirrors and optional pallets, then
// derives generators, hooks, gates and spawns from tile slots + layout rules. Zero deps, Node + browser.
//
// generateFromLayout(layout, seed) -> { ok, map, stats, error }
// Deterministic for (layout, seed). `ok:false` means a layout rule could not be met for this seed
// (caller retries with another seed); the map still passes through the external validator separately.

import { makeRng } from './rng.js';
import { TILES, resolveTile, isSolidChar } from './tiles.js';
import { composeFeatures, OUTSIDE } from './compose.js';

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function generateFromLayout(layout, seed) {
  const rng = makeRng(seed);
  const { w, h } = layout.size;
  const C = layout.cell;
  const cw = w / C, chh = h / C;
  const N = w * h;
  const grid = new Array(N);
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) grid[z * w + x] = pointInPoly(x + 0.5, z + 0.5, layout.outline) ? '.' : OUTSIDE;

  // ---- 8 m cell classification ---------------------------------------------------------------------
  const cellInside = (i, j) => i >= 0 && j >= 0 && i < cw && j < chh && pointInPoly(i * C + C / 2, j * C + C / 2, layout.outline);
  const cellRing = (i, j) => {
    if (!cellInside(i, j)) return false;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (!cellInside(i + di, j + dj)) return true;
    return false;
  };
  const cellOwner = new Int16Array(cw * chh).fill(-1);
  const instances = [];
  const owner = new Int16Array(N).fill(-1);
  const useCount = {};

  const pickFromPool = poolName => {
    const pool = layout.pools[poolName];
    if (!pool) throw new Error(`unknown pool ${poolName}`);
    const decay = pool.decay ?? 1;
    return rng.weighted(Object.entries(pool.tiles).map(([id, wt]) => [id, wt * Math.pow(decay, useCount[id] ?? 0)]));
  };

  const place = (tileId, x0, z0, role, opts = {}) => {
    const def = TILES[tileId];
    if (!def) throw new Error(`unknown tile ${tileId}`);
    const rot = opts.rot ?? (def.fixedRotation ? 0 : rng.int(4));
    const mirror = opts.mirror ?? (def.fixedRotation ? false : rng.chance(0.5));
    const r2 = resolveTile(def, rng, { rot, mirror });
    const idx = instances.length;
    const n = def.size;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const gi = (z0 + z) * w + (x0 + x);
      if (grid[gi] === OUTSIDE) throw new Error(`tile ${tileId} at ${x0},${z0} leaves the outline`);
      grid[gi] = r2.rows[z][x];
      owner[gi] = idx;
    }
    for (let j = 0; j < n / C; j++) for (let i = 0; i < n / C; i++) cellOwner[(z0 / C + j) * cw + (x0 / C + i)] = idx;
    useCount[tileId] = (useCount[tileId] ?? 0) + 1;
    instances.push({
      idx, tile: tileId, category: def.category, role, x: x0, z: z0, size: n, rot, mirror,
      pallets: r2.pallets.map(p => ({ ...p, cells: p.cells.map(([x, z]) => [x0 + x, z0 + z]) })),
      genSlots: r2.genSlots.map(([x, z]) => [x0 + x, z0 + z]),
      hookSlots: r2.hookSlots.map(([x, z]) => [x0 + x, z0 + z]),
    });
    return idx;
  };

  // ---- 1. landmarks ---------------------------------------------------------------------------------
  for (const lm of layout.landmarks) {
    const tileId = lm.tile ?? pickFromPool(lm.pool);
    place(tileId, lm.x, lm.z, lm.role ?? TILES[tileId].category, { rot: lm.rot, mirror: lm.mirror });
  }

  // ---- 2. exit gates (on ring cells along straight outline edges) ------------------------------------
  const gateCands = [];
  for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) {
    if (!cellRing(i, j) || cellOwner[j * cw + i] >= 0) continue;
    const out = DIRS4.filter(([di, dj]) => !cellInside(i + di, j + dj));
    if (out.length !== 1) continue;
    const [di, dj] = out[0];
    const x0 = i * C, z0 = j * C;
    let edge, exit, lever;
    if (dj === -1) { edge = 'n'; exit = { x: x0 + 4.5, z: z0 + 0.5 }; lever = { x: x0 + 2.5, z: z0 + 1.5 }; }
    else if (dj === 1) { edge = 's'; exit = { x: x0 + 3.5, z: z0 + C - 0.5 }; lever = { x: x0 + 5.5, z: z0 + C - 1.5 }; }
    else if (di === -1) { edge = 'w'; exit = { x: x0 + 0.5, z: z0 + 3.5 }; lever = { x: x0 + 1.5, z: z0 + 5.5 }; }
    else { edge = 'e'; exit = { x: x0 + C - 0.5, z: z0 + 4.5 }; lever = { x: x0 + C - 1.5, z: z0 + 2.5 }; }
    gateCands.push({ i, j, edge, exit, lever });
  }
  const gates = [];
  {
    const first = rng.pick(gateCands);
    const far = gateCands.filter(g => g.edge !== first.edge && Math.hypot(g.exit.x - first.exit.x, g.exit.z - first.exit.z) >= layout.gates.minDistance);
    if (!far.length) return { ok: false, error: 'no far gate pair' };
    gates.push(first, rng.pick(far));
    for (const g of gates) place('gate', g.i * C, g.j * C, 'gate', { rot: 0, mirror: false });
  }

  // ---- 3. inner area: 16 m loop tiles on free 2x2 blocks, then 8 m tiles -----------------------------
  const free = (i, j) => cellInside(i, j) && cellOwner[j * cw + i] < 0;
  const anchors = [];
  for (let j = 0; j < chh - 1; j++) for (let i = 0; i < cw - 1; i++) anchors.push([i, j]);
  rng.shuffle(anchors);
  for (const [i, j] of anchors) {
    const cells = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
    if (!cells.every(([a, b]) => free(a, b) && !cellRing(a, b))) continue;
    if (!rng.chance(layout.bigTileChance)) continue;
    place(pickFromPool('inner16'), i * C, j * C, 'loop');
  }
  for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) {
    if (!free(i, j)) continue;
    place(pickFromPool(cellRing(i, j) ? 'ring8' : 'inner8'), i * C, j * C, cellRing(i, j) ? 'ring' : 'inner');
  }

  // ---- 3b. fixed wall overlays (user-drawn structures laid over whatever tiles rolled there) ---------
  if (layout.overlays && layout.overlays.length) {
    const ov = new Uint8Array(N), near = new Uint8Array(N);
    for (const o of layout.overlays) for (let z = o.z; z < o.z + o.d; z++) for (let x = o.x; x < o.x + o.w; x++) {
      const gi = z * w + x;
      if (grid[gi] === OUTSIDE) continue;
      grid[gi] = o.char ?? '#'; ov[gi] = 1;
    }
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      if (!ov[z * w + x]) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, zz = z + dz; if (xx >= 0 && zz >= 0 && xx < w && zz < h) near[zz * w + xx] = 1; }
    }
    for (const inst of instances) {
      inst.pallets = inst.pallets.filter((pl) => {
        if (!pl.cells.some(([x, z]) => near[z * w + x])) return true;
        for (const [x, z] of pl.cells) if (!ov[z * w + x]) grid[z * w + x] = '.';
        return false;
      });
      inst.genSlots = inst.genSlots.filter(([x, z]) => !near[z * w + x]);
      inst.hookSlots = inst.hookSlots.filter(([x, z]) => !near[z * w + x]);
    }
    for (let gi = 0; gi < N; gi++) if (near[gi] && !ov[gi] && grid[gi] === 'W') grid[gi] = '#';   // a window touching the new wall: wall it up
  }

  // ---- 4. pallet budget: drop random optional pallets above the max ----------------------------------
  const allPallets = () => instances.flatMap(inst => inst.pallets.map(p => ({ inst, p })));
  let total = allPallets().length;
  if (total < layout.pallets.min) return { ok: false, error: `only ${total} pallets` };
  if (total > layout.pallets.max) {
    const optional = rng.shuffle(allPallets().filter(e => e.p.optional && e.inst.category !== 'landmark'));
    while (total > layout.pallets.max && optional.length) {
      const { inst, p } = optional.pop();
      for (const [x, z] of p.cells) grid[z * w + x] = '.';
      inst.pallets.splice(inst.pallets.indexOf(p), 1);
      total--;
    }
  }

  // ---- helpers on the composed grid ------------------------------------------------------------------
  const genCells = new Set();
  const cellChar = (x, z) => (x < 0 || z < 0 || x >= w || z >= h ? OUTSIDE : grid[z * w + x]);
  const walk = (x, z) => { const c = cellChar(x, z); return c !== OUTSIDE && !isSolidChar(c) && !genCells.has(z * w + x); };
  const plainFloor = (x, z) => cellChar(x, z) === '.' && !genCells.has(z * w + x);
  const nearFeature = (x, z, r = 1) => {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const c = cellChar(x + dx, z + dz);
      if (c === 'W' || c === 'P' || genCells.has((z + dz) * w + x + dx)) return true;
    }
    return false;
  };
  const bfs = (sources, maxD = Infinity) => {
    const dist = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    for (const s of sources) if (dist[s] < 0) { dist[s] = 0; q[tail++] = s; }
    while (head < tail) {
      const c = q[head++], x = c % w, z = (c - x) / w;
      if (dist[c] >= maxD) continue;
      for (const [dx, dz] of DIRS4) {
        const nx = x + dx, nz = z + dz;
        if (!walk(nx, nz)) continue;
        const ni = nz * w + nx;
        if (dist[ni] < 0) { dist[ni] = dist[c] + 1; q[tail++] = ni; }
      }
    }
    return { dist, order: q.subarray(0, tail) };
  };

  // ---- 5. generator candidates from tile slots ------------------------------------------------------
  const genSlotList = instances.flatMap(inst => inst.genSlots.map(([x, z]) => ({ x, z, inst })))
    .filter(s => plainFloor(s.x, s.z) && !nearFeature(s.x, s.z, 1) && DIRS4.every(([dx, dz]) => walk(s.x + dx, s.z + dz)))
    .filter(s => outlineInset(s.x + 0.5, s.z + 0.5, layout.outline) >= (layout.gens.minEdgeM ?? 0));   // user: gens never hug the outer wall
  const [gMin, gMax] = layout.gens.count;
  const genTarget = gMin + rng.int(gMax - gMin + 1);
  const gens = [];
  for (const req of layout.gens.require ?? []) {
    const opts = genSlotList.filter(s => s.inst.tile === req);
    if (opts.length) gens.push(rng.pick(opts));
  }
  let spacing = layout.gens.minSpacing;
  while (gens.length < genTarget && spacing > 4) {
    const scored = genSlotList.filter(s => !gens.includes(s)).map(s => ({ s, d: Math.min(Infinity, ...gens.map(g => Math.hypot(g.x - s.x, g.z - s.z))) }))
      .filter(e => e.d >= spacing);
    if (!scored.length) { spacing -= 2; continue; }
    gens.push(rng.weighted(scored.map(e => [e.s, Math.min(e.d, 60) ** 2])));
  }
  if (gens.length < gMin) return { ok: false, error: `only ${gens.length} gen slots usable` };
  for (const g of gens) genCells.add(g.z * w + g.x);

  // ---- 6. spawns -------------------------------------------------------------------------------------
  // Perimeter spawns: the engine picks a survivor *anchor* (it scatters the 4 survivors within 15 m of it)
  // and a hunter point on the opposite side. So we emit ~10 of each spread around the whole perimeter,
  // each inset 4-8 m from the outline, on plain floor outside landmarks; anchors need open space around.
  const sp = layout.spawns;
  const reserved = new Set(gates.flatMap(g => [Math.floor(g.exit.z) * w + Math.floor(g.exit.x), Math.floor(g.lever.z) * w + Math.floor(g.lever.x)]));
  const clear = (x, z, r) => { for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (!plainFloor(x + dx, z + dz) || reserved.has((z + dz) * w + x + dx)) return false; return true; };
  const openFraction = (x, z, r) => {
    let ins = 0, open = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const c = cellChar(x + dx, z + dz);
      if (c === OUTSIDE) continue;
      ins++;
      if (walk(x + dx, z + dz)) open++;
    }
    return ins ? open / ins : 0;
  };
  const perimCands = [];
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const d = outlineInset(x + 0.5, z + 0.5, layout.outline);
    if (d < sp.inset[0] || d > sp.inset[1] || !clear(x, z, 1)) continue;
    const inst = instances[owner[z * w + x]];
    if (!inst || inst.category === 'landmark' || inst.category === 'gate') continue;
    perimCands.push({ x, z });
  }
  const anchorCands = perimCands.filter(c => clear(c.x, c.z, 2) && openFraction(c.x, c.z, sp.anchorOpenRadius) >= sp.anchorOpenFraction);
  const spread = (pool, count, avoid, minAvoid) => {
    const chosen = [];
    const dmin = (c, list) => list.reduce((m, o) => Math.min(m, Math.hypot(o.x - c.x, o.z - c.z)), Infinity);
    let usable = pool.filter(c => dmin(c, avoid) >= minAvoid);
    if (!usable.length) return chosen;
    chosen.push(rng.pick(usable));
    while (chosen.length < count) {
      const scored = usable.map(c => [c, Math.min(dmin(c, chosen), dmin(c, avoid) * 1.6)]).filter(e => e[1] > 4).sort((a, b) => b[1] - a[1]);
      if (!scored.length) break;
      chosen.push(rng.pick(scored.slice(0, 3))[0]);
    }
    return chosen;
  };
  const survAnchors = spread(anchorCands, sp.survivorAnchors, [], 0);
  if (survAnchors.length < sp.survivorAnchors - 2) return { ok: false, error: `only ${survAnchors.length} survivor anchors` };
  const hunterPts = spread(perimCands, sp.hunter, survAnchors, 6);
  if (hunterPts.length < sp.hunter - 2) return { ok: false, error: `only ${hunterPts.length} hunter spawns` };
  for (const c of [...survAnchors, ...hunterPts]) reserved.add(c.z * w + c.x);
  // order both lists clockwise around the map centre (stable, easier to read in the JSON)
  const ang = c => Math.atan2(c.z - h / 2, c.x - w / 2);
  const toPt = c => ({ x: c.x + 0.5, z: c.z + 0.5 });
  const survivorSpawns = survAnchors.sort((a, b) => ang(a) - ang(b)).map(toPt);
  const hunterSpawns = hunterPts.sort((a, b) => ang(a) - ang(b)).map(toPt);

  // ---- 7. hooks: cover so every walkable cell is within `radius` steps (4-neighbour) of a hook -------
  const R = layout.hooks.radius;
  const walkCells = [];
  for (let i = 0; i < N; i++) if (walk(i % w, Math.floor(i / w))) walkCells.push(i);
  const hookOk = i => { const x = i % w, z = Math.floor(i / w); return plainFloor(x, z) && !reserved.has(i) && !nearFeature(x, z, 1); };
  const slotSet = new Set(instances.flatMap(inst => inst.hookSlots.map(([x, z]) => z * w + x)));
  const candSet = new Set();
  for (const i of walkCells) { const x = i % w, z = Math.floor(i / w); if (x % 2 === 0 && z % 2 === 0 && hookOk(i)) candSet.add(i); }
  for (const i of slotSet) if (hookOk(i)) candSet.add(i);
  const cands = [...candSet];
  // radius-limited BFS with shared buffers (thousands of these per map)
  const stamp = new Int32Array(N), ldist = new Int32Array(N), lq = new Int32Array(N);
  let stampId = 0;
  const walkMask = new Uint8Array(N);
  for (const i of walkCells) walkMask[i] = 1;
  const limitedCover = src => {
    stampId++;
    let head = 0, tail = 0;
    stamp[src] = stampId; ldist[src] = 0; lq[tail++] = src;
    while (head < tail) {
      const c = lq[head++];
      if (ldist[c] >= R) continue;
      const x = c % w;
      for (const ni of [x + 1 < w ? c + 1 : -1, x > 0 ? c - 1 : -1, c + w < N ? c + w : -1, c - w]) {
        if (ni < 0 || !walkMask[ni] || stamp[ni] === stampId) continue;
        stamp[ni] = stampId; ldist[ni] = ldist[c] + 1; lq[tail++] = ni;
      }
    }
    return lq.slice(0, tail);
  };
  const covers = cands.map(limitedCover);
  const isSlot = cands.map(c => slotSet.has(c));
  const cx = cands.map(c => c % w), cz = cands.map(c => Math.floor(c / w));
  // candidate neighbourhoods for local moves (bucketed so this stays ~linear)
  const NB = 6, B = 8, bw = Math.ceil(w / B);
  const buckets = new Map();
  cands.forEach((c, t) => { const k = Math.floor(cz[t] / B) * bw + Math.floor(cx[t] / B); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(t); });
  const neighbors = cands.map((c, t) => {
    const out = [], bx = Math.floor(cx[t] / B), bz = Math.floor(cz[t] / B);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const u of buckets.get((bz + dz) * bw + bx + dx) ?? [])
      if (u !== t && Math.abs(cx[u] - cx[t]) <= NB && Math.abs(cz[u] - cz[t]) <= NB) out.push(u);
    return out;
  });

  // Fixed-k cover: farthest-point seeding, then simulated annealing that relocates one hook at a time to a
  // nearby candidate (pulled toward uncovered cells), minimising the number of uncovered walkable cells.
  // (hooks.min is kept as the documented lower bound.)
  let hooks = null;
  // In practice covers need ~20 hooks at radius 20 (4-neighbour metric), so start at max.
  for (let k = layout.hooks.max; k <= layout.hooks.max && !hooks; k++) {
    for (let attempt = 0; attempt < 3 && !hooks; attempt++) {
      const count = new Int32Array(N);
      let uncovered = walkCells.length;
      const chosen = new Set();
      const add = t => { chosen.add(t); for (const c of covers[t]) if (count[c]++ === 0) uncovered--; };
      const remove = t => { chosen.delete(t); for (const c of covers[t]) if (--count[c] === 0) uncovered++; };
      // seeding: greedy by coverage over a coarse random subset (cheap), prefer hook slots
      while (chosen.size < k && uncovered > 0) {
        let best = -1, bs = -1;
        for (let s = 0; s < 300; s++) {
          const t = rng.int(cands.length);
          if (chosen.has(t)) continue;
          let g = 0;
          for (const c of covers[t]) if (count[c] === 0) g++;
          g += isSlot[t] ? layout.hooks.slotBonus : 0;
          if (g > bs) { bs = g; best = t; }
        }
        add(best);
      }
      const maxIt = 30000;
      let uncList = [];
      for (let it = 0; it < maxIt && uncovered > 0; it++) {
        if (it % 50 === 0) uncList = walkCells.filter(c => count[c] === 0);
        const temp = 4 * (1 - it / maxIt) + 0.05;
        const chosenArr = [...chosen];
        let h, tx = -1, tz = -1;
        if (uncList.length && rng.chance(0.75)) {
          const u = rng.pick(uncList);
          tx = u % w; tz = Math.floor(u / w);
          let bd = Infinity;
          for (const t of chosenArr) { const d = Math.abs(cx[t] - tx) + Math.abs(cz[t] - tz); if (d < bd) { bd = d; h = t; } }
        } else h = rng.pick(chosenArr);
        const nb = neighbors[h];
        if (!nb.length) continue;
        let t = rng.pick(nb);
        if (tx >= 0) for (let tries = 0; tries < 3; tries++) {
          const t2 = rng.pick(nb);
          if (Math.abs(cx[t2] - tx) + Math.abs(cz[t2] - tz) < Math.abs(cx[t] - tx) + Math.abs(cz[t] - tz)) t = t2;
        }
        if (chosen.has(t)) continue;
        const before = uncovered;
        remove(h); add(t);
        const delta = uncovered - before;
        if (delta > 0 && !rng.chance(Math.exp(-delta / temp))) { remove(t); add(h); }
      }
      if (uncovered === 0) hooks = [...chosen].map(t => cands[t]);
    }
  }
  if (!hooks) return { ok: false, error: `hooks: no ${layout.hooks.max}-hook cover found` };

  // ---- 8. compose map ---------------------------------------------------------------------------------
  const instName = idx => (idx >= 0 ? `t${String(idx).padStart(2, '0')}` : 'x');
  const { obstacles, windows, pallets } = composeFeatures(grid, w, h, { owner, instName });
  const edgeCount = {};
  const exitGates = gates.map(g => {
    edgeCount[g.edge] = (edgeCount[g.edge] ?? 0) + 1;
    return { id: `gate-${g.edge}${edgeCount[g.edge] > 1 ? edgeCount[g.edge] : ''}`, lever: g.lever, exit: g.exit };
  });
  const generators = gens.map((g, k) => ({ id: `g${k + 1}`, x: g.x + 0.5, z: g.z + 0.5 }));
  const hookList = hooks.slice().sort((a, b) => a - b).map((c, k) => ({ id: `h${String(k + 1).padStart(2, '0')}`, x: (c % w) + 0.5, z: Math.floor(c / w) + 0.5 }));

  // ---- 9. stats ---------------------------------------------------------------------------------------
  const perInst = instances.map(() => ({ pallets: 0, windows: 0 }));
  for (const p of pallets) perInst[owner[p.z * w + p.x]].pallets++;
  for (const v of windows) perInst[owner[v.z * w + v.x]].windows++;
  const tiles = instances.map((inst, k) => ({
    id: instName(k), tile: inst.tile, category: inst.category, role: inst.role,
    x: inst.x, z: inst.z, size: inst.size, rot: inst.rot, mirror: inst.mirror,
    pallets: perInst[k].pallets, windows: perInst[k].windows,
    rating: TILES[inst.tile].rate(perInst[k]),
  }));
  const playableCells8 = tiles.reduce((s, t) => s + (t.size / C) ** 2, 0);
  const deadCells8 = tiles.filter(t => t.rating === 'none').reduce((s, t) => s + (t.size / C) ** 2, 0);
  const featureCells = [];
  for (let i = 0; i < N; i++) if (grid[i] === 'W' || grid[i] === 'P') featureCells.push(i);
  const fd = bfs(featureCells).dist;
  const hookD = bfs(hooks).dist;
  let far12 = 0, maxHook = 0;
  for (const i of walkCells) { if (fd[i] < 0 || fd[i] > layout.deadZoneDistance) far12++; maxHook = Math.max(maxHook, hookD[i] < 0 ? Infinity : hookD[i]); }
  const stats = {
    pallets: pallets.length,
    windows: windows.length,
    strongLoops: tiles.filter(t => t.rating === 'strong').length,
    weakLoops: tiles.filter(t => t.rating === 'weak').length,
    deadTileFraction: +(deadCells8 / playableCells8).toFixed(3),
    deadZoneFraction: +(far12 / walkCells.length).toFixed(3),
    generators: generators.length,
    hooks: hookList.length,
    maxHookDistance: maxHook,
    gates: exitGates.map(g => g.id),
    tileCounts: tiles.reduce((m, t) => ((m[t.tile] = (m[t.tile] ?? 0) + 1), m), {}),
  };

  const map = {
    id: layout.id, name: layout.name,
    size: { w, h }, outline: layout.outline, eyeHeight: layout.eyeHeight,
    obstacles, windows, pallets, generators, hooks: hookList, exitGates,
    spawns: { hunter: hunterSpawns, survivors: survivorSpawns },
    labels: layout.labels,
    spawnRules: { inset: layout.spawns.inset, survivorAnchors: true },
    mapgen: { generator: layout.generator, seed, tiles, stats },
  };
  return { ok: true, map, stats };
}

// Euclidean distance from a point to the nearest outline edge (the outline is axis-aligned).
export function outlineInset(px, pz, outline) {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
    const cx = Math.max(Math.min(ax, bx), Math.min(px, Math.max(ax, bx)));
    const cz = Math.max(Math.min(az, bz), Math.min(pz, Math.max(az, bz)));
    best = Math.min(best, Math.hypot(px - cx, pz - cz));
  }
  return best;
}
