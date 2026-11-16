// Open-field "equivalent distance held" over a short horizon (per survivor brain instance; no module-level state).
//
// At ~2 Hz in a chase: two bounded Dijkstra fields on the static walk grid (loops.js `solid`, anchors handled here):
//   survivor field from me   : windows = fast vault (0.5 s x run speed), dropped pallets = pallet vault (1.1 s),
//                              standing / broken pallets = open gap, windows blocked for me = solid;
//   hunter field from hunter : windows = vault 1.7 s, dropped pallets = break 2.34 s (+ walk), costs in metres at
//                              hunter speed (incl. Bloodlust from my own chase time).
// A candidate destination T is evaluated by backtracking my shortest path to T and rolling both forward in 0.25 s
// steps: gap(t) = hunterPathDist(hunter -> where I am at t) - vH * t - reach. The survivor stops at T when it arrives
// (dead ends, corners, the outer wall: the gap then collapses at vH m/s). Open routes are two-leg: after arriving at T
// the survivor keeps running straight along the best of 7 onward directions (within +-90 deg of its heading) for the
// rest of the horizon, so a wall or corner ahead (few / short continuations) shows up as a collapsing gap.
// Value = min gap over the horizon; for a loop, min gap until arrival (+ the circuit's distance held per lap, added
// by the caller when it's > 0).

const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];

export class RouteEval {
  constructor(loops, ctx) {
    this.L = loops;
    const cfg = ctx.config;
    this.W = loops.W; this.H = loops.H;
    this.vS = (cfg.survivor && cfg.survivor.runSpeed) || 4;
    this.vH0 = (cfg.hunter && cfg.hunter.speed) || 4.6;
    this.bl = (cfg.hunter && cfg.hunter.bloodlust) || [];
    this.reach = 2.0;
    const N = this.W * this.H;
    this.fS = new Int32Array(N).fill(-1);
    this.fH = new Int32Array(N).fill(-1);
    this.extraS = new Int32Array(N);   // per-cell entry cost (x10 m), -1 = solid
    this.extraH = new Int32Array(N);
    this.touchedS = []; this.touchedH = [];
    // anchor cells
    this.anchorCells = loops.anchors.map((a) => {
      const cells = [];
      if (a.kind === 'w') cells.push(Math.floor(a.c.z) * this.W + Math.floor(a.c.x));
      else { const q = a.p; for (let j = q.z0 ?? q.z; j < (q.z1 ?? q.z + 1); j++) for (let i = q.x0 ?? q.x; i < (q.x1 ?? q.x + 1); i++) cells.push(j * this.W + i); }
      return cells;
    });
    this.RS = 34; this.RH = 40; this.R = 40;        // field radii (m): mine covers the first leg / loop entries, the hunter's my whole horizon
    this.buckets = [];
    this.blkS = new Uint8Array(N); this.blkH = new Uint8Array(N);
  }

  hunterSpeed(chaseS) {
    let b = 0; for (const [t, v] of this.bl) if (chaseS >= t) b = v;
    return this.vH0 + b;
  }

  // set up per-call anchor costs from the current pallet states / my blocked windows
  costs(obs, vH) {
    const L = this.L, xs = this.extraS, xh = this.extraH;
    L.anchors.forEach((a, k) => {
      let cs, ch;
      if (a.kind === 'w') { cs = obs.blockedWindows.includes(a.id) ? -1 : Math.round(0.5 * this.vS * 10); ch = Math.round(1.7 * vH * 10); }
      else {
        const st = obs.pallets[a.i];
        if (st === 'dropped') { cs = Math.round(1.1 * this.vS * 10); ch = Math.round(2.34 * vH * 10); }
        else { cs = 0; ch = 0; }
      }
      for (const c of this.anchorCells[k]) { xs[c] = cs; xh[c] = ch; this.blkS[c] = cs < 0 ? 1 : 0; this.blkH[c] = ch < 0 ? 1 : 0; }
    });
  }

  // bounded bucket-queue Dijkstra (x10 m units, octile 10 / 14 + anchor entry costs); blk = per-cell blocked mask
  field(f, touched, extra, blk, x, z, Rm) {
    for (let k = 0; k < touched.length; k++) f[touched[k]] = -1;
    touched.length = 0;
    const W = this.W, H = this.H, isA = this.isAnchor, R = Rm * 10;
    const i0 = Math.floor(x), j0 = Math.floor(z);
    if (i0 < 0 || j0 < 0 || i0 >= W || j0 >= H) return;
    const c0 = j0 * W + i0;
    const buckets = this.buckets; for (let b = 0; b < buckets.length; b++) if (buckets[b]) buckets[b].length = 0;
    (buckets[0] || (buckets[0] = [])).push(c0); f[c0] = 0; touched.push(c0);
    for (let b = 0; b <= R; b++) {
      const bk = buckets[b]; if (!bk || !bk.length) continue;
      for (let q = 0; q < bk.length; q++) {
        const c = bk[q]; if (f[c] !== b) continue;
        const i = c % W, j = (c - i) / W;
        const iL = i > 0, iR = i < W - 1, jU = j > 0, jD = j < H - 1;
        for (let k = 0; k < 8; k++) {
          const di = DI[k], dj = DJ[k];
          if ((di < 0 && !iL) || (di > 0 && !iR) || (dj < 0 && !jU) || (dj > 0 && !jD)) continue;
          const n = c + dj * W + di;
          if (blk[n]) continue;
          let nd;
          if (di && dj) { if (blk[c + di] || blk[c + dj * W] || isA[n]) continue; nd = b + 14; }
          else nd = b + 10 + (isA[n] ? extra[n] : 0);
          if (nd > R) continue;
          const fn = f[n];
          if (fn >= 0 && fn <= nd) continue;
          if (fn < 0) touched.push(n);
          f[n] = nd;
          (buckets[nd] || (buckets[nd] = [])).push(n);
        }
      }
    }
  }

  // prepare both fields; returns false if unusable
  prepare(obs, me, hp, chaseS) {
    if (!this.isAnchor) {
      this.isAnchor = new Uint8Array(this.W * this.H); for (const cells of this.anchorCells) for (const c of cells) this.isAnchor[c] = 1;
      const solid = this.L.solid; for (let c = 0; c < solid.length; c++) { const b = solid[c] && !this.isAnchor[c] ? 1 : 0; this.blkS[c] = b; this.blkH[c] = b; }
    }
    this.vH = this.hunterSpeed(chaseS);
    this.costs(obs, this.vH);
    this.field(this.fS, this.touchedS, this.extraS, this.blkS, me.x, me.z, this.RS);
    this.field(this.fH, this.touchedH, this.extraH, this.blkH, hp.x, hp.z, this.RH);
    this.meCell = Math.floor(me.z) * this.W + Math.floor(me.x);
    return this.fS[this.meCell] === 0;
  }

  reachable(x, z) { const i = Math.floor(x), j = Math.floor(z); if (i < 0 || j < 0 || i >= this.W || j >= this.H) return false; return this.fS[j * this.W + i] >= 0; }
  sDist(x, z) { const i = Math.floor(x), j = Math.floor(z); const v = this.fS[j * this.W + i]; return v >= 0 ? v / 10 : Infinity; }

  // my path to (x,z) as cells from me to there, by descending my field
  path(x, z) {
    const W = this.W, f = this.fS;
    let c = Math.floor(z) * W + Math.floor(x);
    if (f[c] < 0) return null;
    const out = [c];
    for (let guard = 0; guard < 400 && f[c] > 0; guard++) {
      const i = c % W, j = (c / W) | 0;
      let best = -1, bv = f[c];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const n = (j + dj) * W + (i + di);
        if (i + di < 0 || j + dj < 0 || i + di >= W || j + dj >= this.H) continue;
        const v = f[n];
        if (v >= 0 && v < bv) { bv = v; best = n; }
      }
      if (best < 0) break;
      c = best; out.push(c);
    }
    return out.reverse();
  }

  gapAt(cell, t) { const hd = this.fH[cell]; return (hd >= 0 ? hd / 10 : this.R + 10) - this.vH * t - this.reach; }

  // min gap (m) along my path to (x,z) over `horizon` s (or until arrival if untilArrival); also the arrival time.
  // cont: after arrival, continue straight (best of 7 onward directions) for the rest of the horizon.
  rollout(x, z, horizon, untilArrival = false, cont = false, from = null) {
    const p = this.path(x, z);
    if (!p) return null;
    const f = this.fS, vS = this.vS, W = this.W;
    const arrive = f[p[p.length - 1]] / 10 / vS;
    const T = untilArrival || cont ? Math.min(arrive, horizon) : horizon;
    let k = 0, minGap = Infinity;
    for (let t = 0; t <= T + 1e-9; t += 0.25) {
      const s10 = vS * t * 10;
      while (k < p.length - 1 && f[p[k + 1]] <= s10) k++;
      const g = this.gapAt(p[k], t);
      if (g < minGap) minGap = g;
    }
    if (cont && arrive < horizon) {
      const hx = from ? x - from.x : 1, hz = from ? z - from.z : 0, h0 = Math.atan2(hz, hx);
      const solid = this.L.solid, isA = this.isAnchor, end = p[p.length - 1];
      let bestCont = -Infinity;
      for (let d = -3; d <= 3; d++) {
        const a = h0 + d * (Math.PI / 6), ux = Math.cos(a), uz = Math.sin(a);
        let cx = x, cz = z, cell = end, mg = Infinity;
        for (let t = arrive + 0.25; t <= horizon + 1e-9; t += 0.25) {
          const nx = cx + ux * vS * 0.25, nz = cz + uz * vS * 0.25, i = Math.floor(nx), j = Math.floor(nz);
          if (i >= 0 && j >= 0 && i < W && j < this.H && !solid[j * W + i] && !isA[j * W + i]) { cx = nx; cz = nz; cell = j * W + i; }
          const g = this.gapAt(cell, t);                   // blocked: I stand there and the hunter closes in
          if (g < mg) mg = g;
        }
        if (mg > bestCont) bestCont = mg;
      }
      if (bestCont < minGap) minGap = bestCont;
    }
    return { gap: minGap, arrive };
  }
}
