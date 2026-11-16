// Parametric hunter. Knobs are hill-climbed; `space` = { name: [min, max, default] }.
import { SurvivorBelief } from './belief.js';
import { makeLoopMind } from './loopmind.js';

export const hunterSpace = {
  lungeDist:     [1.2, 4.5, 2.5],  // start the attack when target is this close (and reachable)
  chaseAbandonS: [8, 90, 40],      // give up a chase after this long without a hit
  // pallet breaking: the deciding variable is the DETOUR -- extra metres to walk around a dropped pallet from one side
  // to the other compared with going straight through (breaking costs ~2.34 s ~= 10.8 m of walking at 4.6 m/s)
  breakDetourM:  [0, 60, 10.8],   // in a chase: break the dropped pallet between me and my target if its detour exceeds this
  breakNearM:    [2, 12, 6],      // ...and the pallet is within this distance of me
  breakIdleDetourM: [0, 80, 80],  // on patrol: break a dropped pallet within 12 m if its detour exceeds this (80 = never)
  campS:         [0, 45, 5],       // linger near a fresh hook this long
  campRadius:    [4, 24, 10],
  tunnel:        [0, 1, 0.3],      // target preference for survivors with hooks already
  injuredPref:   [-15, 15, 5],     // metres of preference for injured targets (<0: prefer healthy ones = spread damage)
  switchMargin:  [0, 15, 4],       // switch chase target only if another is this much better
  slugDist:      [0, 20, 0],       // leave a downed survivor to chase a visible one within this
  progressW:     [0, 3, 1.5],      // patrol: weight on generator progress
  distW:         [0, 3, 1],        // patrol: weight on distance
  followScratch: [0, 1, 0.7],      // >0.5: follow scratch marks / grunts
  hookGenBias:   [0, 1, 0.2],      // prefer hooks near the most-progressed unfinished gen
  lostSearchS:   [1, 12, 5],       // after losing sight, search last position for this long
  // ---- generator-cluster awareness (the hunter sees every unfinished gen, like the genre's aura) ----
  // All neutral by default: the climb has to discover whether "defend the tightest k-gen cluster" pays.
  clusterK:        [2, 4, 3],      // size of the cluster tracked (rounded): the k unfinished gens closest together
  clusterActivate: [0, 5, 5],      // cluster logic only applies once gensLeft <= this
  clusterPatrolW:  [0, 3, 0],      // patrol preference for gens inside the cluster
  leashDist:       [10, 150, 150], // abandon chases / ignore leads that drag us farther than this (path m) from the cluster
  hookClusterBias: [0, 1, 0],      // prefer hooks near the cluster
  // ---- generator pressure ----
  kickMinProgress: [0, 1, 1],      // kick a patrolled gen if its progress >= this (1 = never kick)
  noiseFollow:     [0, 1, 0.7],    // >0.5: investigate gens heard being repaired (10 m)
  loudReactRange:  [0, 120, 50],   // react to loud noises (fast vaults) within this distance
  // ---- searching without line of sight ----
  lookSweepDeg:    [0, 120, 60],   // glance angle: look this far left/right of the walking direction during a glance
  lookPeriodS:     [1, 10, 4],     // a glance every this many seconds (alternating sides) while patrolling/searching
  glanceS:         [0.2, 1.5, 0.4],// how long each glance lasts; otherwise look where we walk
  staleGenW:       [0, 3, 0],      // patrol preference for gens not looked at for a while (we only know progress we've seen)
  // ---- belief map: per-survivor probability of where they are (see belief.js) ----
  beliefPatrol:    [0, 1, 0.7],    // >0.5: patrol toward the hottest part of the belief map instead of gen-by-gen
  beliefSpread:    [0.2, 1, 0.6],  // how fast a survivor's possible area grows (fraction of running speed)
  beliefGenPull:   [0, 2, 0.5],    // how strongly unseen survivors are assumed to drift back to unfinished gens
  // ---- loop mind games (loopmind.js; all 0 = always path straight at the survivor, the old behaviour) ----
  reverseChance:   [0, 1, 0],      // per loop pass: run the tile the other way round to meet the survivor head-on
  standOffChance:  [0, 1, 0],      // per loop pass (if not reversing): stop and wait, baiting a reversal / a vault back
  standOffMaxS:    [0.5, 4, 1.5],  // ...for at most this long
  predictLeadS:    [0, 1.5, 0],    // chase: aim at the survivor's position this far ahead (velocity, slid along walls)
  // ---- endgame (gates powered): the hunter only learns lever progress by seeing the lever (cone/LOS, or within 2 m) ----
  gatePatrolW:     [0, 1, 0.1],    // 0 = no gate logic (old: patrol blocked gens / belief). >0: rush a lever seen being
                                   // opened (when not in a chase), and go check a lever once
                                   // gatePatrolW * (unseen s / gateCheckS) * (1 + 3 * last seen progress) >= 0.5 (open gate:
                                   // its exit, x2). Default low: n=256 paired runs (gens.needed 2) had lever patrol at 0.6
                                   // give +16 escapes / 186 endgames vs off, rush alone was neutral (+1)
  gateCheckS:      [5, 120, 30],   // seconds a lever may go unchecked before it is "due" (scaled by gatePatrolW)
  gateAbandonProg: [0, 1, 0.5],    // leave a chase for a lever seen being opened (and reachable before it opens) once its
                                   // progress >= this (1 = never leave a chase for a gate)
  // ---- pallet respect: don't run into the stun zone of a standing pallet the chased survivor can drop ----
  // Default OFF: with 1.5 m / 1.5 s stuns fell (champion survivors 4.0 -> 1.6 per match) but kills did too (repairS 45,
  // n=256: -0.035); a survivor that just waits at the pallet outlasts any hold — going around it is loop play.
  palletRespectM:  [0, 4, 0],      // hold this far outside the stun zone (footprint +- 1 m along its axis); also no swing
                                   // across it unless the survivor is on my side; 0 = run through (old behaviour)
  palletRespectS:  [0, 8, 1.5],    // ...for at most this long per pallet, then run through (baits an early drop)
  // ---- hook choice ----
  // Default OFF: 0.3 cost kills in A/B (repairS 45, n=256: -0.035 alone; with pallet respect on as well -0.16 at n=512).
  hookAwayW:       [0, 1, 0],      // prefer hooks away from where the other free survivors are believed to be
                                   // (+ hookAwayW * 40 m per expected survivor within 24 m of the hook); 0 = off
  hookMaxCarryS:   [6, 16, 12],    // ...but only hooks reachable within this many carry seconds in total (own carry clock
                                   // for this survivor since its last hook + travel at carry speed + 1.5 s hook); wiggle-free
                                   // at 16 s. The nearest hook is always allowed.
  // ---- post-hook plan (window = campS): picked once per hook, P(plan) proportional to its weight ----
  // proxy the hook at campRadius (weight 1) | guard the unfinished gen nearest the hook (endgame: the nearest lever)
  // (postHookGenW) | leave at once to roam the belief hot spot (postHookRoamW). Both 0 = old behaviour (proxy).
  postHookGenW:    [0, 3, 1],
  postHookRoamW:   [0, 3, 0.5],
};

const SPACE_DEFAULTS = Object.fromEntries(Object.entries(hunterSpace).map(([k, v]) => [k, v[2]]));

const hyp = (a, b) => Math.sqrt(a * a + b * b);

// Walk toward `to` looking where we walk, with a short glance (glanceS) to alternating sides every periodS seconds.
function sweep(api, me, to, t, sweepDeg, periodS, glanceS = 0.4) {
  const action = { moveTo: to };
  if (sweepDeg < 1) return action;
  const phase = t % periodS;
  if (phase >= glanceS) return action;                      // not glancing: face the walking direction (engine default)
  const wp = api.nav.nextWaypoint(me, to);
  if (!wp) return action;
  const dx = wp.x - me.x, dz = wp.z - me.z, len = Math.hypot(dx, dz);
  if (len < 0.3) return action;
  const side = Math.floor(t / periodS) % 2 === 0 ? 1 : -1;
  const a = Math.atan2(dz, dx) + side * (sweepDeg * Math.PI / 180);
  action.face = { x: me.x + Math.cos(a) * 6, z: me.z + Math.sin(a) * 6 };
  return action;
}
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);

export function makeHunter(P0) {
  const P = { ...SPACE_DEFAULTS, ...P0 };   // older champions lack the newer knobs
  return (ctx) => {
    const M = ctx.map;
    const gens = M.generators;
    let target = null;            // survivor id being chased
    let chaseStart = 0;
    const ignoreUntil = [0, 0, 0, 0];
    let lastPos = null, lastPosT = -99;
    let goto = null;
    let hookTarget = null;
    let camp = null;              // { x, z, until }
    let patrolGen = -1, patrolT = -99;
    // detour cache: pallet index -> { ver, d } where d = extra path metres to get from one side to the other
    const detourCache = new Map();
    const palletSides = M.pallets.map((p) => {
      const ax = p.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      return { ax, a: { x: p.cx - ax.x * 1.6, z: p.cz - ax.z * 1.6 }, b: { x: p.cx + ax.x * 1.6, z: p.cz + ax.z * 1.6 } };
    });
    function detour(obs, nav, i) {
      const ver = obs.pallets.join(',');
      const c = detourCache.get(i);
      if (c && c.ver === ver) return c.d;
      const sd = palletSides[i];
      const around = nav.dist(sd.a, sd.b);             // hunter nav: the dropped pallet itself is blocked
      const d = (around === Infinity ? 200 : around) - 3.2;
      detourCache.set(i, { ver, d });
      return d;
    }
    // the dropped pallet (index) lying between me and point q, if any
    function palletBetween(obs, me, q) {
      let bi = -1, bd = Infinity;
      M.pallets.forEach((p, i) => {
        if (obs.pallets[i] !== 'dropped') return;
        const { ax } = palletSides[i];
        const sm = (me.x - p.cx) * ax.x + (me.z - p.cz) * ax.z, sq = (q.x - p.cx) * ax.x + (q.z - p.cz) * ax.z;
        if (sm * sq >= 0) return;                         // same side
        const lat = (o) => Math.abs((o.x - p.cx) * ax.z - (o.z - p.cz) * ax.x);
        if (lat(me) > 6 || lat(q) > 6) return;            // not really across this pallet
        const d = hyp(p.cx - me.x, p.cz - me.z);
        if (d < bd) { bd = d; bi = i; }
      });
      return bi;
    }
    // a dropped pallet between me and point q (the target, or where I'm searching for it): break it if walking around
    // costs more than breakDetourM and it is within breakNearM; "at the pallet" = the engine's reach (centre to footprint)
    const breakReach = (ctx.config.reach && ctx.config.reach.breakPallet) || 1.5;
    function breakToward(obs, me, nav, q) {
      const pi = palletBetween(obs, me, q);
      if (pi < 0) return null;
      const bp = M.pallets[pi], pd = hyp(bp.cx - me.x, bp.cz - me.z);
      if (!(pd <= P.breakNearM && detour(obs, nav, pi) > P.breakDetourM)) return null;
      const rx = Math.max(bp.x0 - me.x, 0, me.x - bp.x1), rz = Math.max(bp.z0 - me.z, 0, me.z - bp.z1);
      if (hyp(rx, rz) <= breakReach - 0.05) return { act: 'breakPallet', target: bp.id };
      return { moveTo: { x: bp.cx, z: bp.cz } };
    }
    let prevHooks = 0;
    const posHist = [];                            // stall guard: recent positions (one per decision)
    let leadsOffUntil = -99;                       // after a stall: ignore sound/scratch leads for a bit
    const belief = new SurvivorBelief(ctx, { spread: P.beliefSpread, genPull: P.beliefGenPull });
    const mind = makeLoopMind(ctx, P);   // loop mind games (reverse / stand off / lead); inert with the knobs at 0
    let beliefTgt = null, beliefT = -99;
    const downedChecked = [-1, -1, -1, -1]; // lastSeen.t of downed sightings we already went back to
    // cluster state: recomputed whenever a generator completes
    let cluster = null;           // { members: Set<gen index>, anchor: gen index, spread: m }
    let clusterDone = -1;

    function updateCluster(obs) {
      if (cluster && obs.gensDone === clusterDone) return;
      clusterDone = obs.gensDone;
      const open = [];
      for (let i = 0; i < gens.length; i++) if (!obs.gens[i].done) open.push(i);
      const k = Math.min(open.length, Math.round(P.clusterK));
      if (!k) { cluster = null; return; }
      let best = null, bs = Infinity;
      const pick = [];
      const rec = (start) => {
        if (pick.length === k) {
          let sum = 0;
          for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) sum += d2(gens[pick[a]], gens[pick[b]]);
          if (sum < bs) { bs = sum; best = pick.slice(); }
          return;
        }
        for (let i = start; i < open.length; i++) { pick.push(open[i]); rec(i + 1); pick.pop(); }
      };
      rec(0);
      let anchor = best[0], ba = Infinity;
      for (const a of best) {
        let sum = 0; for (const b of best) sum += d2(gens[a], gens[b]);
        if (sum < ba) { ba = sum; anchor = a; }
      }
      cluster = { members: new Set(best), anchor, spread: k > 1 ? bs / ((k * (k - 1)) / 2) : 0 };
    }

    function topGen(obs) {
      let bi = -1, bp = -1;
      for (let i = 0; i < gens.length; i++) if (!obs.gens[i].done && obs.gens[i].progress > bp) { bp = obs.gens[i].progress; bi = i; }
      return bi;
    }

    // ---------------- endgame: lever memory. Only what the hunter perceives: obs.gates[i].progress is present while it
    // sees the lever (cone + LOS, or within 2 m); `open` / `powered` are public. A lever seen twice within 2.5 s with
    // growing progress is "being opened".
    const HC = ctx.config.hunter || {};
    const leverS = (ctx.config.gates && ctx.config.gates.leverS) || 20;
    const carrySpeed = HC.carrySpeed || 3.68, hookActS = HC.hookS || 1.5;
    const GATES = M.exitGates || [];
    const lever = GATES.map(() => ({ seenT: -1e9, prog: 0, risingT: -1e9, visitT: -1e9 }));
    let poweredSeen = false;
    function updateLevers(obs, me) {
      if (!obs.gatesPowered || !obs.gates) return;
      if (!poweredSeen) {                         // just powered: every lever starts one full check period overdue
        poweredSeen = true;
        for (const L of lever) { L.seenT = obs.t - P.gateCheckS; L.visitT = obs.t - P.gateCheckS; }
      }
      for (const g of obs.gates) {
        const i = GATES.findIndex((x) => x.id === g.id);
        if (i < 0) continue;
        const L = lever[i], gl = GATES[i].lever;
        if (d2(me, gl) < 6 || d2(me, GATES[i].exit) < 6) L.visitT = obs.t;
        if (g.open) { L.prog = 1; continue; }
        if (g.progress === undefined || g.progress === null) continue;
        if (g.progress > L.prog + 1e-6 && obs.t - L.seenT <= 2.5) L.risingT = obs.t;
        L.prog = g.progress; L.seenT = obs.t;
      }
    }
    // a lever being opened that I can still reach before it opens (+ the opener's walk to the exit): go there
    function gateRush(obs, me, nav) {
      if (!obs.gatesPowered || !(P.gatePatrolW > 0)) return null;
      let best = null;
      for (let i = 0; i < GATES.length; i++) {
        const L = lever[i], g = obs.gates.find((x) => x.id === GATES[i].id);
        if (!g || g.open || obs.t - L.risingT > 3) continue;
        const remain = (1 - L.prog) * leverS - (obs.t - L.seenT);
        const pt = GATES[i].lever, dist = nav.dist(me, pt);
        const travel = dist / Math.max(1, me.speed || 4.6);
        if (!Number.isFinite(dist) || travel > remain + 5) continue;
        if (!best || travel < best.travel) best = { i, pt, prog: L.prog, travel };
      }
      return best;
    }
    // idle in the endgame: swing by a lever that is due (unchecked for long, weighted by its last seen progress), or the
    // exit of an open gate (survivors leave there) if I haven't been near it for a while
    function gatePatrol(obs, me) {
      if (!obs.gatesPowered || !(P.gatePatrolW > 0)) return null;
      let bt = null, bs = 0.5;
      for (let i = 0; i < GATES.length; i++) {
        const L = lever[i], g = obs.gates.find((x) => x.id === GATES[i].id);
        if (!g) continue;
        const s = g.open ? P.gatePatrolW * 2 * (obs.t - L.visitT) / P.gateCheckS
          : P.gatePatrolW * (obs.t - L.seenT) / P.gateCheckS * (1 + 3 * L.prog);
        if (s >= bs) { bs = s; bt = g.open ? GATES[i].exit : GATES[i].lever; }
      }
      return bt;
    }

    // ---------------- pallet respect: the chased survivor is at a standing pallet -> hold outside its stun zone
    const stunAlong = HC.palletStunAlongM ?? 1.0;
    const respect = new Map();                    // pallet index -> { t0, last }
    const rectDist = (o, x0, z0, x1, z1) => hyp(Math.max(x0 - o.x, 0, o.x - x1), Math.max(z0 - o.z, 0, o.z - z1));
    function palletRespect(obs, me, s) {
      if (!(P.palletRespectM > 0) || !(P.palletRespectS > 0)) return null;
      for (let i = 0; i < M.pallets.length; i++) {
        if (obs.pallets[i] !== 'up') continue;
        const p = M.pallets[i];
        if (rectDist(s, p.x0, p.z0, p.x1, p.z1) > 2.0) continue;          // survivor can't drop it (soon)
        const ax = p.axis === 'x';
        const md = ax ? rectDist(me, p.x0 - stunAlong, p.z0, p.x1 + stunAlong, p.z1) : rectDist(me, p.x0, p.z0 - stunAlong, p.x1, p.z1 + stunAlong);
        if (md <= 0.05 || md > P.palletRespectM) continue;              // already committed / not there yet
        const along = (o) => ax ? o.x - p.cx : o.z - p.cz;
        if (along(me) * along(s) > 0 && d2(me, s) <= P.lungeDist) continue; // on my side and in reach: swing, don't wait
        let r = respect.get(i);
        if (!r || obs.t - r.last > 3) { r = { t0: obs.t, last: obs.t }; respect.set(i, r); }
        r.last = obs.t;
        if (obs.t - r.t0 > P.palletRespectS) continue;                    // waited long enough: run through
        return { moveDir: { x: 0, z: 0 }, face: { x: s.x, z: s.z } };
      }
      return null;
    }

    // ---------------- carry clock per survivor (wiggle is 16 s, persists across drops; reset by a hook / standing up)
    const carryClock = [0, 0, 0, 0];
    let lastDecideT = 0;
    // expected number of OTHER free survivors (belief) within r of a point
    function othersNear(pt, r) {
      let m = 0;
      for (let k = 0; k < 4; k++) if (belief.state[k] === 'alive') m += belief.massNear(k, pt.x, pt.z, r);
      return m;
    }

    return {
      belief,   // exposed for the viewer's heat-map overlay (read-only)
      mind,     // loop mind-game state + counters (diagnostics / tests; read-only)
      decide(obs, api) {
        const me = obs.self, nav = api.nav;
        belief.update(obs, api);
        updateLevers(obs, me);
        // carry clock: own carry time per survivor since its last hook / since it was last seen standing
        const dtD = Math.max(0, obs.t - lastDecideT); lastDecideT = obs.t;
        if (me.carrying !== null && me.carrying !== undefined) carryClock[me.carrying] += dtD;
        for (const h of obs.hooked) carryClock[h.id] = 0;
        for (const s of obs.survivors) if (s.state === 'healthy' || s.state === 'injured') carryClock[s.id] = 0;
        // stall guard: barely moved over the last 2 s while free to move (not acting / cooling down / vaulting / stunned /
        // carrying) -> the current goal is unreachable or sits behind an obstacle (e.g. a lead on a dropped pallet): drop it
        const free = !me.act && !me.vaulting && !(me.stunS > 0) && !(me.cooldownS > 0) && !(me.windupS > 0) && me.carrying === null;
        if (free && !(mind.mode && mind.mode.kind === 'stand')) posHist.push([me.x, me.z]); else posHist.length = 0;   // (a loop stand-off stands still on purpose)
        if (posHist.length > 20) posHist.shift();
        if (posHist.length === 20 && Math.hypot(me.x - posHist[0][0], me.z - posHist[0][1]) < 1.0) {
          posHist.length = 0; goto = null; lastPos = null; beliefTgt = null; patrolGen = -1; camp = null; leadsOffUntil = obs.t + 4;
        }
        const leadsOn = obs.t >= leadsOffUntil;
        updateCluster(obs);
        const gensLeft = obs.gensNeeded - obs.gensDone;
        const clusterOn = cluster && gensLeft <= P.clusterActivate;
        const anchor = cluster ? gens[cluster.anchor] : null;
        const cdRaw = clusterOn ? nav.dist(me, anchor) : 0;
        const clusterDist = Number.isFinite(cdRaw) ? cdRaw : 0;    // my path distance to the cluster (unreachable cluster: ignore the leash)
        const outsideLeash = (pt) => clusterOn && d2(pt, anchor) > P.leashDist;

        // ---- carrying ----
        if (me.carrying === null) hookTarget = null;
        if (me.carrying !== null) {
          if (!hookTarget || obs.hooked.some((x) => x.hookId === hookTarget.id)) {
            const taken = new Set(obs.hooked.map((x) => x.hookId));
            const tg = topGen(obs);
            let bs = Infinity; hookTarget = null;
            const cand = [];
            let nd = Infinity;
            for (const k of M.hooks) {
              if (taken.has(k.id)) continue;
              const d = nav.dist(me, k);
              if (d > 60) continue;
              cand.push([k, d]); if (d < nd) nd = d;
            }
            // carry budget: a non-nearest hook only if the whole carry (clock so far + travel + hooking) fits hookMaxCarryS
            const clock = carryClock[me.carrying] || 0;
            for (const [k, d] of cand) {
              if (d > nd && clock + d / carrySpeed + hookActS > P.hookMaxCarryS) continue;
              const s = d + (tg >= 0 ? P.hookGenBias * d2(k, gens[tg]) : 0) + (clusterOn ? P.hookClusterBias * d2(k, anchor) : 0)
                + (P.hookAwayW > 0 ? P.hookAwayW * 40 * othersNear(k, 24) : 0);
              if (s < bs) { bs = s; hookTarget = k; }
            }
          }
          if (!hookTarget) return {};
          if (d2(hookTarget, me) <= 1.3) return { act: 'hook', target: hookTarget.id };
          return { moveTo: hookTarget };
        }
        const nHooked = obs.hooked.length;
        if (nHooked > prevHooks && P.campS > 0.5) {
          const fresh = obs.hooked[obs.hooked.length - 1];
          const hk = M.hooks.find((k) => k.id === fresh.hookId);
          if (hk) {
            // post-hook plan, drawn once per hook: proxy (weight 1) / guard the gen nearest the hook / roam the belief
            camp = { x: hk.x, z: hk.z, until: obs.t + P.campS, mode: 'proxy' };
            const wG = P.postHookGenW, wR = P.postHookRoamW;
            if (wG + wR > 0) {
              const r = ctx.rng.next() * (1 + wG + wR);
              if (r >= 1 + wG) { camp = null; beliefTgt = null; }
              else if (r >= 1) {
                let gp = null, gd = Infinity;      // endgame: the nearest unopened lever; else the nearest unfinished gen (<= 40 m)
                if (obs.gatesPowered) {
                  for (let i = 0; i < GATES.length; i++) {
                    const g = obs.gates.find((x) => x.id === GATES[i].id), dd = d2(GATES[i].lever, hk);
                    if (g && !g.open && dd < gd) { gd = dd; gp = { x: GATES[i].lever.x, z: GATES[i].lever.z, gi: -1 }; }
                  }
                } else {
                  gd = 40;
                  for (let i = 0; i < gens.length; i++) {
                    if (obs.gens[i].done || obs.gens[i].blocked) continue;
                    const dd = d2(gens[i], hk);
                    if (dd < gd) { gd = dd; gp = { x: gens[i].x, z: gens[i].z, gi: i }; }
                  }
                }
                if (gp) { camp.mode = 'gen'; camp.g = gp; goto = null; }
              }
            }
          }
        }
        prevHooks = nHooked;

        // ---- choose a visible target ----
        const vis = obs.survivors.filter((s) => s.state !== 'hooked' && s.state !== 'carried');
        const score = (s) => {
          let v = d2(s, me);
          if (s.state === 'injured') v -= P.injuredPref;
          v -= P.tunnel * 15 * (s.hookCount || 0);
          if (obs.t < ignoreUntil[s.id]) v += 1000;
          return v;
        };
        let best = null, bs = Infinity;
        for (const s of vis) {
          if (s.state === 'downed') continue;
          const v = score(s) - (s.id === target ? P.switchMargin : 0);
          if (v < bs) { bs = v; best = s; }
        }
        const downed = vis.filter((s) => s.state === 'downed').sort((a, b) => d2(a, me) - d2(b, me))[0];
        if (downed && !(best && d2(best, me) < P.slugDist && bs < 500)) {
          if (d2(downed, me) <= 1.4) return { act: 'pickup', target: downed.id };
          return { moveTo: { x: downed.x, z: downed.z } };
        }
        // endgame: a lever seen being opened. Go unless I'm chasing someone near it (likely the opener) or the lever is
        // not far enough along to leave my chase for (gateAbandonProg)
        const rush = gateRush(obs, me, nav);
        if (rush && !(best && bs < 500 && (d2(best, rush.pt) <= 10 || rush.prog < P.gateAbandonProg))) {
          if (best && bs < 500) { target = null; lastPos = null; }
          return { moveTo: rush.pt, face: rush.pt };
        }
        if (best && bs < 500) {
          if (best.id !== target) { target = best.id; chaseStart = obs.t; }
          // leash: the chase is dragging us too far from the cluster and the target is heading away from it
          const leashBreak = clusterOn && clusterDist > P.leashDist && d2(best, anchor) > d2(me, anchor);
          if (obs.t - chaseStart > P.chaseAbandonS || leashBreak) {
            ignoreUntil[target] = obs.t + 15; target = null;
          } else {
            lastPos = { x: best.x + best.vx * 0.8, z: best.z + best.vz * 0.8 }; lastPosT = obs.t;
            const d = d2(best, me);
            // a dropped pallet between us: break it if walking around costs more than breakDetourM
            const brkA = d > 2 ? breakToward(obs, me, nav, best) : null;
            if (brkA) return brkA;
            // a standing pallet the survivor can drop: hold outside its stun zone (also no swing across it, which walks
            // into the zone during the windup)
            const hold = palletRespect(obs, me, best);
            if (hold) { posHist.length = 0; return hold; }
            // only swing if we can physically reach: straight line clear, or a short walking path
            // (a survivor mid-vault is hittable until fully landed, even though the window blocks walking)
            if (d <= P.lungeDist && (best.vaulting || api.walkClear(me, best) || nav.dist(me, best) <= P.lungeDist + 1)) {
              return { act: 'attack', target: best.id, face: { x: best.x, z: best.z } };
            }
            return mind.step(obs, api, me, best, d) || { moveTo: mind.aim(api, best) };
          }
        }

        // ---- a survivor we downed crawled out of view: go back for them ----
        {
          let bj = -1, bd = Infinity;
          for (let j = 0; j < 4; j++) {
            const ls = obs.lastSeen[j];
            if (!ls || ls.state !== 'downed' || obs.status[j] !== 'alive' || ls.t <= downedChecked[j]) continue;
            if (obs.hooked.some((x) => x.id === j)) continue;
            const d = d2(ls, me);
            if (d < bd) { bd = d; bj = j; }
          }
          if (bj >= 0) {
            const ls = obs.lastSeen[bj];
            // crawl speed 0.7 m/s: search where they could have got to
            if (bd > 2) return { moveTo: { x: ls.x, z: ls.z } };
            downedChecked[bj] = ls.t;
          }
        }

        // ---- lost sight mid mind game (a reversal runs out of view by design): keep it going a little (loopmind.js) ----
        if (target !== null) { const mg = mind.unseen(obs, api, me); if (mg) return mg; }
        // ---- lost sight: search ----
        if (lastPos && obs.t - lastPosT < P.lostSearchS && !outsideLeash(lastPos)) {
          if (P.followScratch > 0.5 && obs.scratches.length) {
            const s = obs.scratches[obs.scratches.length - 1];
            lastPos = { x: s.x + s.dx * 3, z: s.z + s.dz * 3 }; lastPosT = obs.t;
          }
          // the survivor slipped over a dropped pallet: same break rule as in sight (it used to walk around every time)
          const brkS = breakToward(obs, me, nav, lastPos);
          if (brkS) return brkS;
          if (d2(lastPos, me) > 1.5) return sweep(api, me, lastPos, obs.t, P.lookSweepDeg, P.lookPeriodS, P.glanceS);
          lastPos = null;   // arrived and nobody here: forget it (otherwise we dither between this and the next behaviour)
        }
        target = null;
        if (P.followScratch > 0.5 && leadsOn) {
          const g = obs.grunts[obs.grunts.length - 1];
          if (g && !outsideLeash(g)) return { moveTo: { x: g.x, z: g.z } };
          const sc = obs.scratches[obs.scratches.length - 1];
          if (sc && !outsideLeash(sc)) {
            const s = sc;
            lastPos = { x: s.x + s.dx * 3, z: s.z + s.dz * 3 }; lastPosT = obs.t;
            return sweep(api, me, lastPos, obs.t, P.lookSweepDeg, P.lookPeriodS, P.glanceS);
          }
        }

        // ---- camp a fresh hook ----
        if (camp && obs.t < camp.until && obs.hooked.length) {
          // proxy: random points around the hook at campRadius; gen guard: around the guarded gen / lever at ~4 m
          const c = camp.mode === 'gen' ? camp.g : camp;
          if (camp.mode === 'gen' && c.gi >= 0) {
            const g = obs.gens[c.gi], gx = Math.floor(c.x), gz = Math.floor(c.z);
            const near = Math.max(Math.abs(me.x - (gx + 0.5)), Math.abs(me.z - (gz + 0.5))) <= 1.5;
            if (near && !g.done && !g.blocked && !g.regressing && g.progress > 0 && g.progress >= P.kickMinProgress && !obs.gatesPowered && (g.kicksLeft ?? 1) > 0) {
              return { act: 'kickGen', target: gens[c.gi].id };
            }
          }
          const r = camp.mode === 'gen' ? 4 / 0.7 : P.campRadius;
          if (!goto || d2(goto, me) < 1.5) {
            const a = ctx.rng.next() * Math.PI * 2;
            goto = { x: c.x + Math.cos(a) * r * 0.7, z: c.z + Math.sin(a) * r * 0.7 };
            if (nav.dist(me, goto) === Infinity) goto = { x: c.x, z: c.z };
          }
          return { moveTo: goto, face: { x: c.x, z: c.z } };
        }

        // ---- repair noise: someone is on a gen within 10 m ----
        if (P.noiseFollow > 0.5 && leadsOn && obs.noisyGens && obs.noisyGens.length) {
          const g = obs.noisyGens[0];
          if (!outsideLeash(g)) return { moveTo: { x: g.x, z: g.z } };
        }

        // ---- notifications ----
        for (const n of obs.newNotifications) {
          if (n.type === 'loudNoise' && d2(n, me) < P.loudReactRange && !outsideLeash(n)) goto = { x: n.x, z: n.z };
        }
        if (goto && d2(goto, me) > 2.5 && !camp) return { moveTo: goto };
        goto = null;
        camp = null;

        // ---- endgame: swing by a lever that is due / the exit of an open gate ----
        const gpt = gatePatrol(obs, me);
        if (gpt) return sweep(api, me, gpt, obs.t, P.lookSweepDeg, P.lookPeriodS, P.glanceS);

        // ---- patrol gens ----
        // ---- patrol housekeeping: break a nearby dropped pallet that's expensive to walk around ----
        if (P.breakIdleDetourM < 80) {
          let bi = -1, bd = Infinity;
          M.pallets.forEach((p, i) => { if (obs.pallets[i] === 'dropped') { const dd = hyp(p.cx - me.x, p.cz - me.z); if (dd < 12 && dd < bd) { bd = dd; bi = i; } } });
          if (bi >= 0 && detour(obs, nav, bi) > P.breakIdleDetourM) {
            const bp = M.pallets[bi];
            if (bd <= 2.0) return { act: 'breakPallet', target: bp.id };
            return { moveTo: { x: bp.cx, z: bp.cz } };
          }
        }

        // ---- belief patrol: go where survivors most likely are ----
        if (P.beliefPatrol > 0.5) {
          if (!beliefTgt || obs.t - beliefT > 2 || d2(beliefTgt, me) < 3) {
            beliefTgt = belief.bestTarget(me, nav, 9, P.distW);
            beliefT = obs.t;
          }
          if (beliefTgt) return sweep(api, me, beliefTgt, obs.t, P.lookSweepDeg, P.lookPeriodS, P.glanceS);
        }

        if (patrolGen >= 0) {
          const g = obs.gens[patrolGen];
          const gx = Math.floor(gens[patrolGen].x), gz = Math.floor(gens[patrolGen].z);
          const near = Math.max(Math.abs(me.x - (gx + 0.5)), Math.abs(me.z - (gz + 0.5))) <= 1.5;
          if (near && !g.done && !g.blocked && !g.regressing && g.progress > 0 && g.progress >= P.kickMinProgress && !obs.gatesPowered && (g.kicksLeft ?? 1) > 0) {
            return { act: 'kickGen', target: gens[patrolGen].id };
          }
        }
        if (patrolGen < 0 || obs.gens[patrolGen].done || d2(gens[patrolGen], me) < 3 || obs.t - patrolT > 30) {
          let bsc = -Infinity, bi = -1;
          for (let i = 0; i < gens.length; i++) {
            if (obs.gens[i].done || i === patrolGen) continue;
            const inCluster = clusterOn && cluster.members.has(i) ? 1 : 0;
            const stale = obs.gens[i].visible ? 0 : Math.min(1, (obs.t - (obs.gens[i].seenT ?? 0)) / 90);   // unseen for 90 s = fully stale
            const s = P.progressW * obs.gens[i].progress * 3 - P.distW * nav.dist(me, gens[i]) / 30 + P.clusterPatrolW * inCluster + P.staleGenW * stale + ctx.rng.next() * 0.3;
            if (s > bsc) { bsc = s; bi = i; }
          }
          if (bi < 0) bi = patrolGen;
          patrolGen = bi; patrolT = obs.t;
        }
        if (patrolGen >= 0) return sweep(api, me, gens[patrolGen], obs.t, P.lookSweepDeg, P.lookPeriodS, P.glanceS);
        return {};
      },
    };
  };
}
