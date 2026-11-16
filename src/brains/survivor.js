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
  downedStillDist: [0, 40, 12],  // downed: lie still (auto-recover to 95%) unless the hunter is seen within this; then crawl away
  seekHeal:      [0, 1, 0.4],    // >0.5: when injured, walk to a visible healthy teammate and stand still to be healed
  trustIntent:   [0, 1, 0.6],    // >0.5: skip a rescue if a teammate just said "going for unhook" (unless I'm right there)
  // ---- generator choice ----
  farFromHunterW: [0, 2, 0.5],   // prefer gens far from the hunter's last known position (linear up to 60 m)
  genJitter:     [0, 2, 0.3],    // per-survivor fixed random preference per gen (breaks the four-identical-bots symmetry)
  // ---- stealth: use line of sight ----
  hideDist:      [0, 75, 40],    // hunter seen within this, not chasing me, and it could see me -> slip out of its view
  hideSearchR:   [4, 20, 10],    // how far to look for a hiding spot (m)
  hideWalk:      [0, 1, 0.6],    // >0.5: walk (no scratch marks) while slipping out of view
  hideHoldS:     [0, 8, 2],      // once out of view, stay put this long while the hunter is still around
  // ---- chase: loop quality ----
  loopQualityW:  [0, 2, 0.2],    // anchor score = path distance - this * (hunter's walk-around detour, m): prefer strong loops
  avoidHeading:  [0, 1, 0.6],    // >0.5: skip anchors the hunter is heading toward (it would cut us off)
  weakPalletM:   [0, 20, 8],     // a pallet whose hunter detour is below this is "weak"...
  weakDropDist:  [1.5, 8, 4],    // ...and gets dropped as soon as the hunter is this close (no holding for a stun)
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

    // hunter walk-around detour per anchor: grid BFS from one side to the other with the anchor cell blocked (windows
    // and pallets elsewhere count as open for the hunter only if they're windows; pallets are assumed down = blocked).
    {
      const W = M.w, H = M.h, solid = new Uint8Array(W * H);
      const inPoly = (x, z) => { let c = false; const o = M.outline; for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const [xi, zi] = o[i], [xj, zj] = o[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!inPoly(i + 0.5, j + 0.5)) solid[j * W + i] = 1;
      for (const o of M.obstacles) for (let j = o.z; j < o.z + o.d; j++) for (let i = o.x; i < o.x + o.w; i++) if (i >= 0 && j >= 0 && i < W && j < H) solid[j * W + i] = 1;
      for (const g of [...(M.generatorCandidates || []), ...gens]) solid[Math.floor(g.z) * W + Math.floor(g.x)] = 1;
      for (const w of M.windows) solid[w.z * W + w.x] = 1;                  // walking around: windows don't count as a path
      for (const q of M.pallets) for (let j = q.z0 ?? q.z; j < (q.z1 ?? q.z + 1); j++) for (let i = q.x0 ?? q.x; i < (q.x1 ?? q.x + 1); i++) solid[j * W + i] = 1;
      const bfs = (a, b) => {
        const si = Math.floor(a.x), sj = Math.floor(a.z), ti = Math.floor(b.x), tj = Math.floor(b.z);
        if (si < 0 || sj < 0 || si >= W || sj >= H || solid[sj * W + si]) return 60;
        const dist = new Map([[sj * W + si, 0]]), q = [sj * W + si];
        for (let h = 0; h < q.length; h++) {
          const c = q[h], d = dist.get(c); if (d > 60) break;
          if (c === tj * W + ti) return d;
          const ci = c % W, cj = (c / W) | 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const n = nj * W + ni; if (solid[n] || dist.has(n)) continue; dist.set(n, d + 1); q.push(n); }
        }
        return 60;
      };
      for (const a of anchors) a.detour = Math.max(0, bfs(a.s[0], a.s[1]) - 3.2);
    }

    const jitter = gens.map(() => ctx.rng.next());   // this survivor's own taste per gen (own seeded stream)
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
    let unhookIntentT = -99;      // last time a teammate said "going for unhook"
    const sentUnhookFor = {};     // hooked teammate id -> hook time we announced for
    let helpSentT = -99, chaseSentT = -99;

    const anchorUsable = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] !== 'broken');
    const crossable = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] === 'dropped');
    const side = (a, pt) => (d2(a.s[0], pt) <= d2(a.s[1], pt) ? 0 : 1);

    // stealth: a spot near me the hunter can't see (cone + line of sight), cached ~1 s
    let hideSpot = null, hideT = -99, hiddenUntil = -99;
    function hunterCouldSee(api, h, pt) {
      const dx = pt.x - h.x, dz = pt.z - h.z, d = Math.hypot(dx, dz);
      if (d > 75) return false;
      const fx = Math.cos(h.facing), fz = Math.sin(h.facing);
      if (d > 1.5 && (dx * fx + dz * fz) < d * Math.cos((50 * Math.PI) / 180)) return false;   // outside its 100 deg cone
      return api.visibility(h, pt) >= 0.5;
    }
    function findHide(obs, api, me, h) {
      if (hideSpot && obs.t - hideT < 1 && !hunterCouldSee(api, h, hideSpot)) return hideSpot;
      hideT = obs.t; hideSpot = null;
      let best = null, bd = Infinity;
      for (let rr = 2; rr <= P.hideSearchR; rr += 2) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * 2 * Math.PI, pt = { x: me.x + Math.cos(a) * rr, z: me.z + Math.sin(a) * rr };
          if (hunterCouldSee(api, h, pt) || d2(pt, h) < d2(me, h) - 2) continue;   // hidden, and not toward the hunter
          const d = api.nav.dist(me, pt);
          if (d < bd) { bd = d; best = pt; }
        }
        if (best) break;
      }
      hideSpot = best;
      return best;
    }

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
          if (!(dm < P.loopRange && dm < P.loopRace * dh)) continue;
          // the hunter is heading for it: it would cut us off there
          if (h && P.avoidHeading > 0.5) { const tx = a.c.x - h.x, tz = a.c.z - h.z, tl = Math.hypot(tx, tz) || 1; if ((h.vx * tx + h.vz * tz) / tl > 2.5 && dh < d2(me, a.c) + 4) continue; }
          const sc = dm - P.loopQualityW * Math.min(30, a.detour);
          if (sc < bd) { bd = sc; best = a; }
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
          const dropAt = anchor.detour < P.weakPalletM ? Math.max(P.palletDropDist, P.weakDropDist) : P.palletDropDist;   // weak pallet: drop early
          if (near && hs !== ms && d2(hp, anchor.c) < dropAt) return { act: 'dropPallet', target: p.id };
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
        const cands = [...gens, ...M.hooks, ...anchors.filter((a) => anchorUsable(a, obs)).map((a) => ({ x: a.c.x, z: a.c.z, q: a.detour }))];
        for (const c of cands) {
          const s = d2(c, hp) - 0.6 * d2(c, me) + P.loopQualityW * Math.min(30, c.q ?? 0);
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
        // hooked brains are called now (minimal obs): take the Resolve self-unhook when offered (was automatic before)
        if (me.state === 'hooked') return me.canSelfUnhook ? { act: 'selfUnhook' } : {};
        if (me.state === 'carried') return { act: 'wiggle' };
        if (me.state === 'downed') {
          // crawl out through an open gate if one is close
          if (obs.gates) for (const g of obs.gates) {
            if (!g.open) continue;
            const gd = M.exitGates.find((x) => x.id === g.id);
            if (gd && nav.dist(me, gd.exit) < 30) return { moveTo: gd.exit };
          }
          // otherwise lie still to recover (to 95%) unless the hunter is close
          if (h && d2(h, me) < P.downedStillDist) return { moveDir: { x: me.x - h.x, z: me.z - h.z } };
          return {};
        }
        const canSay = !(me.intentCooldownS > 0);
        const say = (a, msg) => (canSay ? { ...a, intent: msg } : a);

        // ---- HUD bookkeeping ----
        const hud = obs.hud || null;
        const notes = obs.notifications || [];
        for (; notesRead < notes.length; notesRead++) {
          const n = notes[notesRead];
          if (n.type === 'hooked') hookedAt[n.who] = { hookId: n.hookId, x: n.x, z: n.z, t: n.t };
          else if (n.type === 'unhooked' || n.type === 'died') delete hookedAt[n.who];
          else if (n.type === 'intent' && n.intent === 'goingForUnhook') unhookIntentT = n.t;
        }
        if (hud) for (const k of Object.keys(hookedAt)) if (hud[k] && hud[k].state !== 'hooked') delete hookedAt[k];
        const otherChased = !!hud && hud.some((x) => x.id !== me.id && x.chased);

        // ---- threat state ----
        const dh = h ? d2(h, me) : Infinity;
        // a teammate is healing me: stand still (healing needs an idle patient) unless the hunter is close
        if (hud && hud[me.id] && hud[me.id].beingHealed && !(h && dh < 10)) return {};
        if (h && dh < P.fleeSeenDist) { mode = 'chase'; lastThreatT = obs.t; }
        else if (!h && obs.terror !== null && obs.terror.approx < P.fleeTR && !(otherChased && P.trustChase > 0.5) && !(mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS)) {
          if (mode !== 'chase' && mode !== 'sneak') { mode = 'sneak'; sneakStart = obs.t; }
          lastThreatT = obs.t;
        }
        else if (mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS) { mode = 'work'; anchor = null; }
        else if (obs.t - lastThreatT > P.calmS) { mode = 'work'; anchor = null; }

        // ---- stealth: the hunter is around but not on me -> get out of its view (and back to work once it's gone) ----
        if (mode !== 'chase' && h && dh < P.hideDist && !me.chased) {
          if (hunterCouldSee(api, h, me)) {
            const spot = findHide(obs, api, me, h);
            if (spot) { hiddenUntil = obs.t + P.hideHoldS; return { moveTo: spot, walk: P.hideWalk > 0.5 }; }
          } else if (obs.t < hiddenUntil) return {};          // out of view: hold still while the hunter passes
        }

        if (mode === 'chase') {
          const a = chase(obs, api, me, h);
          if (a) { if (me.chased && obs.t - chaseSentT > 30) { chaseSentT = obs.t; return say(a, 'chasingMe'); } return a; }
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
            // am I (roughly) the closest? teammates seen recently are near their last sighting; others unknown
            // (the HUD shows activity type only, not which generator)
            const myD = nav.dist(me, hk);
            let best = Infinity;
            if (hud) for (const x of hud) {
              if (x.id === me.id || x.id === j || x.state === 'dead' || x.state === 'escaped' || x.state === 'hooked' || x.state === 'carried' || x.state === 'downed') continue;
              const ls = obs.lastSeen[x.id];
              const est = ls && obs.t - ls.t < 15 ? d2(ls, hk) : P.unknownDist;
              if (est < best) best = est;
            }
            if (myD > best + P.rescueSlack) continue;
            const claimedByOther = P.trustIntent > 0.5 && obs.t - unhookIntentT < 20 && sentUnhookFor[j] !== hk.t && myD > 12;
            if (claimedByOther) continue;
            if (d2(me, hk) <= 1.6 && !holdProtection) return { act: 'rescue', target: j };
            if (sentUnhookFor[j] !== hk.t) { sentUnhookFor[j] = hk.t; return say({ moveTo: { x: hk.x, z: hk.z } }, 'goingForUnhook'); }
            return { moveTo: { x: hk.x, z: hk.z } };
          }
        }

        // ---- injured: go get healed by a visible healthy teammate ----
        if (me.state === 'injured' && P.seekHeal > 0.5 && !h) {
          const mate = obs.teammates.filter((t) => t.state === 'healthy').sort((a, b) => d2(a, me) - d2(b, me))[0];
          if (mate && d2(mate, me) < P.healDist) {
            if (d2(mate, me) <= 1.4) return obs.t - helpSentT > 20 ? (helpSentT = obs.t, say({}, 'help')) : {};
            return { moveTo: { x: mate.x, z: mate.z } };
          }
        }

        // ---- heal teammates ----
        if (me.state === 'healthy' && P.altruism > 0.15) {
          const cands = [...obs.teammates];
          for (const a of obs.downedAuras || []) if (!cands.some((t) => t.id === a.id)) cands.push({ id: a.id, x: a.x, z: a.z, state: 'downed' });
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
            const others = g.workers ? g.workers.filter((w) => w !== me.id).length : 0;   // only for gens currently seen
            s += P.spreadW * others;
            const hpos = h ?? (obs.lastHunter && obs.t - obs.lastHunter.t < 90 ? obs.lastHunter : null);
            if (hpos) s -= P.farFromHunterW * Math.min(60, d2(gens[i], hpos)) / 20;
            s += P.genJitter * jitter[i];
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
