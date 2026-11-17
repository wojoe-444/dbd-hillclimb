// Private route-level stealth planner for one survivor (docs/research/hiding-review.md, P0/P1).
//
// Question it answers: "if I leave now (walking / running) for this cover spot, or stay where I am, does the hunter
// plausibly get line of sight on me before I'm in stable cover?" It is a brain-side forecast, not an oracle: only the
// survivor's own obs are used (a visible hunter, its own last sighting, its private HunterBelief, its own trail
// memory, static geometry, the gens it has found). Never the hunter's target / belief / "seen me", never hidden gens or
// teammate-private info. One instance per survivor closure; no module-level mutable state (constants only).
//
// Pieces
//   hypotheses : 4-8 weighted hunter trajectories sampled every STEP_S over HORIZON_S: continue the observed motion;
//                approach the generator I work on (then search around it, omnidirectional); pass toward another known
//                objective; turn / search in place. Origins: a visible hunter (age 0), my own last sighting (aged:
//                trajectories start `age` seconds in), or the top belief cells (the belief mass they don't cover is
//                kept as uncertainty, never renormalised away).
//   options    : stay (keep working / hold the current spot) and walk / run along a few sector-diverse cover routes
//                (straight or one-turn corner routes) -> arrival time, P(detection before stable cover) over the
//                weighted hypotheses (survivor progress delayed by hideLosMarginS), earliest plausible LOS, margin,
//                search-viewpoint exposure after the horizon, own scratch trail the hunter can cross, uncertainty,
//                lost repair seconds.
//   decision   : utility = -(detection cost x risk) - lost repair seconds; a move is a preventive hide only if its risk
//                <= hideRouteRiskMax; when nothing is safe I stay (a close visible hunter stays the chase logic's).
//   plan       : depart -> cover (hold, observe, reposition when the spot turns risky) -> return to the original
//                known generator once the walk back is safe (hideReturnRisk) for hideReturnDelayS.
//
// Gaits: GAITS below is the extension point for a crouch gait (feat/crouch): add an entry { speed, marks: false,
// act: { crouch: true }, visMult } and list it in GAIT_ORDER; the evaluator treats gaits generically (visMult scales the
// hunter's visibility of the moving body, e.g. for low cover; 1 = the engine's standing body).

export const stealthSpace = {
  stealthPlan:      [0, 1, 0],       // >0.5: the route-level stealth planner replaces sneak / unseen-hide / visible-hide (0 = old behaviour)
  hideLosMarginS:   [0, 3, 0.6],     // extra arrival slack (s) against each hunter hypothesis (my progress is delayed by this)
  hideRouteRiskMax: [0.02, 0.8, 0.2],// max modelled risk of discovery before stable cover for a preventive move
  hideScratchW:     [0, 4, 1],       // cost of a scratch trail (old marks + new marks if running) the hunter can cross
  hideApproachW:    [0, 3, 1],       // weight of search-viewpoint exposure of the cover spot after the horizon
  hideUncertaintyW: [0, 3, 1],       // caution from stale evidence / belief mass outside the hypotheses (x route openness)
  hideReturnRisk:   [0.02, 0.8, 0.25],// route risk below which I leave cover and walk back to my generator
  hideReturnDelayS: [0, 8, 1],       // ...after it has stayed below that for this long (double-back caution)
};

// engineering limits (not GA knobs): bounded cost
const STEP_S = 0.5, HORIZON_S = 5.5, K = Math.round(HORIZON_S / STEP_S);
const MAX_ROUTES = 5, PROMISE_POOL = 24, SECTORS = 8, REPLAN_S = 1.25, MIN_REPLAN_S = 0.4, FIELD_CACHE = 12;
const DET_COST_S = 30;         // a discovery costs ~ this many repair-seconds when healthy (scaled by injury / hook stage)
const HOLD_MIN_S = 3;          // a hide costs at least ~ this long away from the generator besides the trip
const SEARCH_R = 10;           // a hunter at the worked gen looks around (omnidirectional) within this

export const GAITS = {
  walk: { speed: 2.26, marks: false, act: { walk: true }, visMult: 1 },
  run:  { speed: 4.0,  marks: true,  act: {},             visMult: 1 },
  // crouch: { speed: 1.13, marks: false, act: { crouch: true }, visMult: <low-cover factor> }   (feat/crouch)
};
const GAIT_ORDER = ['walk', 'run'];

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const dist = (a, b) => hyp(a.x - b.x, a.z - b.z);

export function makeStealthPlanner(ctx, P, belief, opts = {}) {
  const on = (P.stealthPlan ?? 0) > 0.5;
  const cfg = ctx.config, M = ctx.map, W = M.w, H = M.h;
  const fine = belief.fine;
  const vH = (cfg.hunter && cfg.hunter.speed) || 4.6;
  const range = (cfg.sight && cfg.sight.range) || 75, visT = (cfg.sight && cfg.sight.visThreshold) || 0.5;
  const cosCone = Math.cos((((cfg.sight && cfg.sight.hunterFovDeg) || 100) / 2) * Math.PI / 180);
  const markLife = (cfg.senses && cfg.senses.scratchMemoryS) || 10, markEvery = (cfg.senses && cfg.senses.scratchEveryS) || 0.5;
  const gruntR = ((cfg.senses && cfg.senses.gruntRadius) || 10) - 1;
  const noiseR = (cfg.senses && cfg.senses.repairNoiseRadius) || 20;   // public rule: the hunter hears a repairing gen this far
  const gaits = {};
  for (const g of GAIT_ORDER) gaits[g] = { ...GAITS[g], speed: g === 'walk' ? (cfg.survivor.walkSpeed ?? GAITS.walk.speed) : g === 'run' ? (cfg.survivor.runSpeed ?? GAITS.run.speed) : GAITS[g].speed };
  const fallbackAt = opts.fallbackAt || (() => 0);
  const stats = { plans: 0, evals: 0, stays: 0, departs: 0, walkDeparts: 0, runDeparts: 0, holds: 0, repositions: 0, returns: 0, timeouts: 0 };

  // ---- static work, cached: fine-grid hunter distance fields to target cells (gens, my spot) ----
  const fields = new Map();
  const heapI = new Int32Array(W * H * 4), heapD = new Float32Array(W * H * 4);
  function field(tx, tz) {
    const ti = Math.min(W - 1, Math.max(0, Math.floor(tx))), tj = Math.min(H - 1, Math.max(0, Math.floor(tz))), tc = tj * W + ti;
    let f = fields.get(tc);
    if (f) { fields.delete(tc); fields.set(tc, f); return f; }
    f = new Float32Array(W * H).fill(Infinity);
    let n = 0;
    const push = (c, d) => { let i = n++; while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= d) break; heapI[i] = heapI[p]; heapD[i] = heapD[p]; i = p; } heapI[i] = c; heapD[i] = d; };
    const pop = () => { const c = heapI[0], last = --n; const lc = heapI[last], ld = heapD[last]; let i = 0;
      for (;;) { let k = 2 * i + 1; if (k >= n) break; if (k + 1 < n && heapD[k + 1] < heapD[k]) k++; if (heapD[k] >= ld) break; heapI[i] = heapI[k]; heapD[i] = heapD[k]; i = k; }
      heapI[i] = lc; heapD[i] = ld; return c; };
    f[tc] = 0; push(tc, 0);
    while (n > 0) {
      const d0 = heapD[0], c = pop();
      if (d0 > f[c]) continue;
      if (n > heapI.length - 16) break;   // (cannot happen on sane maps; bounded)
      const i = c % W, j = (c / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const v = b * W + a;
        if (!fine[v]) continue;
        if (di && dj && (!fine[j * W + a] || !fine[b * W + i])) continue;   // no corner cutting
        const nd = d0 + (di && dj ? 1.4142 : 1);
        if (nd < f[v]) { f[v] = nd; push(v, nd); }
      }
    }
    if (fields.size >= FIELD_CACHE) fields.delete(fields.keys().next().value);
    fields.set(tc, f);
    return f;
  }
  // polyline (cell centres) descending field f from (x, z), up to maxLen metres
  function descend(f, x, z, maxLen) {
    let i = Math.floor(x), j = Math.floor(z);
    const pts = [{ x, z }];
    if (i < 0 || j < 0 || i >= W || j >= H || !(f[j * W + i] < Infinity)) return pts;
    let len = 0;
    while (len < maxLen && f[j * W + i] > 0) {
      let bi = -1, bj = -1, bv = f[j * W + i];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const v = f[b * W + a];
        if (v < bv) { bv = v; bi = a; bj = b; }
      }
      if (bi < 0) break;
      len += (bi !== i && bj !== j) ? 1.4142 : 1;
      i = bi; j = bj;
      pts.push({ x: i + 0.5, z: j + 0.5 });
    }
    return pts;
  }
  // position + heading at arc length s along a polyline (clamped at its end)
  function along(pts, s, out) {
    let k = 0;
    while (k + 1 < pts.length) {
      const a = pts[k], b = pts[k + 1], L = dist(a, b);
      if (s <= L || k + 2 === pts.length) {
        const u = L > 1e-9 ? Math.min(1, s / L) : 1;
        out.x = a.x + (b.x - a.x) * u; out.z = a.z + (b.z - a.z) * u;
        if (L > 1e-9) { out.fx = (b.x - a.x) / L; out.fz = (b.z - a.z) / L; }
        out.end = s >= L && k + 2 === pts.length;
        return out;
      }
      s -= L; k++;
    }
    out.x = pts[pts.length - 1].x; out.z = pts[pts.length - 1].z; out.end = true;
    return out;
  }
  // static cover, float32 always (HunterBelief.coverAt returns the float64 value on first use, the float32 memo after:
  // rounding here keeps every plan independent of what was queried before)
  const coverAt = (x, z) => Math.fround(belief.coverAt(x, z));
  const walkable = (x, z) => { const i = Math.floor(x), j = Math.floor(z); return i >= 0 && j >= 0 && i < W && j < H && fine[j * W + i] === 1; };

  // ---- hunter hypotheses ----
  // each: { w, kind, x[K+1], z[K+1], fx[], fz[], omni[] } for t_k = k * STEP_S from now
  function sampleTrack(kind, w, pts, age, omniAt, omniAll, fx0, fz0) {
    const tr = { w, kind, x: new Float32Array(K + 1), z: new Float32Array(K + 1), fx: new Float32Array(K + 1), fz: new Float32Array(K + 1), omni: new Uint8Array(K + 1) };
    const o = { x: 0, z: 0, fx: fx0 ?? 1, fz: fz0 ?? 0, end: false };
    for (let k = 0; k <= K; k++) {
      along(pts, vH * (age + k * STEP_S), o);
      tr.x[k] = o.x; tr.z[k] = o.z; tr.fx[k] = o.fx; tr.fz[k] = o.fz;
      tr.omni[k] = omniAll || (o.end && pts.length > 1 && omniAt) || (omniAt && dist(o, omniAt) < SEARCH_R) ? 1 : 0;
    }
    return tr;
  }
  function straight(x, z, ux, uz, maxLen) {
    const pts = [{ x, z }];
    let s = 0;
    while (s < maxLen) { const nx = x + ux * (s + 0.5), nz = z + uz * (s + 0.5); if (!walkable(nx, nz)) break; s += 0.5; }
    if (s > 0) pts.push({ x: x + ux * s, z: z + uz * s });
    return pts;
  }
  // other known objective a hunter at o might head to: the nearest known unfinished gen other than mine
  function otherObjective(obs, o, mineIdx) {
    let best = null, bd = Infinity;
    for (let i = 0; i < obs.gens.length; i++) {
      const g = obs.gens[i];
      if (i === mineIdx || !g.known || g.done || g.x === null) continue;
      const d = dist(g, o);
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }
  function buildHyps(obs, focus, mineIdx) {
    const h = obs.hunter, lh = obs.lastHunter, out = [];
    const maxLen = vH * (HORIZON_S + 16);
    const trend = belief.trend(obs.t, 4);
    const wGen = trend > 0 ? 1.5 : 1, wOther = trend < 0 ? 1.5 : 1;
    const addOrigin = (o, mass, age, vx, vz, facing) => {
      const sp = hyp(vx || 0, vz || 0), list = [];
      const fx0 = facing !== undefined ? Math.cos(facing) : (sp > 0.3 ? vx / sp : 1), fz0 = facing !== undefined ? Math.sin(facing) : (sp > 0.3 ? vz / sp : 0);
      if (sp > 0.5) list.push(['continue', 0.3, straight(o.x, o.z, vx / sp, vz / sp, maxLen), null, false]);
      list.push(['gen', 0.3 * wGen, descend(field(focus.x, focus.z), o.x, o.z, maxLen), focus, false]);
      const og = otherObjective(obs, o, mineIdx);
      if (og) list.push(['other', 0.2 * wOther, descend(field(og.x, og.z), o.x, o.z, maxLen), null, false]);
      // turn / search in place: drifts with its velocity for a moment, then looks around
      list.push(['turn', 0.2 * Math.exp(-age / 4), sp > 0.5 ? straight(o.x, o.z, vx / sp, vz / sp, Math.min(maxLen, vH * (age + 1))) : [{ x: o.x, z: o.z }], null, true]);
      const tot = list.reduce((a, e) => a + e[1], 0);
      for (const [kind, w, pts, omniAt, omniAll] of list) out.push(sampleTrack(kind, mass * w / tot, pts, kind === 'turn' ? 0 : age, omniAt, omniAll, fx0, fz0));
    };
    let src, age = 0, mass = 1;
    if (h) { src = 'visible'; addOrigin(h, 1, 0, h.vx, h.vz, h.facing); }
    else if (lh && obs.t - lh.t < 12) { src = 'sighting'; age = obs.t - lh.t; addOrigin(lh, 1, age, lh.vx, lh.vz, lh.facing); }
    else {
      // belief: only mass that can matter within the horizon (near me) is planned against; the likeliest near cells
      // become origins with their ABSOLUTE probabilities, the near mass they don't cover stays as uncertainty
      src = 'belief';
      const near = vH * HORIZON_S + 20, me = obs.self;
      const nearMass = belief.pHunterWithin(me, near);
      const top = nearMass > 0.02 ? belief.topCells(24).filter((c) => dist(c, me) <= near).slice(0, 2) : [];
      mass = top.reduce((a, c) => a + c.p, 0);
      for (const c of top) addOrigin(c, c.p, 0, 0, 0);
      return { src, age, mass, unc: Math.max(0, nearMass - mass), hyps: out };
    }
    const unc = src === 'visible' ? 0 : Math.min(1, age / 12);
    return { src, age, mass, unc, hyps: out };
  }

  // can hunter sample (track tr, step k) see the survivor at (x, z)?
  function sees(api, tr, k, x, z, visMult, injured) {
    const hx = tr.x[k], hz = tr.z[k], dx = x - hx, dz = z - hz, d2 = dx * dx + dz * dz;
    if (d2 > range * range) return false;
    const d = Math.sqrt(d2);
    if (injured && d < gruntR) return true;   // injured grunts: heard close by, walls or not
    if (d > 1.5 && !tr.omni[k] && dx * tr.fx[k] + dz * tr.fz[k] < d * cosCone) return false;
    return api.visibility({ x: hx, z: hz }, { x, z }) * visMult >= visT;
  }

  // ---- own scratch trail (private memory of where I ran; marks last ~10 s) ----
  const trail = [];   // [{x, z, t}]
  let lastMarkT = -99;
  function update(obs) {
    const me = obs.self;
    while (trail.length && obs.t - trail[0].t > markLife) trail.shift();
    if (me.state !== 'healthy' && me.state !== 'injured') return;
    const sp = hyp(me.vx || 0, me.vz || 0);
    if (sp > 3.05 && !(me.elusiveS > 0) && obs.t - lastMarkT >= markEvery - 1e-9) { trail.push({ x: me.x, z: me.z, t: obs.t }); lastMarkT = obs.t; }
  }
  // does hunter track tr pass within ~18 m of a live mark (before it fades)?
  function trailHit(tr, marks) {
    for (let k = 0; k <= K; k++) for (const m of marks) {
      const age = m.dt + k * STEP_S;
      if (age > markLife || age < 0) continue;
      if ((tr.x[k] - m.x) ** 2 + (tr.z[k] - m.z) ** 2 < 324) return true;
    }
    return false;
  }

  // ---- candidate cover routes from `from` (straight or one turn) ----
  // views: [{x, z, w}] likely hunter viewpoints (heavy hypotheses mid-horizon / at its end): directional promise
  function routes(api, from, R, views) {
    const ring = [];
    for (let rr = 2; rr <= R; rr += 2) {
      const n = Math.min(16, 6 + 2 * rr);
      for (let k = 0; k < n; k++) {
        const a = ((k + (rr % 4 ? 0.5 : 0)) / n) * 2 * Math.PI, x = from.x + Math.cos(a) * rr, z = from.z + Math.sin(a) * rr;
        if (!walkable(x, z)) continue;
        ring.push({ x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, rr, sec: Math.floor(((a + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * SECTORS) % SECTORS });
      }
    }
    for (const c of ring) {
      const cover = coverAt(c.x, c.z);
      // dead-end trap: an enclosed spot with almost no way out scores well on average cover but is a trap
      let exits = 0;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (walkable(c.x + Math.cos(a) * 3, c.z + Math.sin(a) * 3) && walkable(c.x + Math.cos(a) * 6, c.z + Math.sin(a) * 6)) exits++; }
      c.pre = (P.coverW ?? 1) * cover - 0.5 * c.rr / R + 0.3 * fallbackAt(c) - (exits <= 2 ? 0.5 : 0);
    }
    ring.sort((a, b) => b.pre - a.pre);
    // directional promise (review P1): the best cheap candidates also score how much of the likely viewpoints can't
    // see them (body LOS, any facing), so the right side of a blocker isn't pruned before the full evaluation
    if (views.length) {
      const wv = views.reduce((a, v) => a + v.w, 0);
      const pool = ring.slice(0, PROMISE_POOL);
      for (const c of pool) { let hid = 0; for (const v of views) if ((v.x - c.x) ** 2 + (v.z - c.z) ** 2 > range * range || api.visibility(v, c) < visT) hid += v.w; c.pre += 1.5 * hid / wv; }
      pool.sort((a, b) => b.pre - a.pre);
      ring.splice(0, pool.length, ...pool);
    }
    const reach = [];   // straight-line reachable ring points (one-turn waypoints)
    const out = [], perSec = new Array(SECTORS).fill(0);
    let checks = 0;
    for (const c of ring) {
      if (out.length >= MAX_ROUTES || checks > 40) break;
      if (perSec[c.sec] >= 1 && out.length < SECTORS) continue;   // sector-diverse first
      checks++;
      let path = null;
      if (api.walkClear(from, c)) { path = [from, c]; reach.push(c); }
      else for (const wp of reach) { if (dist(wp, c) < 2) continue; checks++; if (api.walkClear(wp, c)) { path = [from, wp, c]; break; } if (checks > 40) break; }
      if (!path) continue;
      perSec[c.sec]++;
      let L = 0; for (let k = 1; k < path.length; k++) L += dist(path[k - 1], path[k]);
      out.push({ spot: { x: c.x, z: c.z }, path, len: L, pre: c.pre });
    }
    return out;
  }

  // ---- evaluate one option against the hypotheses ----
  // opt: { path, len, base } -- base = the do-nothing-new option (stay put, or carry on with the current trip), which
  // costs no repair time and gets no reaction margin. gaitName null = standing still.
  function evalOption(api, H, me, opt, gaitName, ctxE) {
    stats.evals++;
    const g = gaitName ? gaits[gaitName] : null, path = opt.path;
    const margin = g && !opt.base ? P.hideLosMarginS : 0;
    const tArr = g ? opt.len / g.speed : 0;
    const injured = me.state === 'injured' && !(me.elusiveS > 0);
    const sx = new Float32Array(K + 1), sz = new Float32Array(K + 1), o = { x: 0, z: 0, fx: 1, fz: 0, end: false };
    let open = 0;
    for (let k = 0; k <= K; k++) {
      if (g) along(path, Math.max(0, k * STEP_S - margin) * g.speed, o); else { o.x = path[0].x; o.z = path[0].z; }
      sx[k] = o.x; sz[k] = o.z;
      open += 1 - coverAt(o.x, o.z);
    }
    open /= K + 1;
    const end = path[path.length - 1];
    // scratch marks: old ones (dt = their age now) + new ones dropped along a running route (dt < 0: not made yet);
    // they matter as far as the trail's head leads to where I end up
    let marks = null, lead = 0;
    if (P.hideScratchW > 0 && !(me.elusiveS > 0)) {
      marks = ctxE.marks;
      if (g && g.marks) { marks = marks.slice(); const L = Math.min(opt.len, g.speed * HORIZON_S); for (let s = 0; s <= L; s += g.speed * markEvery) { along(path, s, o); marks.push({ x: o.x, z: o.z, dt: -s / g.speed }); } }
      if (marks.length) lead = Math.max(0, 1 - dist(marks[marks.length - 1], g && g.marks ? { x: sx[K], z: sz[K] } : end) / 15);
    }
    let pDet = 0, tLOS = Infinity, linger = 0, scratch = 0;
    const noisy = opt.base && !g && ctxE.working;   // staying on the gen = repairing = audible
    for (const tr of H.hyps) {
      let kd = -1;
      if (noisy) for (let k = 1; k <= K; k++) if ((tr.x[k] - sx[k]) ** 2 + (tr.z[k] - sz[k]) ** 2 < noiseR * noiseR) { kd = k; break; }
      // k = 0 is sunk: being visible right now is not something a plan can prevent (only later samples count)
      if (kd < 0) for (let k = 1; k <= K; k++) if (sees(api, tr, k, sx[k], sz[k], g ? g.visMult : 1, injured)) { kd = k; break; }
      if (kd >= 0) { pDet += tr.w; if (tr.w >= 0.08) tLOS = Math.min(tLOS, kd * STEP_S); continue; }
      // not seen within the horizon: the hunter then searches where its track ends (omni) -> my end spot in view?
      if (P.hideApproachW > 0) {
        const ex = tr.x[K], ez = tr.z[K], d2 = (ex - sx[K]) ** 2 + (ez - sz[K]) ** 2;
        if (d2 < 30 * 30 && api.visibility({ x: ex, z: ez }, { x: sx[K], z: sz[K] }) >= visT) linger += tr.w;
      }
      // ...or crosses my trail and follows it (about half the time) to my spot
      if (lead > 0 && trailHit(tr, marks)) scratch += 0.5 * tr.w * lead;
    }
    const risk = pDet + P.hideApproachW * 0.5 * linger + P.hideScratchW * scratch + P.hideUncertaintyW * 0.3 * H.unc * open;
    const lostS = opt.base ? 0 : 2 * tArr + HOLD_MIN_S;
    const U = -ctxE.detCost * risk - lostS;
    return { gait: opt.base ? 'stay' : gaitName, base: !!opt.base, spot: end, path, tArr, pDet, tLOS, margin: tLOS - tArr, linger, scratch, open, risk, lostS, U };
  }

  // travel: null (standing / working) or { to, walk } = the trip the normal flow is on (carry on = the base option)
  function evaluate(obs, api, from, focus, mineIdx, working, travel = null) {
    stats.plans++;
    const me = obs.self;
    const H = buildHyps(obs, focus, mineIdx);
    const marks = trail.map((m) => ({ x: m.x, z: m.z, dt: obs.t - m.t }));
    const detCost = DET_COST_S * (1 + (me.state === 'injured' ? 0.6 : 0) + 0.4 * (me.hookStages || 0));
    const ctxE = { marks, detCost, working };
    let stay;
    if (travel && !working) {
      const path = tripPath(api, from, travel.to);
      stay = evalOption(api, H, me, { path, len: pathLen(path), base: true }, travel.walk ? 'walk' : 'run', ctxE);
    } else stay = evalOption(api, H, me, { path: [{ x: from.x, z: from.z }], len: 0, base: true }, null, ctxE);
    const list = [stay];
    for (const r of routes(api, from, Math.max(2, P.hideMoveMaxM ?? 12), viewpoints(H))) for (const gn of GAIT_ORDER) list.push(evalOption(api, H, me, r, gn, ctxE));
    return { t: obs.t, H, stay, opts: list, evidence: { src: H.src, age: H.age, mass: H.mass, unc: H.unc } };
  }
  // up to 6 viewpoints: the heavier hypotheses mid-horizon and at its end
  function viewpoints(H) {
    const hs = H.hyps.slice().sort((a, b) => b.w - a.w).slice(0, 3), out = [];
    for (const tr of hs) for (const k of [K >> 1, K]) out.push({ x: tr.x[k], z: tr.z[k], w: tr.w });
    return out;
  }
  const pathLen = (path) => { let L = 0; for (let k = 1; k < path.length; k++) L += dist(path[k - 1], path[k]); return L; };
  const tripPath = (api, from, to) => (api.walkClear(from, to) ? [from, to] : [from, ...descend(field(to.x, to.z), from.x, from.z, 60).slice(1)]);
  // A move is taken only as a preventive hide (risk <= hideRouteRiskMax) that beats staying on utility. When nothing is
  // safe, stay: measured, "evasive" runs to cover with a high modelled risk and switching to the chase logic for a
  // hunter that hasn't seen me both cost far more repair time than they saved (gens 3.06 / 1.56 vs 3.94 on 16 paired
  // seeds); a close visible hunter is still the threat state's chase.
  function choose(ev) {
    let best = ev.stay;
    for (const o of ev.opts) if (o !== ev.stay && o.risk <= P.hideRouteRiskMax && o.U > best.U) best = o;
    return best;
  }

  // a single route's risk (for other planners, e.g. a kicked-gen stay/leave choice): walking/running from -> to
  function routeRisk(obs, api, from, to, gait = 'walk', focus = null) {
    const H = buildHyps(obs, focus || to, -1);
    const marks = trail.map((m) => ({ x: m.x, z: m.z, dt: obs.t - m.t }));
    const path = tripPath(api, from, to);
    return evalOption(api, H, obs.self, { path, len: pathLen(path) }, gait, { marks, detCost: DET_COST_S, working: false });
  }

  // ---- the plan: depart -> cover (hold / observe / reposition) -> return ----
  let plan = null;          // { phase: 'depart'|'cover', start, spot, gait, path, gen, okSince, lastEv }
  let last = null;          // last evaluation (debug / viewer)
  let lastEvalT = -99, lastKey = '', stayUntil = -99, retGen = -1, retUntil = -99;
  const evidenceKey = (obs) => (obs.hunter ? 'v' : 'n') + '|' + (obs.lastHunter ? obs.lastHunter.t : -1) + '|' + (obs.terror ? obs.terror.layer : 0) + '|' + belief.version;

  // info: { working (repairing / about to), gen (index of my known gen or -1), threat (some cue present),
  //         travel: null | { to, walk } (the trip the normal flow is on) }. update(obs) must run every tick.
  // Returns null (carry on with the normal flow) or an action.
  function reeval(obs, api, key, focus, gen, working, travel) {
    lastEvalT = obs.t; lastKey = key;
    const ev = evaluate(obs, api, obs.self, focus, gen, working, travel);
    ev.best = choose(ev);
    last = ev;
    return ev;
  }
  function decide(obs, api, info) {
    if (!on) return null;
    const me = obs.self;
    if (me.state !== 'healthy' && me.state !== 'injured') { plan = null; return null; }
    const g = info.gen >= 0 ? obs.gens[info.gen] : null;
    const focus = g && g.known && g.x !== null ? g : me;
    const key = evidenceKey(obs);
    const changed = key !== lastKey;
    const due = obs.t - lastEvalT >= REPLAN_S || (changed && obs.t - lastEvalT >= MIN_REPLAN_S);
    if (!plan) {
      if (!info.threat) return null;
      if (obs.t < stayUntil && !changed) return null;            // decided to stay a moment ago
      if (!due) return null;
      const ev = reeval(obs, api, key, focus, info.gen, info.working, info.travel), best = ev.best;
      if (best === ev.stay) { stats.stays++; stayUntil = obs.t + REPLAN_S; return null; }
      plan = { phase: 'depart', start: obs.t, spot: best.spot, gait: best.gait, path: best.path, wp: 1, gen: info.gen, okSince: -1 };
      stats.departs++; if (best.gait === 'walk') stats.walkDeparts++; else stats.runDeparts++;
    }
    // ---- active plan ----
    if (obs.t - plan.start > (P.hideMaxS ?? 20)) { stats.timeouts++; return finish(obs); }
    if (plan.phase === 'depart') {
      while (plan.wp < plan.path.length - 1 && dist(me, plan.path[plan.wp]) < 0.8) plan.wp++;
      if (dist(me, plan.spot) <= 0.6) { plan.phase = 'cover'; plan.coverT = obs.t; stats.holds++; }
      else {
        if (due) {   // en route: switch if this route turned bad and something else is clearly better
          const ev = reeval(obs, api, key, focus, plan.gen, false, null), best = ev.best;
          const cur = ev.opts.find((o) => !o.base && o.gait === plan.gait && dist(o.spot, plan.spot) < 1.5);
          if (best !== ev.stay && (!cur || cur.risk > P.hideRouteRiskMax) && best.U > (cur ? cur.U : -Infinity) + 2) { setRoute(best); stats.repositions++; }
          else if (best === ev.stay && ev.stay.risk <= P.hideRouteRiskMax && (!cur || ev.stay.U > cur.U + 2)) { plan.phase = 'cover'; plan.spot = { x: me.x, z: me.z }; plan.coverT = obs.t; stats.holds++; }
        }
        if (plan.phase === 'depart') return { moveTo: plan.path[Math.min(plan.wp, plan.path.length - 1)], ...gaits[plan.gait].act, look: lookAt(obs, last) };
      }
    }
    // cover: hold still and watch; reposition if this spot turns risky; walk back once returning is safe
    if (due) {
      const ev = reeval(obs, api, key, focus, plan.gen, false, null), best = ev.best;
      if (best !== ev.stay && ev.stay.risk > P.hideRouteRiskMax && best.U > ev.stay.U + 2) {
        setRoute(best); plan.phase = 'depart'; stats.repositions++;
        return { moveTo: plan.path[1], ...gaits[plan.gait].act, look: lookAt(obs, last) };
      }
      // return check: is walking back to the original (known) generator safe enough, for long enough?
      let rr;
      if (g && g.known && !g.done && !g.blocked && g.x !== null) rr = dist(me, g) < 1.5 ? ev.stay.risk : routeRisk(obs, api, me, g, 'walk', g).risk;
      else rr = ev.stay.risk;   // no generator to go back to: done once this spot is quiet
      plan.retRisk = rr;
      if (!info.threat || rr <= P.hideReturnRisk) { if (plan.okSince < 0) plan.okSince = obs.t; }
      else plan.okSince = -1;
    }
    if (plan.okSince >= 0 && obs.t - plan.okSince >= P.hideReturnDelayS) { stats.returns++; return finish(obs); }
    return { look: lookAt(obs, last) };
  }
  function setRoute(o) { plan.spot = o.spot; plan.gait = o.gait; plan.path = o.path; plan.wp = 1; }
  function finish(obs) {
    if (plan && plan.gen >= 0) { retGen = plan.gen; retUntil = obs.t + 20; }
    plan = null; stayUntil = obs.t + REPLAN_S;
    return null;
  }
  // where to look: the heaviest hypothesis a second ahead (or the visible hunter)
  function lookAt(obs, ev) {
    if (obs.hunter) return { x: obs.hunter.x + (obs.hunter.vx || 0) * 0.5, z: obs.hunter.z + (obs.hunter.vz || 0) * 0.5 };
    if (!ev || !ev.H.hyps.length) return undefined;
    let b = ev.H.hyps[0];
    for (const tr of ev.H.hyps) if (tr.w > b.w) b = tr;
    return { x: b.x[2], z: b.z[2] };
  }

  return {
    on, stats, GAITS: gaits,
    decide, update, routeRisk, evaluate, choose,
    get active() { return !!plan; },
    get holding() { return !!plan && plan.phase === 'cover'; },
    get plan() { return plan; },
    get last() { return last; },
    // the generator I left for cover and should go back to (index or -1), while that commitment lasts
    returnGen(obs) { return obs.t < retUntil ? retGen : -1; },
    clearReturn() { retGen = -1; retUntil = -99; },
    reset() { plan = null; },
    trail,
  };
}
