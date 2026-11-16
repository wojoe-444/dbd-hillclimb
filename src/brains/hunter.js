// Parametric hunter. Knobs are hill-climbed; `space` = { name: [min, max, default] }.

export const hunterSpace = {
  lungeDist:     [1.2, 4.5, 2.5],  // start the attack when target is this close (and reachable)
  chaseAbandonS: [8, 90, 40],      // give up a chase after this long without a hit
  breakRatio:    [1.2, 5, 2.5],    // break a nearby dropped pallet if path/straight distance exceeds this
  campS:         [0, 45, 5],       // linger near a fresh hook this long
  campRadius:    [4, 24, 10],
  tunnel:        [0, 1, 0.3],      // target preference for survivors with hooks already
  injuredPref:   [0, 15, 5],       // metres of preference for injured targets
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
};

const hyp = (a, b) => Math.sqrt(a * a + b * b);
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
    let ratioT = -99, ratio = 1;
    let prevHooks = 0;
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
      decide(obs, api) {
        const me = obs.self, nav = api.nav;
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
            if (obs.t - ratioT >= 0.5) { ratioT = obs.t; ratio = d > 3 ? nav.dist(me, best) / d : 1; }
            if (ratio > P.breakRatio && d > 2) {
              let bp = null, bpd = Infinity;
              M.pallets.forEach((p, i) => {
                if (obs.pallets[i] !== 'dropped') return;
                const pd = hyp(p.cx - me.x, p.cz - me.z);
                if (pd < bpd && pd < 8) { bpd = pd; bp = p; }
              });
              if (bp) {
                if (bpd <= 2.0) return { act: 'breakPallet', target: bp.id };
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
          if (d2(lastPos, me) > 1.5) return { moveTo: lastPos };
        }
        target = null;
        if (P.followScratch > 0.5) {
          const g = obs.grunts[obs.grunts.length - 1];
          if (g && !outsideLeash(g)) return { moveTo: { x: g.x, z: g.z } };
          const sc = obs.scratches[obs.scratches.length - 1];
          if (sc && !outsideLeash(sc)) {
            const s = sc;
            lastPos = { x: s.x + s.dx * 3, z: s.z + s.dz * 3 }; lastPosT = obs.t;
            return { moveTo: lastPos };
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
        if (patrolGen >= 0) {
          const g = obs.gens[patrolGen];
          const gx = Math.floor(gens[patrolGen].x), gz = Math.floor(gens[patrolGen].z);
          const near = Math.max(Math.abs(me.x - (gx + 0.5)), Math.abs(me.z - (gz + 0.5))) <= 1.5;
          if (near && !g.done && !g.blocked && !g.regressing && g.progress > 0 && g.progress >= P.kickMinProgress && !obs.gatesPowered) {
            return { act: 'kickGen', target: gens[patrolGen].id };
          }
        }
        if (patrolGen < 0 || obs.gens[patrolGen].done || d2(gens[patrolGen], me) < 3 || obs.t - patrolT > 30) {
          let bsc = -Infinity, bi = -1;
          for (let i = 0; i < gens.length; i++) {
            if (obs.gens[i].done || i === patrolGen) continue;
            const inCluster = clusterOn && cluster.members.has(i) ? 1 : 0;
            const s = P.progressW * obs.gens[i].progress * 3 - P.distW * nav.dist(me, gens[i]) / 30 + P.clusterPatrolW * inCluster + ctx.rng.next() * 0.3;
            if (s > bsc) { bsc = s; bi = i; }
          }
          if (bi < 0) bi = patrolGen;
          patrolGen = bi; patrolT = obs.t;
        }
        if (patrolGen >= 0) return { moveTo: gens[patrolGen] };
        return {};
      },
    };
  };
}
