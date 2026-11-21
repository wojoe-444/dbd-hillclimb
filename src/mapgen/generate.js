// Generic tile-layout map generator. A layout spec (see layouts/gas-heaven.js) fixes the outline, landmark
// slots and weighted tile pools; this module rolls tiles, rotations, mirrors and optional pallets, then
// derives generators, hooks, gates and spawns from tile slots + layout rules. Zero deps, Node + browser.
//
// generateFromLayout(layout, seed) -> { ok, map, stats, error }
// Deterministic for (layout, seed). `ok:false` means a layout rule could not be met for this seed
// (caller retries with another seed); the map still passes through the external validator separately.

import { makeRng, hashSeed } from './rng.js';
import { TILES, resolveTile, isSolidChar } from './tiles.js';
import { composeFeatures, OUTSIDE } from './compose.js';
import { generateOutline, outlineToCells } from './outline.js';
import { generatorSets } from '../sim/gen-selection.js';

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// opts.shaped: replace the layout's fixed outline with a seeded stepped outline (src/mapgen/outline.js, rolled
// from its own RNG stream so the tile rolls stay comparable) and refit the fixed pieces to it (fitLayoutToOutline).
// opts.family: force an outline family (see OUTLINE_FAMILIES). opts.outline: use this metre outline instead (same refit). Without either the layout is used as written.
export function generateFromLayout(baseLayout, seed, opts = {}) {
  let layout = baseLayout, shape = null;
  if (opts.shaped || opts.outline) {
    shape = opts.outline ? { family: 'custom', outline: opts.outline } : generateOutline(makeRng(hashSeed('outline', seed)), { ...(baseLayout.shapes ?? {}), ...(opts.family ? { family: opts.family } : {}) });
    layout = fitLayoutToOutline(baseLayout, shape.outline);
    if (!layout) return { ok: false, error: 'fixed pieces do not fit the outline' };
  }
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
  const lmLabels = [];
  for (const lm of layout.landmarks) {
    const tileId = lm.tile ?? pickFromPool(lm.pool);
    let x0 = lm.x, z0 = lm.z;
    if (lm.random) {   // a random free inner slot (all cells inside the outline, free, not on the ring)
      const n = TILES[tileId].size / C, slots = [];
      for (let j = 0; j + n <= chh; j++) for (let i = 0; i + n <= cw; i++) {
        let ok = true;
        for (let b = j; b < j + n && ok; b++) for (let a = i; a < i + n && ok; a++) if (!cellInside(a, b) || cellRing(a, b) || cellOwner[b * cw + a] >= 0) ok = false;
        if (ok) slots.push([i * C, j * C]);
      }
      if (!slots.length) return { ok: false, error: `no free slot for ${tileId}` };
      [x0, z0] = rng.pick(slots);
    }
    place(tileId, x0, z0, lm.role ?? TILES[tileId].category, { rot: lm.rot, mirror: lm.mirror });
    if (lm.label) lmLabels.push({ text: lm.label, x: x0 + TILES[tileId].size / 2, z: z0 + TILES[tileId].size / 2 });
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
  const allPallets = instances.flatMap(inst => inst.pallets.map(p => ({ inst, p })));
  let total = allPallets.length;
  if (total < layout.pallets.min) return { ok: false, error: `only ${total} pallets` };
  if (total > layout.pallets.max) {
    const optional = allPallets.filter(({ inst, p }) => p.optional && inst.category !== 'landmark');
    const required = total - optional.length;
    if (required > layout.pallets.max) return { ok: false, error: `pallet budget: ${required} non-removable pallets exceed max ${layout.pallets.max}` };
    rng.shuffle(optional);
    while (total > layout.pallets.max) {
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
    .filter(s => [-1, 0, 1].every(dz => [-1, 0, 1].every(dx => plainFloor(s.x + dx, s.z + dz))))
    .filter(s => outlineInset(s.x + 0.5, s.z + 0.5, layout.outline) >= (layout.gens.minEdgeM ?? 0));   // user: gens never hug the outer wall
  const [gMin, gMax] = layout.gens.count;
  const genTarget = gMin + rng.int(gMax - gMin + 1);
  // Restart a failed packing; never silently weaken the advertised spacing. A distinct stream leaves
  // downstream rolls independent of the number of packing attempts within this step.
  const genRng = makeRng(hashSeed('generator-candidates', seed));
  let gens = null;
  for (let attempt = 0; attempt < 96 && !gens; attempt++) {
    const trial = [];
    for (const req of layout.gens.require ?? []) {
      const opts = genSlotList.filter(s => s.inst.tile === req && trial.every(g => g.inst !== s.inst && Math.hypot(g.x - s.x, g.z - s.z) >= layout.gens.minSpacing));
      if (!opts.length) break;
      trial.push(genRng.pick(opts));
    }
    if (trial.length !== (layout.gens.require ?? []).length) continue;
    while (trial.length < genTarget) {
      const scored = genSlotList.filter(s => trial.every(g => g.inst !== s.inst))
        .map(s => ({ s, d: Math.min(60, ...trial.map(g => Math.hypot(g.x - s.x, g.z - s.z))) }))
        .filter(e => e.d >= layout.gens.minSpacing);
      if (!scored.length) break;
      trial.push(genRng.weighted(scored.map(e => [e.s, e.d ** 2])));
    }
    if (trial.length !== genTarget) continue;
    if (layout.gens.selection) {
      const sets = generatorSets(trial, 7, layout.gens.selection);
      // Every emitted candidate must really be spawnable. This also prevents a nominal 11-12
      // candidate map with only one possible seven-gen layout and four permanent wrecks.
      if (new Set(sets.flat()).size !== trial.length) continue;
    }
    gens = trial;
  }
  if (!gens) return { ok: false, error: `no feasible ${genTarget} gen candidates with match spread` };
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
  // shaped outlines: start at the area-scaled target, allow up to max + 2 for awkward shapes
  const kStart = layout.hooks.target ?? layout.hooks.max, kEnd = layout.hooks.target ? layout.hooks.max + 2 : layout.hooks.max;
  for (let k = kStart; k <= kEnd && !hooks; k++) {
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
  if (!hooks) return { ok: false, error: `hooks: no ${kStart}-${kEnd}-hook cover found` };

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
    palletSafety: perInst[k].pallets ? TILES[inst.tile].palletSafety : null,
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
    safePallets: tiles.filter(t => t.palletSafety === 'safe').reduce((s, t) => s + t.pallets, 0),
    unsafePallets: tiles.filter(t => t.palletSafety === 'unsafe').reduce((s, t) => s + t.pallets, 0),
    godPallets: tiles.filter(t => t.palletSafety === 'god').reduce((s, t) => s + t.pallets, 0),
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
    ...(layout.gens.selection ? { generatorRules: { ...layout.gens.selection } } : {}),
    spawns: { hunter: hunterSpawns, survivors: survivorSpawns },
    labels: [...(layout.labels ?? []).map(({ text, x, z }) => ({ text, x, z })), ...lmLabels],
    spawnRules: { inset: layout.spawns.inset, survivorAnchors: true },
    mapgen: {
      generator: layout.generator, seed,
      ...(shape ? { shape: { family: shape.family, tiles: layout.areaCells, areaM2: layout.areaCells * C * C, moved: layout.moved } } : {}),
      tiles, stats,
    },
  };
  return { ok: true, map, stats };
}

// Refit a layout to another outline: new size/outline; every fixed piece (the overlay group + the landmarks
// and labels that follow it, then each landmark slot) keeps its exact position if it fits inside the outline,
// else moves to the nearest free cell-aligned slot that does (rotation/mirror rules unchanged). Labels without
// a `follow` (edge numbers of the reference outline) are dropped. Pallet and hook budgets scale with playable
// area (layout.refCells = the layout's own outline area in cells). Returns null if some piece fits nowhere.
export function fitLayoutToOutline(layout, outline) {
  const C = layout.cell;
  const { cw, ch, cells } = outlineToCells(outline, C);
  const inside = (i, j) => i >= 0 && j >= 0 && i < cw && j < ch && cells[j * cw + i] === 1;
  const occ = new Uint8Array(cw * ch);
  const moved = [];
  const sizeOf = lm => (lm.tile ? TILES[lm.tile].size : Math.max(...Object.keys(layout.pools[lm.pool].tiles).map(t => TILES[t].size)));
  const fits = (i0, j0, n, blocked) => {
    for (let j = j0; j < j0 + n; j++) for (let i = i0; i < i0 + n; i++) if (!inside(i, j) || blocked(i, j)) return false;
    return true;
  };
  // nearest cell offset [di, dj] with ok(di, dj); [0, 0] first, ties broken by z then x (deterministic)
  const R = Math.max(cw, ch) + 4;
  const offsets = [];
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) offsets.push([di, dj]);
  offsets.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2) || a[1] - b[1] || a[0] - b[0]);
  const nearest = ok => offsets.find(([di, dj]) => ok(di, dj)) ?? null;
  const shift = {};   // follow key (tile id or overlay group) -> [dx, dz] metres
  const centre = {};  // follow key -> piece centre after the move (fallback spot for its label)
  // 1. overlay group (the walled MID enclosure) as one piece: its whole cell span inside, with a 1-cell margin if possible
  let overlays = layout.overlays ?? [];
  let span = null;
  if (overlays.length) {
    const s0 = {
      i0: Math.floor(Math.min(...overlays.map(o => o.x)) / C), j0: Math.floor(Math.min(...overlays.map(o => o.z)) / C),
      i1: Math.ceil(Math.max(...overlays.map(o => o.x + o.w)) / C), j1: Math.ceil(Math.max(...overlays.map(o => o.z + o.d)) / C),
    };
    const okSpan = m => (di, dj) => {
      for (let j = s0.j0 + dj - m; j < s0.j1 + dj + m; j++) for (let i = s0.i0 + di - m; i < s0.i1 + di + m; i++) if (!inside(i, j)) return false;
      return true;
    };
    // exact position whenever it fits; if it has to move, prefer a slot with a free tile ring around it
    const d = okSpan(0)(0, 0) ? [0, 0] : nearest(okSpan(1)) ?? nearest(okSpan(0));
    if (!d) return null;
    const dx = d[0] * C, dz = d[1] * C;
    shift[layout.overlayGroup ?? 'mid'] = [dx, dz];
    centre[layout.overlayGroup ?? 'mid'] = [(s0.i0 + s0.i1) * C / 2 + dx, (s0.j0 + s0.j1) * C / 2 + dz];
    if (dx || dz) moved.push({ piece: 'overlays', dx, dz });
    overlays = overlays.map(o => ({ ...o, x: o.x + dx, z: o.z + dz }));
    span = { i0: s0.i0 + d[0], j0: s0.j0 + d[1], i1: s0.i1 + d[0], j1: s0.j1 + d[1] };
  }
  const inSpan = (i, j) => span && i >= span.i0 && i < span.i1 && j >= span.j0 && j < span.j1;
  // 2. landmarks: overlay-group followers first, then fixed tiles, then pool slots (list order within each)
  const rank = lm => (lm.group ? 0 : lm.tile ? 1 : 2);
  const order = layout.landmarks.map((lm, k) => k).sort((a, b) => rank(layout.landmarks[a]) - rank(layout.landmarks[b]) || a - b);
  const landmarks = layout.landmarks.slice();
  const taken = (i, j) => occ[j * cw + i] === 1;
  for (const k of order) {
    if (layout.landmarks[k].random) continue;   // placed per seed inside the outline (generateFromLayout)
    const lm = layout.landmarks[k], n = sizeOf(lm) / C, i0 = lm.x / C, j0 = lm.z / C;
    let d = null;
    if (lm.group && shift[lm.group]) {
      const g = [shift[lm.group][0] / C, shift[lm.group][1] / C];
      d = fits(i0 + g[0], j0 + g[1], n, taken) ? g : nearest((di, dj) => fits(i0 + di, j0 + dj, n, taken));
    } else d = nearest((di, dj) => fits(i0 + di, j0 + dj, n, (i, j) => taken(i, j) || inSpan(i, j)));
    if (!d) return null;
    for (let j = j0 + d[1]; j < j0 + d[1] + n; j++) for (let i = i0 + d[0]; i < i0 + d[0] + n; i++) occ[j * cw + i] = 1;
    const dx = d[0] * C, dz = d[1] * C;
    landmarks[k] = { ...lm, x: lm.x + dx, z: lm.z + dz };
    if (lm.tile) { shift[lm.tile] = [dx, dz]; centre[lm.tile] = [lm.x + dx + n * C / 2, lm.z + dz + n * C / 2]; }
    if (dx || dz) moved.push({ piece: lm.tile ?? lm.pool, from: [lm.x, lm.z], to: [lm.x + dx, lm.z + dz] });
  }
  const labels = (layout.labels ?? []).filter(l => l.follow && shift[l.follow])
    .map(l => {
      const x = l.x + shift[l.follow][0], z = l.z + shift[l.follow][1];
      if (inside(Math.floor(x / C), Math.floor(z / C))) return { ...l, x, z };
      return { ...l, x: centre[l.follow][0], z: centre[l.follow][1] };   // label would sit beyond the outer wall
    });
  let areaCells = 0;
  for (const c of cells) areaCells += c;
  const r = areaCells / (layout.refCells ?? areaCells);
  return {
    ...layout,
    size: { w: cw * C, h: ch * C }, outline, landmarks, overlays, labels, areaCells, moved,
    pallets: { min: Math.round(layout.pallets.min * r), max: Math.round(layout.pallets.max * r) },
    hooks: { ...layout.hooks, target: Math.max(layout.hooks.min, Math.round(layout.hooks.max * r)) },
  };
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
