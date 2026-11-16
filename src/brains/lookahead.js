// Route lookahead for open-ground flee destinations (per survivor brain instance; no module-level state).
//
// The open-field route score (routes.js) is the min survivor-hunter gap over a short horizon. It says nothing about
// what I can do once I get there, so survivors ran into dead zones (no pallet / window / loop / tall LOS blocker
// within reach) and went down there: the #1 down cause in the shack duel. For a candidate flee destination T this
// module gives:
//   * next resource v: the best known resource whose entry I can still reach from T before the hunter catches me:
//       v = value(r) x ramp(margin at r's entry: 0 at -RAMP_NEG m, full at +RAMP_M m)
//     value(r) = one lap of the best circuit through the anchor that this survivor knows (the unit the loop chooser
//     scores a loop entry by; same rule: <= 1 anchor not seen yet, x0.6 then), or a standing / dropped pallet's own
//     distance held (capped at V_CAP); BLOCKER_V for a tall LOS blocker in an area I've explored (chase-break /
//     mind-game value only: the hunter is faster around a plain block);
//     margin = the gap (routes.gapAt rule) at the entry when I get there via T (me -> T -> entry; my field's own
//     distance to the entry if a wall makes that longer).
//   * open ground: metres from T to the nearest resource I can still reach (lookaheadMaxM if none) = how far I'd
//     run on bare ground after the flee point.
// The caller (survivor chooseRoute) adds  doom x (laW x v - openGroundPenalty x open)  to the open route's score,
// only in a chase (chase music); doom = 1 when the route's own gap collapses to <= 0 within the horizon, 0 when it
// holds >= LOOKAHEAD_DOOM_M all the way (then the gap score already says enough, and luring the chase toward
// resources measured worse in full matches: it costs the team repair time), and x0 for flee points within
// LOOKAHEAD_NEAR_M of me (ramping to x1 over the next 4 m: a point reached at once made re-planning flip-flop).
// Knowledge: only anchors this survivor has seen (MapKnowledge.anchorKnown) and blockers in areas it has explored;
// pallet / window states from obs (own last-seen memory). Cost: anchor values are cached per anchor and recomputed
// only when the pallet / window / vault-budget signature changes; per call only resources near me are listed.

export const lookaheadSpace = {
  routeLookaheadW:   [0, 2, 0.6],    // weight of the best next resource reachable from an open flee destination (0 = off)
  openGroundPenalty: [0, 1, 0],   // per metre of bare ground after the flee destination before the next reachable resource (0 = off)
  lookaheadMaxM:     [0, 30, 14],    // how far past the destination to look for the next resource (m; 0 = lookahead off)
  chainAfterBreakW:  [0, 2, 0.8],    // extra next-resource weight for 6 s after I see a pallet break (chain to the next tile)
};

const V_CAP = 24;           // cap on one resource's value (m held)
const RAMP_M = 4;           // a resource reached with this much margin counts fully ...
const RAMP_NEG = 2;         // ... and one the hunter reaches first by up to this much still counts a little (a healthy survivor takes the hit and gets there on the speed boost)
const BLOCKER_V = 4;        // a tall LOS blocker alone (m-equivalent)
export const LOOKAHEAD_DOOM_M = 4;   // the lookahead counts fully for an open route whose own gap collapses to <= 0 within the horizon, not at all from this gap up
export const LOOKAHEAD_NEAR_M = 4;   // flee points within this of me get no lookahead (ramps in over the next 4 m)

export class RouteLookahead {
  constructor(loops, know, ctx) {
    this.L = loops; this.know = know;
    const M = ctx.map;
    this.W = loops.W; this.H = loops.H;
    const eye = M.eyeHeight ?? 1.6;
    // tall blockers worth circling: footprint perimeter 8..60 m (not long walls / tiny posts)
    this.blockers = (M.obstacles || []).filter((o) => (o.height ?? 0) >= eye && 2 * (o.w + o.d) >= 8 && 2 * (o.w + o.d) <= 60)
      .map((o) => ({ x0: o.x, z0: o.z, x1: o.x + o.w, z1: o.z + o.d, cx: o.x + o.w / 2, cz: o.z + o.d / 2, r: Math.hypot(o.w, o.d) / 2 }));
    this.val = new Float32Array(loops.anchors.length);
    this.valSig = new Array(loops.anchors.length).fill(null);
    this.sig = '';
    this.res = [];          // per-call resource list near me: { kind, k?, b?, x, z, e: [{x,z},{x,z}] | null, v }
  }

  // anchor value: one lap of the best known circuit through it, or a pallet's own distance held; cached per anchor
  // until the pallet / window / vault-budget signature changes
  anchorValue(a, usable, vl, ps) {
    if (this.valSig[a.k] === this.sig) return this.val[a.k];
    const L = this.L, know = this.know;
    let v = 0;
    if (a.kind === 'p') { const st = ps(a.k); if (st === 'up' || st === 'dropped') v = L.palletGain(a.k); }
    for (let d = 0; d < 2; d++) for (const o of L.circuitsFrom(2 * a.k + d)) {
      if (o.fresh <= v) break;                         // sorted by fresh value; lap <= fresh
      let unk = 0, okc = true;
      for (const x of o.seq) { const b = L.anchors[x >> 1]; if (!usable(b)) { okc = false; break; } if (!know.anchorKnown[b.k]) unk++; }
      if (!okc || unk > 1) continue;
      const ex = Math.min(o.lap, L.expected(o, vl, ps)) * (unk ? 0.6 : 1);   // one lap, if the vault budget still allows it
      if (ex > v) v = ex;
    }
    v = Math.min(V_CAP, Math.max(0, v));
    this.val[a.k] = v; this.valSig[a.k] = this.sig;
    return v;
  }

  // per route decision: list the resources within R m of me (R = first leg + lookahead) with their values.
  // usableNow(a): may I use it right now (not busy / contested); usable(a): state-only (pallet not broken, window
  // not blocked for me); vl / ps: window vault budget / pallet state callbacks (survivor.js vaultsLeft / palletState)
  begin(obs, me, R, usableNow, usable, vl, ps) {
    let s = obs.pallets.join('') + '|' + obs.blockedWindows.join(',') + '|';
    for (const a of this.L.anchors) if (a.kind === 'w') s += vl(a.k);
    this.sig = s;
    const res = this.res; res.length = 0;
    const R2 = R * R;
    for (const a of this.L.anchors) {
      if (!this.know.anchorKnown[a.k] || !usableNow(a)) continue;
      if ((a.c.x - me.x) ** 2 + (a.c.z - me.z) ** 2 > R2) continue;
      const v = this.anchorValue(a, usable, vl, ps);
      if (v > 0) res.push({ kind: a.kind, k: a.k, x: a.c.x, z: a.c.z, e: a.s, v });
    }
    for (const b of this.blockers) {
      if ((b.cx - me.x) ** 2 + (b.cz - me.z) ** 2 > (R + b.r) ** 2) continue;
      if (!this.know.explored(b.cx, b.cz)) continue;
      res.push({ kind: 'b', b, x: b.cx, z: b.cz, e: null, v: BLOCKER_V });
    }
    return res.length;
  }

  // best next resource reachable from destination T (routes prepared for this decision; begin() called);
  // maxM = lookahead radius. Returns { v (metres held, ramped by the margin), r (resource), open (m, see top) }.
  nextResource(routes, T, maxM) {
    const sT = routes.sDist(T.x, T.z);
    if (!(sT < Infinity) || maxM <= 0) return { v: 0, r: null, open: Math.max(0, maxM) };
    const vS = routes.vS, m2 = (maxM + 2) ** 2;
    let best = 0, br = null, open = maxM;
    for (const r of this.res) {
      if ((r.x - T.x) ** 2 + (r.z - T.z) ** 2 > m2 + (r.b ? r.b.r * r.b.r : 0)) continue;
      let e1;
      if (r.e) {
        // the nearer entry from T
        e1 = (r.e[0].x - T.x) ** 2 + (r.e[0].z - T.z) ** 2 <= (r.e[1].x - T.x) ** 2 + (r.e[1].z - T.z) ** 2 ? r.e[0] : r.e[1];
      } else {
        // nearest point of the blocker's footprint, 1 m out
        const b = r.b, px = Math.min(b.x1, Math.max(b.x0, T.x)), pz = Math.min(b.z1, Math.max(b.z0, T.z));
        const dx = T.x - px, dz = T.z - pz, l = Math.hypot(dx, dz) || 1;
        e1 = { x: px + dx / l, z: pz + dz / l };
      }
      const dTE = Math.hypot(e1.x - T.x, e1.z - T.z);
      if (dTE > maxM) continue;
      const ei = Math.floor(e1.x), ej = Math.floor(e1.z);
      if (ei < 0 || ej < 0 || ei >= this.W || ej >= this.H || this.L.solid[ej * this.W + ei]) continue;
      const sE = routes.sDist(e1.x, e1.z);
      const run = sE < Infinity ? Math.max(sT + dTE, sE) : sT + 1.3 * dTE;
      const margin = routes.gapAtPoint(e1.x, e1.z, run / vS);
      if (margin <= -RAMP_NEG) continue;
      if (dTE < open) open = dTE;
      const v = r.v * Math.min(1, (margin + RAMP_NEG) / (RAMP_M + RAMP_NEG));
      if (v > best) { best = v; br = r; }
    }
    return { v: best, r: br, open };
  }
}
