// Loop evaluation by "equivalent distance held" (the DBD survivor yardstick), per survivor brain instance (no
// module-level state; static parts are computed once per match, lazily, inside the instance).
//
// Anchors = windows + pallets, each with two side points s0/s1 (1.6 m either side, along the crossing axis).
// A crossing c = (anchor a, direction d): from P = s[d] to Q = s[1-d]; index c = 2a + d, reverse = c ^ 1.
//
// Per-pass gain of a crossing (seconds, x hunter speed = metres of hunter running):
//   hunter: its cheapest way from P's side to Q's side: window vault 1.7 s; pallet (dropped by the survivor) break
//           2.34 s + walk through 3.2 m; or walk around (the anchor's detour path, all anchors solid).
//   survivor: window fast vault 0.5 s (needs >= 2.5 m of run-up, else medium 0.9 s); pallet: walk the gap + drop
//           (0.8 + 0.3 s) or vault a dropped one (1.1 s).
// Circuit = cyclic sequence of crossings joined by walking legs (Q_i -> P_{i+1}, <= legMax m, all anchors solid).
// Per crossing + following leg:
//   S_i = Ts_i + L(Q_i, P_{i+1}) / vS
//   H_i = min(Th_i + L(Q_i, P_{i+1}) / vH,  L(P_i, P_{i+1}) / vH)      <- the hunter may skip the crossing and cut
//                                                                          straight to the survivor's next entry
//   held per lap = sum (H_i - S_i) * vH      (legs cost the survivor: the hunter is faster on open ground)
// A "hold" (mind-game at one window) is the circuit [a fwd, a back] with zero legs: H = min(Th, detour / vH).
// Multi-step cuts (hunter waits at a later point of the circuit) are ignored: the survivor reverses when the hunter
// commits (the brain does so). Pallets are one-shot (broken after the first pass); windows are limited by the
// entity blocker (3 vaults of one window per chase per survivor), so the expected held per chase is
//   lap1 + (laps - 1) * lapWithoutPallets,  laps = min over the circuit's windows of floor(vaultsLeft / uses).

const SQ2 = Math.SQRT2;

export class LoopModel {
  constructor(ctx, opts = {}) {
    const M = ctx.map, cfg = ctx.config;
    this.M = M;
    this.vS = (cfg.survivor && cfg.survivor.runSpeed) || 4.0;
    this.vH = (cfg.hunter && cfg.hunter.speed) || 4.6;
    this.hVault = (cfg.hunter && cfg.hunter.vaultS) || 1.7;
    this.hBreak = (cfg.hunter && cfg.hunter.breakPalletS) || 2.34;
    this.sFast = (cfg.survivor && cfg.survivor.vaultFastS) || 0.5;
    this.sMed = (cfg.survivor && cfg.survivor.vaultMediumS) || 0.9;
    this.sPalVault = (cfg.survivor && cfg.survivor.palletVaultFastS) || 1.1;
    this.sDrop = (cfg.survivor && cfg.survivor.palletDropS) || 0.3;
    this.runup = (cfg.survivor && cfg.survivor.fastVaultRunupM) || 2.5;
    this.legMax = opts.legMax ?? 16;
    this.fieldR = opts.fieldR ?? 34;        // Dijkstra radius (m); farther = "far" (capped)
    this.maxK = opts.maxK ?? 4;             // crossings per circuit
    this.keep = opts.keep ?? 16;            // circuits kept per start crossing
    const W = M.w, H = M.h;
    this.W = W; this.H = H;

    // anchors
    const anchors = [];
    for (const w of M.windows) {
      const c = { x: w.x + 0.5, z: w.z + 0.5 };
      const ax = w.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      anchors.push({ kind: 'w', id: w.id, c, s: [{ x: c.x - ax.x * 1.6, z: c.z - ax.z * 1.6 }, { x: c.x + ax.x * 1.6, z: c.z + ax.z * 1.6 }] });
    }
    M.pallets.forEach((p, i) => {
      const c = { x: p.cx, z: p.cz };
      const ax = p.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      anchors.push({ kind: 'p', i, id: p.id, p, c, s: [{ x: c.x - ax.x * 1.6, z: c.z - ax.z * 1.6 }, { x: c.x + ax.x * 1.6, z: c.z + ax.z * 1.6 }] });
    });
    anchors.forEach((a, k) => { a.k = k; });
    this.anchors = anchors;
    const nA = anchors.length;
    this.nSides = 2 * nA;

    // walk grid: all anchors solid (legs and detours never pass through a window / pallet); scanline polygon fill
    const solid = new Uint8Array(W * H).fill(1);
    for (let j = 0; j < H; j++) {
      const z = j + 0.5, xs = [], o = M.outline;
      for (let a = 0, b = o.length - 1; a < o.length; b = a++) {
        const [xa, za] = o[a], [xb, zb] = o[b];
        if ((za > z) !== (zb > z)) xs.push(((xb - xa) * (z - za)) / (zb - za) + xa);
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let i = i0; i <= i1; i++) solid[j * W + i] = 0;
      }
    }
    const fill = (x0, z0, x1, z1) => { for (let j = Math.max(0, z0); j < Math.min(H, z1); j++) for (let i = Math.max(0, x0); i < Math.min(W, x1); i++) solid[j * W + i] = 1; };
    for (const o of M.obstacles) fill(o.x, o.z, o.x + o.w, o.z + o.d);
    for (const g of M.generatorCandidates || []) fill(Math.floor(g.x), Math.floor(g.z), Math.floor(g.x) + 1, Math.floor(g.z) + 1);
    for (const w of M.windows) fill(w.x, w.z, w.x + 1, w.z + 1);
    for (const q of M.pallets) fill(q.x0 ?? q.x, q.z0 ?? q.z, q.x1 ?? q.x + 1, q.z1 ?? q.z + 1);
    this.solid = solid;
    // side point -> grid cell (snap to the nearest free cell within 1 m)
    this.sideCell = new Int32Array(this.nSides).fill(-1);
    this.sidePt = [];
    for (let a = 0; a < nA; a++) for (let d = 0; d < 2; d++) {
      const s = anchors[a].s[d]; this.sidePt.push(s);
      let best = -1, bd = Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = Math.floor(s.x) + di, j = Math.floor(s.z) + dj;
        if (i < 0 || j < 0 || i >= W || j >= H || solid[j * W + i]) continue;
        const dd = (i + 0.5 - s.x) ** 2 + (j + 0.5 - s.z) ** 2;
        if (dd < bd) { bd = dd; best = j * W + i; }
      }
      this.sideCell[2 * a + d] = best;
    }
    // side points near each other (euclid) for leg candidates
    this.near = [];
    for (let s = 0; s < this.nSides; s++) {
      const list = [], p = this.sidePt[s];
      for (let t = 0; t < this.nSides; t++) { const q = this.sidePt[t]; if ((p.x - q.x) ** 2 + (p.z - q.z) ** 2 <= this.legMax * this.legMax) list.push(t); }
      this.near.push(list);
    }
    this.fields = new Array(this.nSides).fill(null);   // lazy: Float32Array(nSides) walk distances from side s
    this.dist = new Int32Array(W * H).fill(-1);          // Dijkstra scratch (x10 units)
    this.memo = new Map();                               // start crossing -> top circuits
    this.cap = this.fieldR + 6;
  }

  // walking distance between side points (all anchors solid); >= cap means "far / unreachable"
  L(s, t) {
    if (s === t) return 0;
    let f = this.fields[s];
    if (!f) f = this.fields[s] = this.field(s);
    return f[t];
  }

  field(s) {
    const out = new Float32Array(this.nSides).fill(this.cap);
    const c0 = this.sideCell[s];
    if (c0 < 0) return out;
    const W = this.W, H = this.H, solid = this.solid, dist = this.dist, R = this.fieldR * 10;
    // bucket-queue Dijkstra, octile costs 10 / 14 (no corner cutting)
    const buckets = [[c0]]; dist[c0] = 0;
    const touched = [c0];
    for (let b = 0; b < buckets.length && b <= R; b++) {
      const bk = buckets[b]; if (!bk) continue;
      for (let q = 0; q < bk.length; q++) {
        const c = bk[q]; if (dist[c] !== b) continue;
        const i = c % W, j = (c / W) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const n = nj * W + ni;
          if (solid[n]) continue;
          if (di && dj && (solid[j * W + ni] || solid[nj * W + i])) continue;
          const nd = b + (di && dj ? 14 : 10);
          if (nd > R) continue;
          if (dist[n] >= 0 && dist[n] <= nd) continue;
          if (dist[n] < 0) touched.push(n);
          dist[n] = nd;
          (buckets[nd] || (buckets[nd] = [])).push(n);
        }
      }
    }
    for (let t = 0; t < this.nSides; t++) {
      const ct = this.sideCell[t];
      if (ct >= 0 && dist[ct] >= 0) {
        const a = this.sidePt[s], bpt = this.sidePt[t];
        // cell-centre distance + the small offsets of the real points (keeps L(s,t) ~ euclid when in the open)
        out[t] = Math.max(Math.hypot(a.x - bpt.x, a.z - bpt.z), dist[ct] / 10);
      }
    }
    for (const c of touched) dist[c] = -1;
    return out;
  }

  // entry / exit side indices
  pSide(c) { return c; }                 // P of crossing c = side 2a + d = c
  qSide(c) { return c ^ 1; }             // Q = side 2a + (1 - d)
  detour(a) { return this.L(2 * a, 2 * a + 1); }

  // hunter / survivor crossing times (static; pallets assumed present)
  thOf(c) {
    const a = this.anchors[c >> 1];
    return a.kind === 'w' ? this.hVault : this.hBreak + 3.2 / this.vH;
  }
  tsOf(c, legIn) {
    const a = this.anchors[c >> 1];
    if (a.kind === 'w') return legIn >= this.runup ? this.sFast : this.sMed;
    return Math.min(3.2 / this.vS + this.sDrop, this.sPalVault);
  }

  // evaluate a circuit (array of crossings); returns { lap, lapNP, perCross[] } in metres of hunter running
  evaluate(seq) {
    const k = seq.length, vS = this.vS, vH = this.vH;
    let lap = 0, palGain = 0, palOpen = 0;
    const palSeen = new Set();
    for (let i = 0; i < k; i++) {
      const c = seq[i], n = seq[(i + 1) % k], prev = seq[(i - 1 + k) % k];
      const leg = this.L(this.qSide(c), this.pSide(n));
      const cut = this.L(this.pSide(c), this.pSide(n)) / vH;
      // a pallet works once: after the break it's an open gap, crossed at running speed by both
      const So = 3.2 / vS + leg / vS, Ho = Math.min(3.2 / vH + leg / vH, cut), open = (Ho - So) * vH;
      if (this.anchors[c >> 1].kind === 'p' && palSeen.has(c >> 1)) { lap += open; palOpen += open; palGain += open; continue; }
      const legIn = this.L(this.qSide(prev), this.pSide(c));
      const S = this.tsOf(c, legIn) + leg / vS;
      const H = Math.min(this.thOf(c) + leg / vH, cut);
      const g = (H - S) * vH;
      lap += g;
      if (this.anchors[c >> 1].kind === 'p') { palSeen.add(c >> 1); palGain += g; palOpen += open; }
    }
    return { lap, lapNP: lap - palGain + palOpen };
  }

  // top circuits that start with crossing c (memoised; full map knowledge, static values)
  circuitsFrom(c0) {
    let m = this.memo.get(c0);
    if (m) return m;
    const out = [], path = [c0], used = new Set([c0]);
    const legMax = this.legMax, maxK = this.maxK;
    const self = this;
    function ext() {
      const last = path[path.length - 1], q = self.qSide(last);
      if (path.length >= 2 && self.L(q, self.pSide(c0)) <= legMax) {
        const seq = path.slice(), ev = self.evaluate(seq);
        if (ev.lap > 0) out.push({ seq, ...ev });
      }
      if (path.length >= maxK) return;
      for (const t of self.near[q]) {          // t = entry side index of the next crossing = crossing index
        const n = t;
        if (used.has(n) || n === c0) continue;
        if (self.L(q, t) > legMax) continue;
        used.add(n); path.push(n);
        ext();
        path.pop(); used.delete(n);
      }
    }
    ext();
    for (const o of out) o.fresh = this.expected(o, null, null);
    out.sort((a, b) => b.fresh - a.fresh);
    m = out.slice(0, this.keep);
    this.memo.set(c0, m);
    return m;
  }

  // expected held per chase for circuit o given window vault budget (vaultsLeft(anchorIndex) -> 0..3) and pallet
  // states (palletState(anchorIndex) -> 'up' | 'dropped' | 'broken'); null callbacks = fresh / all up.
  expected(o, vaultsLeft, palletState) {
    const uses = new Map();
    let hasPal = false;
    for (const c of o.seq) {
      const a = c >> 1;
      if (this.anchors[a].kind === 'w') uses.set(a, (uses.get(a) || 0) + 1);
      else { hasPal = true; if (palletState && palletState(a) === 'broken') return -Infinity; }
    }
    let laps = uses.size ? Infinity : 1;
    for (const [a, u] of uses) laps = Math.min(laps, Math.floor((vaultsLeft ? vaultsLeft(a) : 3) / u));
    if (laps < 1) return -Infinity;
    laps = Math.min(laps, 3);
    return o.lap + (laps - 1) * (hasPal ? o.lapNP : o.lap);
  }

  // distinct circuits over the whole map (canonical rotation), best first — for diagnostics
  allCircuits(filterAnchor = null) {
    const seen = new Map();
    for (let c = 0; c < this.nSides; c++) {
      if (filterAnchor && !filterAnchor(c >> 1)) continue;
      for (const o of this.circuitsFrom(c)) {
        let mi = 0; for (let i = 1; i < o.seq.length; i++) if (o.seq[i] < o.seq[mi]) mi = i;
        const key = [...o.seq.slice(mi), ...o.seq.slice(0, mi)].join(',');
        if (!seen.has(key)) seen.set(key, o);
      }
    }
    return [...seen.values()].sort((a, b) => b.fresh - a.fresh);
  }
}
