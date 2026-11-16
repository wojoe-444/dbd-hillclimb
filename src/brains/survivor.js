// Parametric survivor. Solo-queue rules: no module-level mutable state; everything lives in the closure.
// Knobs are hill-climbed; `space` = { name: [min, max, default] }.

export const survivorSpace = {
  fleeSeenDist:  [6, 40, 20],    // hunter seen within this -> chase mode
  fleeTR:        [0, 32, 12],    // abandon a gen when the heard terror layer's midpoint (26.7 / 16 / 5.3 m) is below this
  calmS:         [1, 12, 4],     // seconds without sighting (and terror > fleeTR) before calming down
  walkWhenTR:    [0, 1, 0.5],    // >0.5: walk (no scratch marks) when sneaking away from terror
  palletDropDist:[1.5, 6, 3],    // drop an up pallet when the hunter is this close to it
  vaultDist:     [1.5, 8, 4],    // cross a window/dropped pallet when hunter on our side within this
  loopRace:      [0.4, 1.2, 0.8],// take a loop anchor only if our path < loopRace * hunter's distance to it
  loopRange:     [8, 40, 25],    // max path distance to a loop anchor
  altruism:      [0, 1, 0.6],    // willingness to rescue / heal
  rescueDelayS:  [0, 40, 8],     // wait after spotting a hooked teammate (anti-camp)
  campAvoidDist: [0, 20, 8],     // don't approach a hook while the hunter is seen within this of it
  hookCheck:     [0, 1, 0.5],    // >threshold: go check hooks near where we saw the hunter carrying someone
  healDist:      [0, 40, 15],    // heal visible injured/downed teammates within this
  genDistW:      [0, 2, 1],
  genProgW:      [0, 2, 1],
  spreadW:       [0, 2, 0.5],    // avoid gens with visible workers
  hunterAvoidW:  [0, 2, 1],      // avoid gens near the last hunter sighting
  sneakMaxS:     [3, 60, 15],    // give up sneaking (go back to work despite terror) after this long
  protectHoldS:  [0, 10, 0],     // after unhook: hold off conspicuous actions (repair/heal/rescue/gate) for this many of the 10 protected seconds
  mendRiskDist:  [0, 40, 16],    // only mend Deep Wound if the hunter isn't seen within this
  holdMaxS:      [0, 20, 4],     // max time to hold at a loop anchor while the hunter isn't pressing us (seen + approaching)
};

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);
function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return hyp(dx, dz);
}

export function makeSurvivor(P) {
  return (ctx) => {
    const M = ctx.map;
    const gens = M.generators;
    // loop anchors: windows and pallets with their two approach points
    const anchors = [];
    for (const w of M.windows) {
      const c = { x: w.x + 0.5, z: w.z + 0.5 };
      const ax = w.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      anchors.push({ kind: 'w', id: w.id, c, s: [{ x: c.x - ax.x * 1.6, z: c.z - ax.z * 1.6 }, { x: c.x + ax.x * 1.6, z: c.z + ax.z * 1.6 }] });
    }
    M.pallets.forEach((p, i) => {
      const c = { x: p.cx, z: p.cz };
      const ax = p.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      anchors.push({ kind: 'p', i, p, c, s: [{ x: c.x - ax.x * 1.6, z: c.z - ax.z * 1.6 }, { x: c.x + ax.x * 1.6, z: c.z + ax.z * 1.6 }] });
    });

    let mode = 'work';          // work | chase | sneak
    let lastThreatT = -99;
    let anchor = null;
    let genTarget = -1;
    let carrySeen = null;        // {x,z,t} last time we saw the hunter carrying someone
    const hookSpotted = {};      // teammate id -> first time seen hooked
    const checkedHooks = new Set();
    const dismissed = [-1, -1, -1, -1]; // lastSeen.t values we already found stale
    let fleePoint = null, fleeT = -99;
    let sneakStart = -1;
    let idleHoldT = 0;            // time spent holding at an anchor without being pressed

    const anchorUsable = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] !== 'broken');
    const crossable = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] === 'dropped');
    const side = (a, pt) => (d2(a.s[0], pt) <= d2(a.s[1], pt) ? 0 : 1);

    function chase(obs, api, me, h) {
      const nav = api.nav;
      const hp = h ?? obs.lastHunter;
      if (!hp) return null;
      // drop / loop at current anchor
      if (anchor && !anchorUsable(anchor, obs)) anchor = null;
      if (anchor && d2(me, anchor.c) > 8) anchor = null;
      if (!anchor) {
        let best = null, bd = Infinity;
        for (const a of anchors) {
          if (!anchorUsable(a, obs)) continue;
          const dh = d2(hp, a.c);
          if (d2(me, a.c) > P.loopRange) continue;
          const dm = nav.dist(me, a.c);
          if (dm < P.loopRange && dm < P.loopRace * dh && dm < bd) { bd = dm; best = a; }
        }
        anchor = best;
      }
      if (anchor) {
        const ms = side(anchor, me), hs = side(anchor, hp);
        const dhm = d2(hp, me);
        // hold an anchor only while the hunter is actually pressing us (seen, close, closing in); otherwise give up the loop
        const pressing = h && dhm < 16 && ((h.vx * (me.x - h.x) + h.vz * (me.z - h.z)) / Math.max(0.1, dhm)) > 1.0;
        idleHoldT = pressing ? 0 : idleHoldT + api.dt * (ctx.config.decisionEvery || 1);
        if (idleHoldT > P.holdMaxS) { anchor = null; idleHoldT = 0; return null; }
        if (anchor.kind === 'p' && obs.pallets[anchor.i] === 'up') {
          const p = anchor.p;
          const near = rectDist(me.x, me.z, p.x0, p.z0, p.x1, p.z1) <= 1.1;
          if (near && hs !== ms && d2(hp, anchor.c) < P.palletDropDist) return { act: 'dropPallet', target: p.id };
          if (near && dhm < P.palletDropDist * 0.6) return { act: 'dropPallet', target: p.id };
          // get to the far side of the standing pallet
          return { moveTo: anchor.s[1 - hs] };
        }
        if (crossable(anchor, obs)) {
          if (hs === ms && dhm < P.vaultDist) return { moveTo: anchor.s[1 - ms] };
          return { moveTo: anchor.s[ms], face: hp };
        }
      }
      // open flee: pick a far, reachable point; refresh every 1 s
      if (!fleePoint || obs.t - fleeT > 1 || d2(me, fleePoint) < 2) {
        fleeT = obs.t;
        let bs = -Infinity;
        const cands = [...gens, ...M.hooks];
        for (const c of cands) {
          const s = d2(c, hp) - 0.6 * d2(c, me);
          if (d2(c, hp) < d2(me, hp)) continue;
          if (s > bs) { bs = s; fleePoint = { x: c.x, z: c.z }; }
        }
      }
      if (fleePoint) return { moveTo: fleePoint };
      return { moveDir: { x: me.x - hp.x, z: me.z - hp.z } };
    }

    return {
      decide(obs, api) {
        const me = obs.self, h = obs.hunter, nav = api.nav;
        if (me.state === 'carried') return { act: 'wiggle' };
        if (me.state === 'downed') {
          const hp = h ?? obs.lastHunter;
          return hp ? { moveDir: { x: me.x - hp.x, z: me.z - hp.z } } : {};
        }
        if (h && h.carrying !== null && h.carrying !== undefined) carrySeen = { x: h.x, z: h.z, t: obs.t };

        // ---- threat state ----
        const dh = h ? d2(h, me) : Infinity;
        if (h && dh < P.fleeSeenDist) { mode = 'chase'; lastThreatT = obs.t; }
        else if (!h && obs.terror !== null && obs.terror.approx < P.fleeTR && !(mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS)) {
          if (mode !== 'chase' && mode !== 'sneak') { mode = 'sneak'; sneakStart = obs.t; }
          lastThreatT = obs.t;
        }
        else if (mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS) { mode = 'work'; anchor = null; }
        else if (obs.t - lastThreatT > P.calmS) { mode = 'work'; anchor = null; }

        if (mode === 'chase') {
          const a = chase(obs, api, me, h);
          if (a) return a;
          mode = 'sneak'; sneakStart = obs.t;
        }
        const walk = P.walkWhenTR > 0.5 && obs.terror !== null;

        // ---- Deep Wound: mend (stand still) unless the hunter is close ----
        if (me.deepWoundS !== null && me.deepWoundS !== undefined && !(h && dh < P.mendRiskDist)) return { act: 'mend' };
        // ---- fresh off the hook: keep the protections (no conspicuous actions) for a while ----
        const holdProtection = me.protectedS !== null && me.protectedS !== undefined && me.protectedS > 10 - P.protectHoldS;

        // ---- endgame: open a gate and leave ----
        if (obs.gatesPowered) {
          let best = null, bd = Infinity;
          for (const g of obs.gates) {
            const gd = M.exitGates.find((x) => x.id === g.id);
            let d = nav.dist(me, g.open ? gd.exit : gd.lever);
            if (!g.open && obs.teammates.some((t) => d2(t, gd.lever) < 1.6) && d2(me, gd.lever) > 1.6) d += 60; // lever taken: one opener per lever
            if (d < bd) { bd = d; best = { g, gd }; }
          }
          if (best) {
            const { g, gd } = best;
            if (g.open) return { moveTo: gd.exit };
            if (d2(gd.lever, me) <= 1.4 && !holdProtection) return { act: 'openGate', target: g.id };
            return { moveTo: gd.lever };
          }
        }

        if (mode === 'sneak') {
          // move away from the last sighting toward the farthest unfinished gen
          const ref = obs.lastHunter ?? me;
          let far = null, fd = -1;
          for (let i = 0; i < gens.length; i++) {
            if (obs.gens[i].done || obs.gens[i].blocked) continue;
            const d = d2(gens[i], ref) - 0.3 * d2(gens[i], me);
            if (d > fd) { fd = d; far = gens[i]; }
          }
          if (far) {
            const fx = Math.floor(far.x), fz = Math.floor(far.z);
            if (rectDist(me.x, me.z, fx, fz, fx + 1, fz + 1) <= 1.0 && !holdProtection) return { act: 'repair', target: far.id };
            return { moveTo: far, walk };
          }
        }

        // ---- altruism: hooked teammates ----
        for (const tm of obs.teammates) {
          if (tm.state === 'hooked') { if (hookSpotted[tm.id] === undefined) hookSpotted[tm.id] = obs.t; }
          else delete hookSpotted[tm.id];
        }
        if (P.altruism > 0.25) {
          for (let j = 0; j < 4; j++) {
            const ls = obs.lastSeen[j];
            if (!ls || ls.state !== 'hooked' || obs.t - ls.t > 120 || ls.t <= dismissed[j]) continue;
            const first = hookSpotted[j] ?? ls.t;
            if (obs.t - first < P.rescueDelayS * (1.2 - P.altruism)) continue;
            let hk = null, bd = Infinity;
            for (const k of M.hooks) { const d = d2(k, ls); if (d < bd) { bd = d; hk = k; } }
            if (!hk) continue;
            if (h && d2(h, hk) < P.campAvoidDist) continue;
            const visibleNow = obs.teammates.some((t) => t.id === j && t.state === 'hooked');
            if (!visibleNow && d2(me, hk) < 3) { dismissed[j] = ls.t; continue; } // stale memory: they're gone
            if (d2(me, hk) <= 1.6 && !holdProtection) return { act: 'rescue', target: j };
            return { moveTo: hk };
          }
          // saw a carry -> go look at nearby hooks
          if (carrySeen && P.hookCheck > 0.3 && obs.t - carrySeen.t < 60 && obs.t - carrySeen.t > P.rescueDelayS * 0.5) {
            let hk = null, bd = Infinity;
            for (const k of M.hooks) {
              if (checkedHooks.has(k.id)) continue;
              const d = d2(k, carrySeen);
              if (d < bd && d < 25) { bd = d; hk = k; }
            }
            if (hk) {
              if (d2(me, hk) < 6) checkedHooks.add(hk.id);
              else return { moveTo: hk };
            } else { carrySeen = null; checkedHooks.clear(); }
          }
        }

        // ---- heal teammates ----
        if (me.state === 'healthy' && P.altruism > 0.15) {
          for (const tm of obs.teammates) {
            if ((tm.state === 'injured' || tm.state === 'downed') && d2(tm, me) < P.healDist) {
              if (d2(tm, me) <= 1.4 && !holdProtection) return { act: 'heal', target: tm.id };
              return { moveTo: { x: tm.x, z: tm.z } };
            }
          }
        }

        // ---- generators ----
        if (genTarget >= 0 && (obs.gens[genTarget].done || obs.gens[genTarget].blocked)) genTarget = -1;
        if (genTarget < 0 || obs.tick % 50 === 0) {
          let bs = Infinity, bi = genTarget;
          for (let i = 0; i < gens.length; i++) {
            const g = obs.gens[i];
            if (g.done || g.blocked) continue;
            let s = P.genDistW * nav.dist(me, gens[i]) / 20 - P.genProgW * g.progress * 3;
            if (g.workers && g.workers.length) s += P.spreadW * g.workers.length;
            if (obs.lastHunter && obs.t - obs.lastHunter.t < 60) s += P.hunterAvoidW * Math.max(0, 25 - d2(gens[i], obs.lastHunter)) / 10;
            if (i === genTarget) s -= 0.5; // hysteresis
            if (s < bs) { bs = s; bi = i; }
          }
          genTarget = bi;
        }
        if (genTarget >= 0) {
          const g = gens[genTarget];
          const gx = Math.floor(g.x), gz = Math.floor(g.z);
          if (rectDist(me.x, me.z, gx, gz, gx + 1, gz + 1) <= 1.0) return holdProtection ? {} : { act: 'repair', target: g.id };
          return { moveTo: g, walk };
        }
        return {};
      },
    };
  };
}
