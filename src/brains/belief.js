// Hunter belief model: one probability map per survivor over a coarse grid ("where could they be?").
//
//   predict : every update, each survivor's mass spreads along walkable cells at roughly running speed, so
//             "unhooked at the hook 5 s ago" becomes "somewhere within ~20 m of walkable path of that hook".
//             A mild pull toward unfinished generators encodes "survivors go back to gens".
//   negative: cells the hunter can see right now (cone + range + line of sight) and that hold no visible
//             survivor lose almost all their mass ("I'm looking there and nobody's there").
//   positive: exact fixes collapse a map to a point (seen, hooked, carried); partial fixes (gen pop, fumble,
//             fast-vault noise, repair noise, grunt, scratch marks, an unhook) put a blob on the survivor whose
//             current map makes them the most likely source.
//
// Pure brain-side: uses only the hunter's own obs + api (no engine internals). One instance per hunter brain
// (lives in the brain closure; no module-level state).

export class SurvivorBelief {
  constructor(ctx, opts = {}) {
    const M = ctx.map;
    this.cs = opts.cellSize ?? 3;                     // metres per belief cell
    this.speed = opts.speed ?? 4.0;                   // survivor running speed used for the spread
    this.spread = opts.spread ?? 0.6;                 // 0..1: how much of the reachable spread to apply (survivors don't run straight lines)
    this.genPull = opts.genPull ?? 0.5;               // per-second relative growth of mass near unfinished gens
    this.residual = opts.residual ?? 0.05;            // mass kept in a cell we're looking at and see empty
    this.range = (ctx.config.sight && ctx.config.sight.range) || 75;
    this.halfFov = (((ctx.config.sight && ctx.config.sight.hunterFovDeg) || 100) / 2) * Math.PI / 180;
    const cs = this.cs;
    this.W = Math.ceil(M.w / cs); this.H = Math.ceil(M.h / cs);
    const N = this.W * this.H;
    // walkable fraction per belief cell from the static map (outline minus obstacles and generator cells)
    const fine = new Uint8Array(M.w * M.h);
    for (let j = 0; j < M.h; j++) for (let i = 0; i < M.w; i++) fine[j * M.w + i] = inPoly(i + 0.5, j + 0.5, M.outline) ? 1 : 0;
    for (const o of M.obstacles) for (let j = o.z; j < o.z + o.d; j++) for (let i = o.x; i < o.x + o.w; i++) if (i >= 0 && j >= 0 && i < M.w && j < M.h) fine[j * M.w + i] = 0;
    for (const g of [...(M.generatorCandidates || []), ...M.generators]) { const i = Math.floor(g.x), j = Math.floor(g.z); if (i >= 0 && j >= 0 && i < M.w && j < M.h) fine[j * M.w + i] = 0; }
    this.walk = new Uint8Array(N);
    this.cx = new Float32Array(N); this.cz = new Float32Array(N);
    for (let J = 0; J < this.H; J++) for (let I = 0; I < this.W; I++) {
      let n = 0, sx = 0, sz = 0, tot = 0;
      for (let j = J * cs; j < Math.min(M.h, (J + 1) * cs); j++) for (let i = I * cs; i < Math.min(M.w, (I + 1) * cs); i++) { tot++; if (fine[j * M.w + i]) { n++; sx += i + 0.5; sz += j + 0.5; } }
      const c = J * this.W + I;
      this.walk[c] = n * 2 >= tot ? 1 : 0;
      this.cx[c] = n ? sx / n : I * cs + cs / 2; this.cz[c] = n ? sz / n : J * cs + cs / 2;
    }
    this.cells = []; for (let c = 0; c < N; c++) if (this.walk[c]) this.cells.push(c);
    // neighbour lists (8-connected, walkable)
    this.nb = this.cells.map(() => null);
    this.nbOf = new Array(N);
    for (const c of this.cells) {
      const I = c % this.W, J = (c / this.W) | 0, list = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = I + di, b = J + dj;
        if (a < 0 || b < 0 || a >= this.W || b >= this.H) continue;
        const n = b * this.W + a;
        if (this.walk[n]) list.push(n);
      }
      this.nbOf[c] = list;
    }
    this._hooks = new Map(M.hooks.map((h) => [h.id, h]));
    this.genCells = new Map();                        // gen id -> cell
    for (const g of M.generators) this.genCells.set(g.id, this.cellAt(g.x, g.z));
    this.p = [0, 1, 2, 3].map(() => new Float32Array(N));
    this.tmp = new Float32Array(N);
    this.state = ['alive', 'alive', 'alive', 'alive'];  // alive | hooked | carried | gone
    this.lastT = 0;
    this.prevHooked = new Map();                       // survivor id -> hook position
    this.notesRead = 0;
    this.lastGruntT = -1; this.lastScratchT = -1; this.lastNoiseT = -99;
    this.carry = 0;                                    // fractional "cells to spread" carried between updates
    // start: the hunter knows the spawn rules. Survivors spawn as a group (within spawn.groupRadius) around one of the
    // map's survivor anchors, and the hunter is placed on a candidate whose path distance from that anchor is at least
    // spawn.hunterMinFrac x the farthest walkable cell. So the plausible anchors are the ones my own spawn is
    // consistent with; put each survivor's mass in tight blobs around those.
    this.initFromSpawnRules(ctx);
  }

  initFromSpawnRules(ctx) {
    const M = ctx.map, sp = ctx.spawn, nav = ctx.nav, sc = ctx.config.spawn || {};
    const frac = sc.hunterMinFrac ?? 0.8, group = sc.groupRadius ?? 12;
    const anchors = (M.spawns && M.spawns.survivors) || [];
    const plausible = [];
    for (const a of anchors) {
      let maxD = 0;
      for (const c of this.cells) { const d = nav.dist({ x: this.cx[c], z: this.cz[c] }, a); if (d < Infinity && d > maxD) maxD = d; }
      const dMe = nav.dist(sp, a);
      if (dMe < Infinity && dMe >= frac * maxD - this.cs * 2) plausible.push(a);
    }
    const sigma = Math.max(this.cs, group / 2);     // survivors sit within ~group m of the anchor
    for (let k = 0; k < 4; k++) {
      const p = this.p[k]; p.fill(0);
      let tot = 0;
      for (const c of this.cells) {
        let v = 0;
        if (plausible.length) for (const a of plausible) v += Math.exp(-((this.cx[c] - a.x) ** 2 + (this.cz[c] - a.z) ** 2) / (2 * sigma * sigma));
        else { const d = Math.hypot(this.cx[c] - sp.x, this.cz[c] - sp.z); v = d ** 4; }   // no anchors: "far from me"
        p[c] = v; tot += v;
      }
      if (tot > 0) for (const c of this.cells) p[c] /= tot;
    }
    this.plausibleAnchors = plausible;
  }

  cellAt(x, z) {
    const I = Math.min(this.W - 1, Math.max(0, Math.floor(x / this.cs))), J = Math.min(this.H - 1, Math.max(0, Math.floor(z / this.cs)));
    let c = J * this.W + I;
    if (this.walk[c]) return c;
    let best = -1, bd = Infinity;                      // snap to the nearest walkable cell
    for (const n of this.cells) { const d = (this.cx[n] - x) ** 2 + (this.cz[n] - z) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }

  // collapse survivor k onto a point (sigma in cells: 0 = single cell)
  fix(k, x, z, blob = 0) {
    const p = this.p[k]; p.fill(0);
    const c0 = this.cellAt(x, z);
    if (!blob) { p[c0] = 1; return; }
    let tot = 0;
    for (const c of this.cells) {
      const d2 = ((this.cx[c] - x) ** 2 + (this.cz[c] - z) ** 2) / (this.cs * this.cs);
      if (d2 > 9 * blob * blob) continue;
      p[c] = Math.exp(-d2 / (2 * blob * blob)); tot += p[c];
    }
    if (tot <= 0) { p[c0] = 1; return; }
    for (const c of this.cells) p[c] /= tot;
  }

  // probability that survivor k is within r metres of (x,z)
  massNear(k, x, z, r) {
    const p = this.p[k], r2 = r * r; let m = 0;
    for (const c of this.cells) if (p[c] > 0 && (this.cx[c] - x) ** 2 + (this.cz[c] - z) ** 2 <= r2) m += p[c];
    return m;
  }

  // the alive, free survivor most likely to be the source of something at (x,z); optional state filter
  likeliestSource(x, z, r = 8, filter = null) {
    let best = -1, bm = -1;
    for (let k = 0; k < 4; k++) {
      if (this.state[k] !== 'alive' || (filter && !filter(k))) continue;
      const m = this.massNear(k, x, z, r);
      if (m > bm) { bm = m; best = k; }
    }
    return best;
  }

  // ---- update from the hunter's observation (call once per decide; does the heavy work every `everyS`) ----
  update(obs, api, everyS = 1.0) {
    const t = obs.t;
    // statuses + exact fixes
    const hookedNow = new Map(obs.hooked.map((h) => [h.id, h]));
    for (let k = 0; k < 4; k++) {
      if (obs.status[k] !== 'alive') { this.state[k] = 'gone'; this.p[k].fill(0); continue; }
      if (obs.self.carrying === k) { this.state[k] = 'carried'; this.fix(k, obs.self.x, obs.self.z); continue; }
      const h = hookedNow.get(k);
      if (h) {
        this.state[k] = 'hooked';
        const pos = this.hookPos(api, h.hookId);
        this.prevHooked.set(k, pos);
        if (pos) this.fix(k, pos.x, pos.z);
        continue;
      }
      if (this.state[k] === 'hooked') {
        // came off the hook since last time: they're at the hook now, and (probably) so is a rescuer
        const pos = this.prevHooked.get(k);
        this.state[k] = 'alive';
        if (pos) {
          this.fix(k, pos.x, pos.z);
          const r = this.likeliestSource(pos.x, pos.z, 40, (j) => j !== k);
          if (r >= 0) this.mix(r, pos.x, pos.z, 1, 0.7);
        }
        continue;
      }
      if (this.state[k] !== 'alive') this.state[k] = 'alive';
    }
    for (const s of obs.survivors) if (this.state[s.id] === 'alive') this.fix(s.id, s.x, s.z);

    // partial fixes from notifications / sounds / marks
    const notes = obs.notifications || [];
    for (; this.notesRead < notes.length; this.notesRead++) {
      const n = notes[this.notesRead];
      if (n.x === undefined) continue;
      if (n.type === 'genDone' || n.type === 'fumble' || n.type === 'loudNoise') this.attribute(n.x, n.z, n.type === 'genDone' ? 0.6 : 0.9, 1);
    }
    // sounds/marks persist in obs for a while: only act on new ones (repair noise at most every 2 s)
    if (obs.noisyGens && obs.noisyGens.length && t - this.lastNoiseT >= 2) { this.lastNoiseT = t; for (const g of obs.noisyGens) this.attribute(g.x, g.z, 0.9, 1); }
    for (const g of obs.grunts || []) if (g.t > this.lastGruntT) { this.lastGruntT = g.t; this.attribute(g.x, g.z, 0.8, 1); }
    const sc = obs.scratches && obs.scratches[obs.scratches.length - 1];
    if (sc && sc.t > this.lastScratchT + 1) { this.lastScratchT = sc.t; this.attribute(sc.x, sc.z, 0.6, 1.5); }

    if (t - this.lastT < everyS) return;
    const dt = t - this.lastT; this.lastT = t;
    this.predict(obs, dt);
    this.negative(obs, api);
  }

  hookPos(api, hookId) { return this._hooks.get(hookId) || null; }

  // put `w` of survivor k's mass into a blob at (x,z) (w = 1 replaces the map)
  mix(k, x, z, blob, w) {
    if (w >= 1) { this.fix(k, x, z, blob); return; }
    const old = Float32Array.from(this.p[k]);
    this.fix(k, x, z, blob);
    const p = this.p[k];
    for (const c of this.cells) p[c] = (1 - w) * old[c] + w * p[c];
  }

  attribute(x, z, w, blob) {
    const k = this.likeliestSource(x, z, 12);
    if (k >= 0) this.mix(k, x, z, blob, w);
  }

  predict(obs, dt) {
    // number of neighbour-diffusion passes ~ distance a survivor could cover, in cells, times `spread`
    this.carry += (this.speed * dt * this.spread) / this.cs;
    const passes = Math.floor(this.carry); this.carry -= passes;
    const open = new Set();
    for (let i = 0; i < obs.gens.length; i++) if (!obs.gens[i].done) open.add(this.genCells.get(obs.gens[i].id));
    for (let k = 0; k < 4; k++) {
      if (this.state[k] !== 'alive') continue;
      const p = this.p[k], q = this.tmp;
      for (let it = 0; it < passes; it++) {
        q.fill(0);
        for (const c of this.cells) {
          const v = p[c]; if (v === 0) continue;
          const nb = this.nbOf[c], share = v * 0.5 / nb.length;
          q[c] += v * 0.5;                                   // half stays, half moves to neighbours
          for (const n of nb) q[n] += share;
        }
        p.set(q);
      }
      if (this.genPull > 0) {
        let tot = 0;
        for (const c of this.cells) { if (open.has(c)) p[c] *= 1 + this.genPull * dt; tot += p[c]; }
        if (tot > 0) for (const c of this.cells) p[c] /= tot;
      }
    }
  }

  negative(obs, api) {
    const me = obs.self, fx = Math.cos(me.facing), fz = Math.sin(me.facing), cosH = Math.cos(this.halfFov), r2 = this.range * this.range;
    const seen = new Set(obs.survivors.map((s) => s.id));
    const mass = this.tmp; mass.fill(0);
    for (let k = 0; k < 4; k++) if (this.state[k] === 'alive' && !seen.has(k)) { const p = this.p[k]; for (const c of this.cells) mass[c] += p[c]; }
    const empty = [];
    for (const c of this.cells) {
      if (mass[c] < 1e-4) continue;                         // only bother where it matters
      const dx = this.cx[c] - me.x, dz = this.cz[c] - me.z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      if (d > 1.5 && dx * fx + dz * fz < d * cosH) continue;
      if (api.los(me, { x: this.cx[c], z: this.cz[c] })) empty.push(c);
    }
    if (!empty.length) return;
    for (let k = 0; k < 4; k++) {
      if (this.state[k] !== 'alive' || seen.has(k)) continue;
      const p = this.p[k];
      for (const c of empty) p[c] *= this.residual;
      let tot = 0; for (const c of this.cells) tot += p[c];
      if (tot > 1e-9) for (const c of this.cells) p[c] /= tot;
    }
  }

  // total mass of free (alive, not hooked/carried) survivors per cell, for patrol targeting and the viewer
  heat() {
    const h = new Float32Array(this.W * this.H);
    for (let k = 0; k < 4; k++) if (this.state[k] === 'alive') { const p = this.p[k]; for (const c of this.cells) h[c] += p[c]; }
    return h;
  }

  // best cell to go to: expected survivors within `r` m minus a distance cost (path metres * distW / 100)
  bestTarget(me, nav, r = 9, distW = 1) {
    const h = this.heat(), r2 = r * r;
    // coarse kernel sum over cells with mass
    const hot = this.cells.filter((c) => h[c] > 1e-3);
    if (!hot.length) return null;
    let best = null, bs = -Infinity;
    for (const c of hot) {
      let m = 0;
      for (const n of hot) if ((this.cx[n] - this.cx[c]) ** 2 + (this.cz[n] - this.cz[c]) ** 2 <= r2) m += h[n];
      const pt = { x: this.cx[c], z: this.cz[c] };
      const s = m - (distW * Math.hypot(pt.x - me.x, pt.z - me.z)) / 100;
      if (s > bs) { bs = s; best = pt; }
    }
    return best;
  }
}

function inPoly(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
