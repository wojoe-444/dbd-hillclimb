// Covered-route stepping for survivor motor modes (survivor-goal.js 'covered' route preference).
//
// Instead of the shortest path to `target`, take the next 3-7 m step that still makes path progress toward it and
// is well covered and poorly exposed to where the hunter is (seen) or where my belief puts it (top cells), at a
// small detour cost. Re-planned at ~1 Hz or on arrival. Uses the hunter belief's cover map (coverAt, crouched
// variant) and exposure (line of sight from the likely hunter cells).
//
// EXTENSION POINT: a dedicated stealth planner (src/brains/stealthplan.js, feat/stealth-planner) can replace this
// by exposing the same per-brain interface: makeX(ctx, belief) -> { step(obs, api, me, target, opts) -> {x,z}|null,
// last }. survivor-goal.js only calls `step`.
// Per-brain state only (closure); no module-level mutable state (solo-queue rule).

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);

export const COVER_ROUTE = { minDist: 5, radii: [3, 5, 7], dirs: 16, coneDeg: 75, exposeW: 1.5, detourW: 0.15, replanS: 1 };

export function makeCoverRoute(ctx, belief, opts = {}) {
  const C = { ...COVER_ROUTE, ...opts };
  let cur = null;   // { wp, tx, tz, t, crouch }
  function step(obs, api, me, target, { crouch = false } = {}) {
    const nav = api.nav, t = obs.t;
    const dT = d2(me, target);
    if (dT < C.minDist) { cur = null; return null; }
    if (cur && Math.abs(cur.tx - target.x) + Math.abs(cur.tz - target.z) < 1 && t - cur.t < C.replanS && d2(me, cur.wp) > 0.8 && cur.crouch === crouch) return cur.wp;
    const base = nav.dist(me, target);
    if (!isFinite(base)) { cur = null; return null; }
    const wp0 = nav.nextWaypoint(me, target) || target;
    const a0 = Math.atan2(wp0.z - me.z, wp0.x - me.x), cone = (C.coneDeg * Math.PI) / 180;
    const h = obs.hunter;
    const top = h ? [{ x: h.x, z: h.z, p: 1 }] : belief.topCells(6);
    let best = null, bs = -Infinity;
    for (const r of C.radii) {
      if (r > dT) break;
      for (let k = 0; k < C.dirs; k++) {
        const da = ((k / (C.dirs - 1)) * 2 - 1) * cone, a = a0 + da;
        const pt = { x: Math.floor(me.x + Math.cos(a) * r) + 0.5, z: Math.floor(me.z + Math.sin(a) * r) + 0.5 };
        if (!api.walkClear(me, pt)) continue;
        const rest = nav.dist(pt, target);
        if (!(rest < base - 1)) continue;                       // must make path progress
        const detour = r + rest - base;
        const s = belief.coverAt(pt.x, pt.z, crouch) - C.exposeW * (top.length ? belief.exposure(api, pt, top, crouch) : 0) - C.detourW * detour;
        if (s > bs) { bs = s; best = pt; }
      }
    }
    cur = best ? { wp: best, tx: target.x, tz: target.z, t, crouch } : null;
    return best;
  }
  return { step, get last() { return cur; } };
}
