// Survivor-side belief about the HUNTER's position + a static cover map (how concealed a spot is).
//
// One instance per survivor brain closure (no module-level state; nothing is shared between survivors — each builds
// its own belief from its own obs, so the solo-queue rule holds). Only legitimate survivor info is used:
//
//   predict : the mass spreads along walkable cells at (a fraction of) hunter speed. The spread is a mix of a
//             neighbour average and a neighbour max (a "front" that advances ~1 cell per pass) so the reachable disk
//             grows linearly with time instead of like a random walk.
//   fixes   : hunter seen -> point mass (carried forward along its velocity for a moment after it disappears);
//             HUD hook notification -> blob at that hook; a teammate's fresh downed aura -> blob there;
//             HUD `chased` for teammate j + my own recent sighting of j -> partial blob near j.
//   terror  : likelihood update by distance band (layer -> band of radii; null -> outside the radius), soft edges for
//             the layer lag. The layer history gives a closing / receding trend.
//   negative: cells I can see right now (360 deg, range, line of sight) with no hunter in them -> almost no mass.
//             Only cells that hold mass are ray-tested, at ~1 Hz.
//
// Cover: per 1 m cell, computed lazily on demand (memoised per instance): mean over 16 ray directions of how much
// of the ray (out to `coverR` m) is hidden — a tall obstacle hides everything behind it, low obstacles / windows /
// pallets / generators are semi-transparent (each distinct one x0.6; hidden once visibility < 0.5, like the engine).

const TAU = Math.PI * 2;

export class HunterBelief {
  constructor(ctx, opts = {}) {
    const M = ctx.map, cfg = ctx.config;
    this.cs = opts.cellSize ?? 4;
    this.speed = (cfg.hunter && cfg.hunter.speed) || 4.6;
    this.spread = opts.spread ?? 0.8;                 // fraction of hunter speed used for the spread
    this.residual = opts.residual ?? 0.03;            // mass kept in a cell I see empty
    this.range = (cfg.sight && cfg.sight.range) || 75;
    this.TR = (cfg.senses && cfg.senses.terrorRadius) || 32;
    this.TL = (cfg.senses && cfg.senses.terrorLayers) || 3;
    this.semi = (cfg.sight && cfg.sight.semiTransparency) || 0.6;
    this.visT = (cfg.sight && cfg.sight.visThreshold) || 0.5;
    this.coverR = opts.coverR ?? 24;
    this.M = M;
    const cs = this.cs, W = M.w, H = M.h;

    // ---- fine static grid: walkable / tall / semi-transparent object id (for the cover rays) ----
    const fine = new Uint8Array(W * H);          // 1 = walkable
    const opq = new Int32Array(W * H).fill(-1);  // -2 = opaque (tall / outside), >=0 = semi-transparent object id, -1 = clear
    opq.fill(-2);
    for (let j = 0; j < H; j++) {                 // scanline polygon fill (even-odd, cell centres)
      const z = j + 0.5, xs = [], o = M.outline;
      for (let a = 0, b = o.length - 1; a < o.length; b = a++) {
        const [xa, za] = o[a], [xb, zb] = o[b];
        if ((za > z) !== (zb > z)) xs.push(((xb - xa) * (z - za)) / (zb - za) + xa);
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let i = i0; i <= i1; i++) { fine[j * W + i] = 1; opq[j * W + i] = -1; }
      }
    }
    let oid = 0;
    const put = (x0, z0, x1, z1, tall) => {
      const id = oid++;
      for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        fine[j * W + i] = 0;
        if (opq[j * W + i] !== -2) opq[j * W + i] = tall ? -2 : id;
      }
    };
    for (const o of M.obstacles) put(o.x, o.z, o.x + o.w, o.z + o.d, o.height >= M.eyeHeight);
    for (const g of [...(M.generatorCandidates || []), ...M.generators]) { const i = Math.floor(g.x), j = Math.floor(g.z); put(i, j, i + 1, j + 1, false); }
    for (const w of M.windows) { const id = oid++; if (opq[w.z * W + w.x] === -1) opq[w.z * W + w.x] = id; }
    for (const q of M.pallets) { const id = oid++; for (let j = q.z0 ?? q.z; j < (q.z1 ?? q.z + 1); j++) for (let i = q.x0 ?? q.x; i < (q.x1 ?? q.x + 1); i++) if (i >= 0 && j >= 0 && i < W && j < H && opq[j * W + i] === -1) opq[j * W + i] = id; }
    this.fine = fine; this.opq = opq;
    this.cover = new Float32Array(W * H).fill(-1);   // lazy memo

    // ---- coarse belief grid ----
    this.W = Math.ceil(W / cs); this.H = Math.ceil(H / cs);
    const N = this.W * this.H;
    this.walk = new Uint8Array(N);
    this.cx = new Float32Array(N); this.cz = new Float32Array(N);
    for (let J = 0; J < this.H; J++) for (let I = 0; I < this.W; I++) {
      let n = 0, sx = 0, sz = 0, tot = 0;
      for (let j = J * cs; j < Math.min(H, (J + 1) * cs); j++) for (let i = I * cs; i < Math.min(W, (I + 1) * cs); i++) { tot++; if (fine[j * W + i]) { n++; sx += i + 0.5; sz += j + 0.5; } }
      const c = J * this.W + I;
      this.walk[c] = n * 2 >= tot ? 1 : 0;
      // representative point: the walkable fine cell closest to the walkable centroid (so LOS tests start in the open)
      let px = I * cs + cs / 2, pz = J * cs + cs / 2;
      if (n) {
        const mx = sx / n, mz = sz / n; let bd = Infinity;
        for (let j = J * cs; j < Math.min(H, (J + 1) * cs); j++) for (let i = I * cs; i < Math.min(W, (I + 1) * cs); i++) if (fine[j * W + i]) { const d = (i + 0.5 - mx) ** 2 + (j + 0.5 - mz) ** 2; if (d < bd) { bd = d; px = i + 0.5; pz = j + 0.5; } }
      }
      this.cx[c] = px; this.cz[c] = pz;
    }
    const cl = []; for (let c = 0; c < N; c++) if (this.walk[c]) cl.push(c);
    this.cells = Int32Array.from(cl);
    // flat 8-neighbour lists (walkable only): neighbours of cells[k] are nbList[nbStart[k] .. nbStart[k+1])
    const nbs = [], start = new Int32Array(cl.length + 1);
    cl.forEach((c, k) => {
      start[k] = nbs.length;
      const I = c % this.W, J = (c / this.W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = I + di, b = J + dj;
        if (a < 0 || b < 0 || a >= this.W || b >= this.H) continue;
        if (this.walk[b * this.W + a]) nbs.push(b * this.W + a);
      }
    });
    start[cl.length] = nbs.length;
    this.nbStart = start; this.nbList = Int32Array.from(nbs);
    this.p = new Float32Array(N);
    this.tmp = new Float32Array(N);
    this.version = 0;              // bumps whenever the map changes (callers cache queries on it)
    this.hot = [];                 // cells with non-negligible mass (refreshed after each heavy step / fix)
    this.lastT = 0; this.carry = 0;
    this.notesRead = 0;
    this.seenNow = false; this.lastSeen = null;   // {x,z,vx,vz,t}
    this.carried = true;           // the last fix has been carried forward along the velocity
    this.downedKnown = new Set();
    this.layerHist = [];           // [{t, layer}] (layer 0 = no terror), changes only
    this.lastLayer = 0;
    this.lastTerrorApplyT = -99;
    this.chaseApplyT = {};

    // start: the hunter spawns far from the survivor group (spawn rule: >= a large fraction of the map's farthest path
    // distance from the survivor anchor). "Far from me" prior.
    const sp = ctx.spawn || { x: W / 2, z: H / 2 };
    let tot = 0;
    for (const c of this.cells) { const d = Math.hypot(this.cx[c] - sp.x, this.cz[c] - sp.z); const v = d ** 4; this.p[c] = v; tot += v; }
    if (tot > 0) for (const c of this.cells) this.p[c] /= tot;
    this.refreshHot();
  }

  cellAt(x, z) {
    const I = Math.min(this.W - 1, Math.max(0, Math.floor(x / this.cs))), J = Math.min(this.H - 1, Math.max(0, Math.floor(z / this.cs)));
    const c = J * this.W + I;
    if (this.walk[c]) return c;
    let best = -1, bd = Infinity;
    for (const n of this.cells) { const d = (this.cx[n] - x) ** 2 + (this.cz[n] - z) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }

  refreshHot() {
    this.version++;
    const p = this.p, hot = [];
    for (const c of this.cells) { if (p[c] > 1e-5) hot.push(c); else p[c] = 0; }   // prune negligible mass to exact 0
    this.hot = hot;
  }

  normalize() {
    const p = this.p; let tot = 0;
    for (const c of this.cells) tot += p[c];
    if (tot > 1e-12) { for (const c of this.cells) p[c] /= tot; return true; }
    return false;
  }

  // blob of mass at (x,z) with sigma `blob` cells; weight w of the map (1 = replace)
  mix(x, z, blob, w) {
    const p = this.p, q = this.tmp;
    const c0 = this.cellAt(x, z);
    if (blob <= 0 && w >= 1) { p.fill(0); p[c0] = 1; this.hot = [c0]; this.version++; return; }   // exact fix
    q.fill(0);
    let tot = 0;
    if (blob > 0) {
      const lim = 9 * blob * blob, cs2 = this.cs * this.cs;
      for (const c of this.cells) {
        const d = ((this.cx[c] - x) ** 2 + (this.cz[c] - z) ** 2) / cs2;
        if (d > lim) continue;
        q[c] = Math.exp(-d / (2 * blob * blob)); tot += q[c];
      }
    }
    if (tot <= 0) { q[c0] = 1; tot = 1; }
    if (w >= 1) { p.fill(0); for (const c of this.cells) p[c] = q[c] / tot; }
    else for (const c of this.cells) p[c] = (1 - w) * p[c] + w * q[c] / tot;
    this.refreshHot();
  }

  // ---- update from a survivor's obs; cheap every call, heavy work every `everyS` ----
  update(obs, api, everyS = 1.0, full = true) {
    const t = obs.t, h = obs.hunter;
    if (!full) {                     // only the terror-layer history (for trend()); no grid work
      const layer = obs.terror ? obs.terror.layer : 0;
      if (layer !== this.lastLayer) { this.layerHist.push({ t, from: this.lastLayer, to: layer }); if (this.layerHist.length > 8) this.layerHist.shift(); this.lastLayer = layer; }
      return;
    }
    if (h) {
      if (!this.seenNow || t - this.lastT >= 0.5) { this.mix(h.x, h.z, 0, 1); this.lastT = t; this.carry = 0; }
      this.seenNow = true; this.carried = false;
      this.lastSeen = { x: h.x, z: h.z, vx: h.vx || 0, vz: h.vz || 0, t };
    } else if (this.seenNow) {
      this.seenNow = false;
    }
    // notifications (each processed once)
    const notes = obs.notifications || [];
    for (; this.notesRead < notes.length; this.notesRead++) {
      const n = notes[this.notesRead];
      if (h) continue;
      if (n.type === 'hooked' && n.x !== undefined && t - n.t < 3) this.mix(n.x, n.z, 0.6, 0.9);
      else if (n.type === 'scream' && n.x !== undefined && t - n.t < 3) this.mix(n.x, n.z, 0.6, 0.9);
    }
    // a teammate newly downed (aura appears): the hunter just hit them
    const auras = obs.downedAuras || [];
    for (const a of auras) if (!this.downedKnown.has(a.id)) { this.downedKnown.add(a.id); if (!h) this.mix(a.x, a.z, 0.7, 0.85); }
    if (this.downedKnown.size) for (const id of [...this.downedKnown]) if (!auras.some((a) => a.id === id)) this.downedKnown.delete(id);
    // HUD chase + my own recent sighting of the chased teammate -> the hunter is near there (at most every 2 s per mate)
    if (!h && obs.hud) for (const x of obs.hud) {
      if (x.id === obs.self.id || !x.chased) continue;
      const tm = obs.teammates.find((m) => m.id === x.id);
      const ls = tm ? { x: tm.x, z: tm.z, t } : obs.lastSeen[x.id];
      if (!ls || t - ls.t > 6) continue;
      if (t - (this.chaseApplyT[x.id] ?? -99) < 2) continue;
      this.chaseApplyT[x.id] = t;
      this.mix(ls.x, ls.z, 1.5 + (t - ls.t) * 0.5, tm ? 0.7 : 0.5);
    }
    // terror layer history (for the trend)
    const layer = obs.terror ? obs.terror.layer : 0;
    if (layer !== this.lastLayer) {
      this.layerHist.push({ t, from: this.lastLayer, to: layer });
      if (this.layerHist.length > 8) this.layerHist.shift();
      this.lastLayer = layer;
      if (!h) this.terror(obs, layer);   // apply the new band at once
    }
    if (h) return;
    if (t - this.lastT < everyS) return;
    const dt = t - this.lastT; this.lastT = t;
    // just lost sight: carry the last fix forward along its velocity (~1.5 s worth)
    if (!this.carried && this.lastSeen) {
      this.carried = true;
      const L = this.lastSeen, k = Math.min(1.5, t - L.t);
      this.mix(L.x + L.vx * k, L.z + L.vz * k, 0.5, 1);
    }
    this.predict(dt);
    this.terror(obs, layer);
    this.negative(obs, api);
    this.refreshHot();
  }

  predict(dt) {
    this.carry += (this.speed * dt * this.spread) / this.cs;
    const passes = Math.floor(this.carry); this.carry -= passes;
    const p = this.p, q = this.tmp;
    for (let it = 0; it < passes; it++) {
      const cells = this.cells, st = this.nbStart, nl = this.nbList;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k], e = st[k + 1];
        let s = p[c], mx = s;
        for (let m = st[k]; m < e; m++) { const v = p[nl[m]]; s += v; if (v > mx) mx = v; }
        q[c] = 0.5 * s / (e - st[k] + 1) + 0.5 * mx;
      }
      p.set(q);
      this.normalize();
    }
    if (passes) this.refreshHot();
  }

  // likelihood of the heard terror layer given the hunter at distance d from me
  terrorLik(layer, d) {
    const R = this.TR, w = R / this.TL;
    if (layer === 0) return d > R + 2 ? 1 : (d > R - 4 ? 0.3 : 0.03);
    const hi = R - (layer - 1) * w, lo = R - layer * w;   // band [lo, hi]
    const slack = 5;                                        // layer lag (2.5 s) + entry lag
    if (d >= lo && d <= hi) return 1;
    const ex = d < lo ? lo - d : d - hi;
    return Math.max(0.01, Math.exp(-(ex * ex) / (2 * slack * slack)));
  }

  terror(obs, layer) {
    const me = obs.self, p = this.p, cx = this.cx, cz = this.cz;
    let tot = 0;
    for (const c of this.hot) {          // mass outside `hot` is exactly 0 (pruned)
      const dx = cx[c] - me.x, dz = cz[c] - me.z;
      p[c] *= this.terrorLik(layer, Math.sqrt(dx * dx + dz * dz)); tot += p[c];
    }
    if (tot > 1e-12) for (const c of this.hot) p[c] /= tot;
    else this.resetRing(me, layer);
    this.refreshHot();
  }

  // the belief contradicts what I hear: spread uniformly over the plausible band
  resetRing(me, layer) {
    const p = this.p;
    for (const c of this.cells) { const dx = this.cx[c] - me.x, dz = this.cz[c] - me.z; p[c] = this.terrorLik(layer, Math.sqrt(dx * dx + dz * dz)); }
    this.normalize();
  }

  negative(obs, api) {
    const me = obs.self, p = this.p, r2 = this.range * this.range;
    let hit = 0;
    for (const c of this.hot) {
      if (p[c] < 3e-4) continue;          // not worth a ray
      const dx = this.cx[c] - me.x, dz = this.cz[c] - me.z;
      if (dx * dx + dz * dz > r2) continue;
      if (api.los(me, { x: this.cx[c], z: this.cz[c] })) { p[c] *= this.residual; hit++; }
    }
    if (hit && !this.normalize()) this.resetRing(me, this.lastLayer);
  }

  // ---- queries ----
  trend(now, windowS = 4) {        // +1 terror got closer recently, -1 farther, 0 none
    for (let i = this.layerHist.length - 1; i >= 0; i--) {
      const e = this.layerHist[i];
      if (now - e.t > windowS) break;
      return e.to > e.from ? 1 : -1;
    }
    return 0;
  }

  pHunterWithin(pt, r) {
    const p = this.p, r2 = r * r; let m = 0;
    for (const c of this.hot) if ((this.cx[c] - pt.x) ** 2 + (this.cz[c] - pt.z) ** 2 <= r2) m += p[c];
    return m;
  }

  expectedPos() {
    const p = this.p; let x = 0, z = 0, m = 0;
    for (const c of this.hot) { x += p[c] * this.cx[c]; z += p[c] * this.cz[c]; m += p[c]; }
    return m > 0 ? { x: x / m, z: z / m } : null;
  }

  // threat at pt: probability-weighted closeness of the hunter (1 inside r, linear falloff to 0 at 2r)
  threatAt(pt, r = 16) {
    const p = this.p; let m = 0;
    const r2 = 4 * r * r;
    for (const c of this.hot) {
      const d2 = (this.cx[c] - pt.x) ** 2 + (this.cz[c] - pt.z) ** 2;
      if (d2 >= r2) continue;
      const d = Math.sqrt(d2);
      m += p[c] * (d <= r ? 1 : 2 - d / r);
    }
    return m;
  }

  // the k most likely hunter cells as [{x, z, p}]
  topCells(k = 12) {
    const p = this.p;
    return this.hot.slice().sort((a, b) => p[b] - p[a]).slice(0, k).map((c) => ({ x: this.cx[c], z: this.cz[c], p: p[c] }));
  }

  // expected exposure of pt: probability mass (over the k likeliest hunter cells, renormalised) with line of sight to pt
  // within sight range. Ignores the hunter's facing (it turns at 450 deg/s).
  exposure(api, pt, top) {
    let m = 0, tot = 0;
    const r2 = this.range * this.range;
    for (const c of top) {
      tot += c.p;
      if ((c.x - pt.x) ** 2 + (c.z - pt.z) ** 2 <= r2 && api.los(c, pt)) m += c.p;
    }
    return tot > 0 ? m / tot : 0;
  }

  heat() { return Float32Array.from(this.p); }   // per coarse cell (W x H, cs m), for a viewer overlay

  // ---- cover ----
  coverAt(x, z) {
    const W = this.M.w, H = this.M.h, i = Math.floor(x), j = Math.floor(z);
    if (i < 0 || j < 0 || i >= W || j >= H) return 0;
    const k = j * W + i;
    if (this.cover[k] >= 0) return this.cover[k];
    const v = this.computeCover(i + 0.5, j + 0.5);
    this.cover[k] = v;
    return v;
  }

  computeCover(x, z) {
    const W = this.M.w, H = this.M.h, R = this.coverR, opq = this.opq, step = 0.5;
    let sum = 0;
    const D = 16;
    for (let k = 0; k < D; k++) {
      const a = (k / D) * TAU, ux = Math.cos(a), uz = Math.sin(a);
      let vis = 1, lastId = -1, hiddenAt = R;
      const startCell = Math.floor(z) * W + Math.floor(x);
      for (let s = step; s <= R; s += step) {
        const i = Math.floor(x + ux * s), j = Math.floor(z + uz * s);
        if (i < 0 || j < 0 || i >= W || j >= H) { hiddenAt = s; break; }
        const cell = j * W + i;
        if (cell === startCell) continue;
        const o = opq[cell];
        if (o === -2) { hiddenAt = s; break; }
        if (o >= 0 && o !== lastId) { lastId = o; vis *= this.semi; if (vis < this.visT) { hiddenAt = s; break; } }
      }
      sum += 1 - hiddenAt / R;
    }
    return sum / D;
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
