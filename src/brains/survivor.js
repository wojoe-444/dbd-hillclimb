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
  healDist:      [0, 40, 15],    // heal visible injured/downed teammates within this
  genDistW:      [0, 2, 1],
  genProgW:      [0, 2, 1],
  spreadW:       [-1, 2, 0.5],   // per teammate already on a gen (HUD): >0 spread out, <0 group up
  hunterAvoidW:  [0, 2, 1],      // avoid gens near the last hunter sighting
  sneakMaxS:     [3, 60, 15],    // give up sneaking (go back to work despite terror) after this long
  protectHoldS:  [0, 10, 0],     // after unhook: hold off conspicuous actions (repair/heal/rescue/gate) for this many of the 10 protected seconds
  mendRiskDist:  [0, 40, 16],    // only mend Deep Wound if the hunter isn't seen within this
  holdMaxS:      [0, 20, 4],     // max time to hold at a loop anchor while the hunter isn't pressing us (seen + approaching)
  // ---- HUD-driven teamwork (solo queue: no comms, but the HUD shows states / gens / chases / hooks / downed auras) ----
  rescueSlack:   [0, 40, 10],    // go for a rescue if my distance <= the closest teammate's estimated distance + this
  unknownDist:   [10, 80, 40],   // assumed distance to a hook for a teammate whose whereabouts the HUD doesn't reveal
  rescueWhenChased: [0, 1, 0.6], // >0.5: skip the rescue delay while another survivor is being chased (hunter busy)
  trustChase:    [0, 1, 0.6],    // >0.5: don't abandon my gen on terror while another survivor is being chased
  healSeek:      [0, 1, 0.4],    // >0.5: go heal an injured teammate on a known gen (HUD) within healDist
};

import { makeSlotPicker } from '../sim/slotpick.js';

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
    const slots = makeSlotPicker(ctx.config.reach.repairSlot);   // generator side slots (one repairer per side)
    let fleePoint = null, fleeT = -99;
    let sneakStart = -1;
    let idleHoldT = 0;            // time spent holding at an anchor without being pressed
    const hookedAt = {};          // teammate id -> { hookId, x, z, t } from the HUD hook notifications
    let notesRead = 0;

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
          // hunter is mid-vault through our anchor: it's blocked for us; use the head start and run
          if (h && h.vaulting && d2(h, anchor.c) < 2.5) { anchor = null; return { moveDir: { x: me.x - h.x, z: me.z - h.z } }; }
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

        // ---- HUD bookkeeping ----
        const hud = obs.hud || null;
        const notes = obs.notifications || [];
        for (; notesRead < notes.length; notesRead++) {
          const n = notes[notesRead];
          if (n.type === 'hooked') hookedAt[n.who] = { hookId: n.hookId, x: n.x, z: n.z, t: n.t };
          else if (n.type === 'unhooked' || n.type === 'died') delete hookedAt[n.who];
        }
        if (hud) for (const k of Object.keys(hookedAt)) if (hud[k] && hud[k].state !== 'hooked') delete hookedAt[k];
        const otherChased = !!hud && hud.some((x) => x.id !== me.id && x.chased);
        const genPos = (id) => gens.find((g) => g.id === id);

        // ---- threat state ----
        const dh = h ? d2(h, me) : Infinity;
        if (h && dh < P.fleeSeenDist) { mode = 'chase'; lastThreatT = obs.t; }
        else if (!h && obs.terror !== null && obs.terror.approx < P.fleeTR && !(otherChased && P.trustChase > 0.5) && !(mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS)) {
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
          if (far) return slots.act(obs, gens.indexOf(far), far, { walk, hold: holdProtection });
        }

        // ---- altruism: rescue (the HUD announces every hook with its location) ----
        if (P.altruism > 0.25) {
          for (const k of Object.keys(hookedAt)) {
            const j = +k, hk = hookedAt[k];
            if (j === me.id) continue;
            const waited = obs.t - hk.t;
            const busy = otherChased && P.rescueWhenChased > 0.5;
            if (waited < P.rescueDelayS * (1.2 - P.altruism) && !busy) continue;
            if (h && d2(h, hk) < P.campAvoidDist) continue;
            // am I (roughly) the closest? teammates on a gen are "at" that gen; others unknown
            const myD = nav.dist(me, hk);
            let best = Infinity;
            if (hud) for (const x of hud) {
              if (x.id === me.id || x.id === j || x.state === 'dead' || x.state === 'escaped' || x.state === 'hooked' || x.state === 'carried' || x.state === 'downed') continue;
              const g = x.repairing ? genPos(x.repairing) : null;
              const ls = obs.lastSeen[x.id];
              const est = g ? d2(g, hk) : (ls && obs.t - ls.t < 15 ? d2(ls, hk) : P.unknownDist);
              if (est < best) best = est;
            }
            if (myD > best + P.rescueSlack) continue;
            if (d2(me, hk) <= 1.6 && !holdProtection) return { act: 'rescue', target: j };
            return { moveTo: { x: hk.x, z: hk.z } };
          }
        }

        // ---- heal teammates ----
        if (me.state === 'healthy' && P.altruism > 0.15) {
          const cands = [...obs.teammates];
          for (const a of obs.downedAuras || []) if (!cands.some((t) => t.id === a.id)) cands.push({ id: a.id, x: a.x, z: a.z, state: 'downed' });
          if (hud && P.healSeek > 0.5) for (const x of hud) {
            if (x.id === me.id || x.state !== 'injured' || !x.repairing || cands.some((t) => t.id === x.id)) continue;
            const g = genPos(x.repairing); if (g) cands.push({ id: x.id, x: g.x, z: g.z, state: 'injured' });
          }
          for (const tm of cands) {
            if (hud && hud[tm.id] && hud[tm.id].beingHealed && !(me.act === 'heal')) continue;   // someone's on it
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
            const others = hud ? hud.filter((x) => x.id !== me.id && x.repairing === g.id).length : (g.workers ? g.workers.filter((w) => w !== me.id).length : 0);
            s += P.spreadW * others;
            if (obs.lastHunter && obs.t - obs.lastHunter.t < 60) s += P.hunterAvoidW * Math.max(0, 25 - d2(gens[i], obs.lastHunter)) / 10;
            if (i === genTarget) s -= 0.5; // hysteresis
            if (s < bs) { bs = s; bi = i; }
          }
          genTarget = bi;
        }
        if (genTarget >= 0) {
          return slots.act(obs, genTarget, gens[genTarget], { walk, hold: holdProtection });
        }
        return {};
      },
    };
  };
}
