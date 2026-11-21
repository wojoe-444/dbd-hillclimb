// Loop evaluation by "equivalent distance held" (the DBD survivor yardstick), per survivor brain instance (no
// module-level state; static parts are computed once per match, lazily, inside the instance).
//
// Anchors = windows + pallets, each with two side points s0/s1 (1.6 m either side, along the crossing axis).
// A crossing c = (anchor a, direction d): from P = s[d] to Q = s[1-d]; index c = 2a + d, reverse = c ^ 1.
//
// Per-pass gain of a crossing (seconds, x hunter speed = metres of hunter running):
//   hunter: its cheapest way from P's side to Q's side: window vault 1.7 s; pallet (dropped by the survivor) break
//           2.34 s + walk through 3.2 m; or walk around (the anchor's detour path, all anchors solid).
//   survivor: window fast vault 0.5 s (needs >= 2.5 m of straight run-up, else medium 0.9 s; with a lineup point the
//           price is the tier the brain's approach will produce, incl. the extra run-up path: tsIn); pallet: walk the gap + drop
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

import { accelCosts } from './accel.js';

const SQ2 = Math.SQRT2;
// Directions in row order: NW, N, NE, W, E, SW, S, SE.
const DIAGONAL_NEIGHBORS = 0b10100101;

export class LoopModel {
  constructor(ctx, opts = {}) {
    const M = ctx.map, cfg = ctx.config;
    this.M = M;
    this.vS = (cfg.survivor && cfg.survivor.runSpeed) || 4.0;
    this.vH = (cfg.hunter && cfg.hunter.speed) || 4.6;
    // crossing times include the re-acceleration after standing (accel.js): a medium vault lands at 0 speed, a pallet
    // drop / break is done standing, the hunter lands its vault at 0 (hunter.vaultExitReset); a fast window vault and
    // a rushed pallet vault keep their speed
    const ac = accelCosts(cfg);
    this.hVault = ((cfg.hunter && cfg.hunter.vaultS) || 1.7) + ac.hVaultLoss;
    this.hBreak = ((cfg.hunter && cfg.hunter.breakPalletS) || 2.34) + ac.hLoss;
    this.sFast = (cfg.survivor && cfg.survivor.vaultFastS) || 0.5;
    this.sMed = ((cfg.survivor && cfg.survivor.vaultMediumS) || 0.9) + ac.sLoss;
    this.sPalVault = (cfg.survivor && cfg.survivor.palletVaultFastS) || 1.1;
    this.sDrop = ((cfg.survivor && cfg.survivor.palletDropS) || 0.3) + ac.sLoss;
    this.coneCos = Math.cos((((cfg.survivor && cfg.survivor.fastVaultAngleDeg) || 25) * Math.PI) / 180);
    this.runup = (cfg.survivor && cfg.survivor.fastVaultRunupM) || 2.5;
    // fast-vault run-up geometry: the engine starts a window vault when the body is within radius + 0.3 m of the window
    // cell (0.5 + 0.4 + 0.3 = 1.2 m from its centre); a fast vault needs >= runup m of straight running by then, so the
    // final straight must start >= runNeed m out on the window's axis (+ 0.2 m steering slack)
    this.trig = 0.5 + (cfg.radius ?? 0.4) + 0.3;
    this.runNeed = this.trig + this.runup + 0.2;
    // lineup (survivor knobs vaultLineup / vaultApproachM / vaultDetourW / vaultFunnelDeg / vaultAngleW): a running
    // crossing lines up in front of the window (<= approachM out) and runs straight in when the extra path x detourW is
    // worth the fast-vault saving; off (default) = no lineup points, the pre-lineup pricing (tsOf), routes.js unchanged
    this.lineupOn = !!opts.lineup && (opts.approachM ?? 4) >= this.runNeed;
    this.approachM = opts.approachM ?? 4;
    this.detourW = opts.detourW ?? 1;
    this.tierW = opts.tierW ?? 1;            // weight of the executed tier's cost over a fast vault in circuit pricing (1 = as executed)
    // funnel: the straight-in run may start up to funnelDeg off the axis (the engine allows fastVaultAngleDeg; the brain
    // steers that run itself, moveDir, since the nav would detour via the approach cell centre beyond ~13 deg)
    const cone = (cfg.survivor && cfg.survivor.fastVaultAngleDeg) || 25;
    this.funnelTan = Math.tan((Math.min(opts.funnelDeg ?? 20, cone - 1) * Math.PI) / 180);
    this.aimU = 0.5 + (cfg.radius ?? 0.4);   // body centre when it touches the window cell face (where the vault starts)
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
    // lineup per crossing c (windows only; null when no straight run-up fits or lineup is off): options = straight-in
    // runs at 9 angles across the funnel (lateral slope t = w / (u - aimU)), each with the farthest start point D
    // (<= approachM, >= runNeed out) whose straight line to the aim point is clear for the body; main = the most
    // central option (its cell is where the walk fields measure the lineup distance)
    this.lineup = new Array(this.nSides).fill(null);
    this.laneCells = new Array(this.nSides).fill(0);   // free cells straight out from the window on P's side (lane room, m)
    for (let c = 0; c < this.nSides; c++) {
      const a = anchors[c >> 1];
      if (a.kind !== 'w') continue;
      const P0 = a.s[c & 1], ux = (P0.x - a.c.x) / 1.6, uz = (P0.z - a.c.z) / 1.6, ci = Math.floor(a.c.x), cj = Math.floor(a.c.z);
      let k = 0;
      for (; k < 12; k++) {
        const i = ci + Math.round(ux) * (k + 1), j = cj + Math.round(uz) * (k + 1);
        if (i < 0 || j < 0 || i >= W || j >= H || solid[j * W + i]) break;
      }
      this.laneCells[c] = k;
      if (!this.lineupOn) continue;
      const aim = this.aimPt(c), opts = [], tm = 0.85 * this.funnelTan;
      for (let q = -4; q <= 4; q++) {
        const t = (tm * q) / 4;
        for (let D = Math.min(this.approachM, 8); D >= this.runNeed - 1e-9; D -= 0.25) {
          const x = a.c.x + ux * D - uz * t * (D - this.aimU), z = a.c.z + uz * D + ux * t * (D - this.aimU);
          if (this.clearRun(x, z, aim.x, aim.z)) { opts.push({ t, D, x, z, cell: Math.floor(z) * W + Math.floor(x) }); break; }
        }
      }
      if (!opts.length) continue;
      let main = opts[0]; for (const o of opts) if (Math.abs(o.t) < Math.abs(main.t) - 1e-9) main = o;
      this.lineup[c] = { ...main, opts };
    }
    this.fields = new Array(this.nSides).fill(null);   // lazy: Float32Array(2 nSides) walk distances from side s (to sides, then to lineup points)
    this.dist = new Int32Array(W * H).fill(-1);          // Dijkstra scratch (x10 units)
    this.neighborMasks = null;
    this.fieldOffsets = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
    this.fieldBuckets = [];
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
  // walking distance from side s to crossing c's lineup point (cap if none / far)
  LA(s, c) {
    let f = this.fields[s];
    if (!f) f = this.fields[s] = this.field(s);
    return f[this.nSides + c];
  }
  // crossing c's lane frame: u = distance out from the window centre on P's side, w = signed lateral offset
  laneUW(c, pt) {
    const a = this.anchors[c >> 1], P0 = a.s[c & 1], ux = (P0.x - a.c.x) / 1.6, uz = (P0.z - a.c.z) / 1.6;
    return { u: (pt.x - a.c.x) * ux + (pt.z - a.c.z) * uz, w: -(pt.x - a.c.x) * uz + (pt.z - a.c.z) * ux, ux, uz };
  }
  // the aim point of a straight-in run (body touching the window face, on the lane centre)
  aimPt(c) { const a = this.anchors[c >> 1], P0 = a.s[c & 1], k = this.aimU / 1.6; return { x: a.c.x + (P0.x - a.c.x) * k, z: a.c.z + (P0.z - a.c.z) * k }; }
  // a straight run from (x0,z0) to (x1,z1) stays clear of walls / anchors for the body (static grid, ~0.36 m radius)
  clearRun(x0, z0, x1, z1) {
    const W = this.W, H = this.H, solid = this.solid, L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 0.2)), r = 0.36;
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n, z = z0 + ((z1 - z0) * k) / n;
      for (let q = 0; q < 5; q++) {
        const px = x + (q === 1 ? r : q === 2 ? -r : 0), pz = z + (q === 3 ? r : q === 4 ? -r : 0), i = Math.floor(px), j = Math.floor(pz);
        if (i < 0 || j < 0 || i >= W || j >= H || solid[j * W + i]) return false;
      }
    }
    return true;
  }
  // is pt inside crossing c's fast-vault funnel: >= runNeed out on P's side, within funnelTan of the axis as seen from
  // the aim point, with a clear straight line to it: running straight at the aim point from here gives a fast vault
  inFunnel(c, pt) {
    const { u, w } = this.laneUW(c, pt);
    if (u < this.runNeed - 0.1 || u > 12 || Math.abs(w) > this.funnelTan * (u - this.aimU)) return false;
    const ap = this.aimPt(c);
    return this.clearRun(pt.x, pt.z, ap.x, ap.z);
  }
  // still on a straight-in run (lined up earlier): out in front of the window, roughly in the funnel, clear line
  straightIn(c, pt) {
    const { u, w } = this.laneUW(c, pt);
    if (u <= this.aimU + 0.15 || u > 12 || Math.abs(w) > this.funnelTan * (u - this.aimU) + 0.3) return false;
    const ap = this.aimPt(c);
    return this.clearRun(pt.x, pt.z, ap.x, ap.z);
  }
  // where to line up for crossing c when coming from `from`: the lineup option angled toward `from` (up to the
  // funnel's edge: a shorter detour than the axis point), and the extra path vs taking the entry point:
  //   ext = d(from -> target) + d(target -> aim point) - d(from -> P) - d(P -> aim point)
  // dA / dP: path distances from `from` to the main lineup point / to P (walls); the option's offset from the main
  // point is credited at its Euclidean saving. Returns null without a lineup.
  lineupExt(c, from, dA, dP) {
    const lu = this.lineup[c];
    if (!lu) return null;
    const { u, w } = this.laneUW(c, from), ap = this.aimPt(c);
    // the option whose angle is nearest my side of the funnel (from beside / behind the window: the widest on my side)
    const want = u > this.aimU + 0.5 ? w / (u - this.aimU) : Math.sign(w) * 9;
    let o = lu.opts[0]; for (const q of lu.opts) if (Math.abs(q.t - want) < Math.abs(o.t - want) - 1e-9) o = q;
    const eT = Math.hypot(from.x - o.x, from.z - o.z);
    const dT = Math.max(eT, dA - Math.hypot(from.x - lu.x, from.z - lu.z) + eT);
    const ext = dT + Math.hypot(o.x - ap.x, o.z - ap.z) - dP - (1.6 - this.aimU);
    return { x: o.x, z: o.z, ext: Math.max(0, ext), dT };
  }
  // lining up is worth it when the extra path x detourW costs less than a fast vault saves (same rule in the brain)
  lineupWorth(ext) { return (ext / this.vS) * this.detourW < this.sMed - this.sFast; }
  // survivor time for crossing c entered from side `from` (the previous crossing's landing side) with legIn m of walk,
  // as executed: with a lineup point, fast + the extra run-up path if lining up is worth it (extra / vS x detourW <
  // medium - fast), else medium; x tierW (knob vaultAngleW: 1 = priced as executed, 0 = every window as a fast vault);
  // without a lineup the incoming leg's geometry decides (natural straight run-up or not; the pre-lineup pricing)
  tsIn(c, from, legIn) {
    const x = this.lineupExt(c, this.sidePt[from], this.LA(from, c), legIn);
    if (!x) return this.tsOf(c, legIn, this.sidePt[from]);
    const t = this.lineupWorth(x.ext) ? this.sFast + x.ext / this.vS : this.sMed;
    return this.sFast + this.tierW * (t - this.sFast);
  }

  walkNeighborMask(c) {
    const { W, solid } = this;
    const i = c % W;
    const north = c >= W && !solid[c - W], south = c + W < solid.length && !solid[c + W];
    const west = i > 0 && !solid[c - 1], east = i < W - 1 && !solid[c + 1];
    let mask = (north << 1) | (west << 3) | (east << 4) | (south << 6);
    // A diagonal is legal only when both adjacent cardinal cells are open.
    if (north && west && !solid[c - W - 1]) mask |= 1 << 0;
    if (north && east && !solid[c - W + 1]) mask |= 1 << 2;
    if (south && west && !solid[c + W - 1]) mask |= 1 << 5;
    if (south && east && !solid[c + W + 1]) mask |= 1 << 7;
    return mask;
  }

  field(s) {
    const out = new Float32Array(2 * this.nSides).fill(this.cap);
    const c0 = this.sideCell[s];
    if (c0 < 0) return out;
    const dist = this.dist, R = this.fieldR * 10;
    const offsets = this.fieldOffsets;
    // The walk grid is static. Store mask + 1 so zero means the cell has yet to be expanded.
    const masks = this.neighborMasks ??= new Uint16Array(dist.length);
    // bucket-queue Dijkstra, octile costs 10 / 14 (no corner cutting)
    const buckets = this.fieldBuckets;
    (buckets[0] || (buckets[0] = [])).push(c0);
    dist[c0] = 0;
    // Distances are set on enqueue. Buckets that cannot reach another cell need no expansion.
    for (let b = 0; b < buckets.length && b + 10 <= R; b++) {
      const bk = buckets[b]; if (!bk) continue;
      const straight = b + 10, diagonal = b + 14;
      const withinRadius = diagonal <= R ? 0xff : ~DIAGONAL_NEIGHBORS;
      for (let q = 0; q < bk.length; q++) {
        const c = bk[q]; if (dist[c] !== b) continue;
        let mask = masks[c] - 1;
        if (mask < 0) {
          mask = this.walkNeighborMask(c);
          masks[c] = mask + 1;
        }
        mask &= withinRadius;
        // Take the lowest set bit first to preserve direction order.
        while (mask) {
          const bit = mask & -mask;
          mask ^= bit;
          const nd = (bit & DIAGONAL_NEIGHBORS) ? diagonal : straight;
          const n = c + offsets[31 - Math.clz32(bit)], dn = dist[n];
          if (dn >= 0 && dn <= nd) continue;
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
      const lu = this.lineup[t];
      if (lu && dist[lu.cell] >= 0) { const a = this.sidePt[s]; out[this.nSides + t] = Math.max(Math.hypot(a.x - lu.x, a.z - lu.z), dist[lu.cell] / 10); }
    }
    // Every distance written above has a bucket entry, including stale entries after an improvement.
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const c of bucket) dist[c] = -1;
      bucket.length = 0;
    }
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
  // fast vault needs a straight run-up (>= fastVaultRunupM within 25 deg of the vault direction): the incoming leg must
  // be long enough and arrive roughly along the axis (a 90-degree turn from an exterior connector gives a medium vault)
  tsOf(c, legIn, from = null) {
    const a = this.anchors[c >> 1];
    if (a.kind === 'w') {
      if (legIn < this.runup) return this.sMed;
      if (from) {
        const P0 = this.sidePt[c], Q0 = this.sidePt[c ^ 1], ax = (Q0.x - P0.x) / 3.2, az = (Q0.z - P0.z) / 3.2;
        const vx = P0.x - from.x, vz = P0.z - from.z, L = Math.hypot(vx, vz) || 1;
        if ((vx * ax + vz * az) / L < this.coneCos) return this.sMed;
      }
      return this.sFast;
    }
    return Math.min(3.2 / this.vS + this.sDrop, this.sPalVault);
  }

  // evaluate a circuit (array of crossings); returns { lap, lapNP, perCross[] } in metres of hunter running
  // open: optional Set of pallet anchor indices left standing (crossed as an open gap, no drop) for this lap
  evaluate(seq, open = null) {
    const k = seq.length, vS = this.vS, vH = this.vH;
    let lap = 0, palGain = 0, palOpen = 0;
    const palSeen = new Set(open || []);
    for (let i = 0; i < k; i++) {
      const c = seq[i], n = seq[(i + 1) % k], prev = seq[(i - 1 + k) % k];
      const leg = this.L(this.qSide(c), this.pSide(n));
      const cut = this.L(this.pSide(c), this.pSide(n)) / vH;
      // a pallet works once: after the break it's an open gap, crossed at running speed by both
      const So = 3.2 / vS + leg / vS, Ho = Math.min(3.2 / vH + leg / vH, cut), open = (Ho - So) * vH;
      if (this.anchors[c >> 1].kind === 'p' && palSeen.has(c >> 1)) { lap += open; palOpen += open; palGain += open; continue; }
      const legIn = this.L(this.qSide(prev), this.pSide(c));
      const S = this.tsIn(c, this.qSide(prev), legIn) + leg / vS;
      const H = Math.min(this.thOf(c) + leg / vH, cut);
      const g = (H - S) * vH;
      lap += g;
      if (this.anchors[c >> 1].kind === 'p') { palSeen.add(c >> 1); palGain += g; palOpen += open; }
    }
    return { lap, lapNP: lap - palGain + palOpen };
  }

  // one pass over a dropped pallet: hunter's cheaper of break + walk through or walking around, minus my vault
  palletGain(k) {
    const Th = Math.min(this.hBreak + 3.2 / this.vH, this.detour(k) / this.vH);
    return (Th - this.sPalVault) * this.vH;
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
    if (laps < 1) {
      // not a full lap left: the prefix of crossings the budget still allows (a useful partial plan)
      const left = new Map(); let k = 0;
      for (const c of o.seq) { const a = c >> 1; if (this.anchors[a].kind !== 'w') { k++; continue; } const l = left.has(a) ? left.get(a) : (vaultsLeft ? vaultsLeft(a) : 3); if (l <= 0) break; left.set(a, l - 1); k++; }
      return k ? 0.7 * o.lap * (k / o.seq.length) : -Infinity;
    }
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
