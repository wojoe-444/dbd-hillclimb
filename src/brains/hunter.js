// Parametric hunter. Knobs are hill-climbed; `space` = { name: [min, max, default] }.
import { SurvivorBelief } from './belief.js';

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
  notifyRange:   [0, 120, 50],     // react to fumble notifications within this distance
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
  lookSweepDeg:    [0, 90, 40],    // sweep the vision cone +-this around the walking direction while patrolling/searching
  lookPeriodS:     [1, 8, 3],      // one full left-right sweep takes this long
  staleGenW:       [0, 3, 0],      // patrol preference for gens not looked at for a while (we only know progress we've seen)
  // ---- belief map: per-survivor probability of where they are (see belief.js) ----
  beliefPatrol:    [0, 1, 0.7],    // >0.5: patrol toward the hottest part of the belief map instead of gen-by-gen
  beliefSpread:    [0.2, 1, 0.6],  // how fast a survivor's possible area grows (fraction of running speed)
  beliefGenPull:   [0, 2, 0.5],    // how strongly unseen survivors are assumed to drift back to unfinished gens
};

const hyp = (a, b) => Math.sqrt(a * a + b * b);

// Walk toward `to` while sweeping the gaze +-sweepDeg around the walking direction (sinusoid with period periodS).
function sweep(api, me, to, t, sweepDeg, periodS) {
  const action = { moveTo: to };
  if (sweepDeg < 1) return action;
  const wp = api.nav.nextWaypoint(me, to);
  if (!wp) return action;
  const dx = wp.x - me.x, dz = wp.z - me.z, len = Math.hypot(dx, dz);
  if (len < 0.3) return action;
  const a = Math.atan2(dz, dx) + (sweepDeg * Math.PI / 180) * Math.sin((2 * Math.PI * t) / periodS);
  action.face = { x: me.x + Math.cos(a) * 6, z: me.z + Math.sin(a) * 6 };
  return action;
}
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);

export function makeHunter(P) {
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
    let prevHooks = 0;
    let stillT = 0, lastX = null, lastZ = null;   // stall guard
    const belief = new SurvivorBelief(ctx, { spread: P.beliefSpread, genPull: P.beliefGenPull });
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

    return {
      belief,   // exposed for the viewer's heat-map overlay (read-only)
      decide(obs, api) {
        const me = obs.self, nav = api.nav;
        belief.update(obs, api);
        // stall guard: standing still without acting for 3 s (unreachable moveTo) -> drop the current goals
        if (lastX !== null && Math.hypot(me.x - lastX, me.z - lastZ) < 0.05 && !me.act && !me.vaulting && !(me.stunS > 0) && !(me.cooldownS > 0)) stillT += api.dt; else stillT = 0;
        lastX = me.x; lastZ = me.z;
        if (stillT > 3) { stillT = 0; goto = null; lastPos = null; beliefTgt = null; patrolGen = -1; camp = null; }
        updateCluster(obs);
        const gensLeft = obs.gensNeeded - obs.gensDone;
        const clusterOn = cluster && gensLeft <= P.clusterActivate;
        const anchor = cluster ? gens[cluster.anchor] : null;
        const clusterDist = clusterOn ? nav.dist(me, anchor) : 0;   // my path distance to the cluster
        const outsideLeash = (pt) => clusterOn && d2(pt, anchor) > P.leashDist;

        // ---- carrying ----
        if (me.carrying === null) hookTarget = null;
        if (me.carrying !== null) {
          if (!hookTarget || obs.hooked.some((x) => x.hookId === hookTarget.id)) {
            const taken = new Set(obs.hooked.map((x) => x.hookId));
            const tg = topGen(obs);
            let bs = Infinity; hookTarget = null;
            for (const k of M.hooks) {
              if (taken.has(k.id)) continue;
              const d = nav.dist(me, k);
              if (d > 60) continue;
              const s = d + (tg >= 0 ? P.hookGenBias * d2(k, gens[tg]) : 0) + (clusterOn ? P.hookClusterBias * d2(k, anchor) : 0);
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
          if (hk) camp = { x: hk.x, z: hk.z, until: obs.t + P.campS };
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
            const pi = d > 2 ? palletBetween(obs, me, best) : -1;
            if (pi >= 0) {
              const bp = M.pallets[pi], pd = hyp(bp.cx - me.x, bp.cz - me.z);
              if (pd <= P.breakNearM && detour(obs, nav, pi) > P.breakDetourM) {
                if (pd <= 2.0) return { act: 'breakPallet', target: bp.id };
                return { moveTo: { x: bp.cx, z: bp.cz } };
              }
            }
            // only swing if we can physically reach: straight line clear, or a short walking path
            if (d <= P.lungeDist && (api.walkClear(me, best) || nav.dist(me, best) <= P.lungeDist + 1)) {
              return { act: 'attack', target: best.id, face: { x: best.x, z: best.z } };
            }
            return { moveTo: { x: best.x, z: best.z } };
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

        // ---- lost sight: search ----
        if (lastPos && obs.t - lastPosT < P.lostSearchS && !outsideLeash(lastPos)) {
          if (P.followScratch > 0.5 && obs.scratches.length) {
            const s = obs.scratches[obs.scratches.length - 1];
            lastPos = { x: s.x + s.dx * 3, z: s.z + s.dz * 3 }; lastPosT = obs.t;
          }
          if (d2(lastPos, me) > 1.5) return sweep(api, me, lastPos, obs.t, P.lookSweepDeg, P.lookPeriodS);
          lastPos = null;   // arrived and nobody here: forget it (otherwise we dither between this and the next behaviour)
        }
        target = null;
        if (P.followScratch > 0.5) {
          const g = obs.grunts[obs.grunts.length - 1];
          if (g && !outsideLeash(g)) return { moveTo: { x: g.x, z: g.z } };
          const sc = obs.scratches[obs.scratches.length - 1];
          if (sc && !outsideLeash(sc)) {
            const s = sc;
            lastPos = { x: s.x + s.dx * 3, z: s.z + s.dz * 3 }; lastPosT = obs.t;
            return sweep(api, me, lastPos, obs.t, P.lookSweepDeg, P.lookPeriodS);
          }
        }

        // ---- camp a fresh hook ----
        if (camp && obs.t < camp.until && obs.hooked.length) {
          const r = P.campRadius;
          if (!goto || d2(goto, me) < 1.5) {
            const a = ctx.rng.next() * Math.PI * 2;
            goto = { x: camp.x + Math.cos(a) * r * 0.7, z: camp.z + Math.sin(a) * r * 0.7 };
            if (nav.dist(me, goto) === Infinity) goto = { x: camp.x, z: camp.z };
          }
          return { moveTo: goto, face: camp };
        }

        // ---- repair noise: someone is on a gen within 10 m ----
        if (P.noiseFollow > 0.5 && obs.noisyGens && obs.noisyGens.length) {
          const g = obs.noisyGens[0];
          if (!outsideLeash(g)) return { moveTo: { x: g.x, z: g.z } };
        }

        // ---- notifications ----
        for (const n of obs.newNotifications) {
          if (n.type === 'fumble' && d2(n, me) < P.notifyRange && !outsideLeash(n)) goto = { x: n.x, z: n.z };
          if (n.type === 'loudNoise' && d2(n, me) < P.loudReactRange && !outsideLeash(n)) goto = { x: n.x, z: n.z };
        }
        if (goto && d2(goto, me) > 2.5 && !camp) return { moveTo: goto };
        goto = null;
        camp = null;

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
          if (beliefTgt) return sweep(api, me, beliefTgt, obs.t, P.lookSweepDeg, P.lookPeriodS);
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
        if (patrolGen >= 0) return sweep(api, me, gens[patrolGen], obs.t, P.lookSweepDeg, P.lookPeriodS);
        return {};
      },
    };
  };
}
