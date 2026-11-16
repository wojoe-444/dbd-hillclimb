// Rescue decision for the parametric survivor: go for a hooked teammate when a utility score beats a threshold.
// Solo-queue info only (HUD, hook notifications, intents, own sight, own hunter belief; see src/sim/README.md).
//
// score = closest   rescueClosestW  x (2 P(I'm the closest) - 1)       P from my path distance vs each standing,
//                                                                       un-chased teammate's estimated path distance
//                                                                       (matetrack.js: fix + growing uncertainty)
//       + urgency   rescueStageGo   x u x (2 in struggle)               u = how much of the stage is gone by the time
//                                                                       I'd arrive (0..1); a struggle hook I can't reach
//                                                                       in time is skipped
//       - camping   rescueCampFear  x P(hunter within 16 m of the hook)  visible / recent sighting, the hooked mate's
//                                                                       Resolve rising (= hunter within 16 m), else my
//                                                                       belief map (or a decay since the hook), terror
//       + busy      rescueBusyBonus                                       another teammate HUD-chased or being carried
//       - claims    rescueClaimDefer x w                                  a teammate said "going for unhook" first (w 1,
//                                                                       0.5 if several are hooked), or is unhooking now
//                                                                       (HUD 'rescue': w 2)
//       - own risk  rescueSelfRiskW x (injured 0.5 + Deep Wound 1 + belief threat along the way + terror layer / 3)
//       + 0.75 while I'm already going (hysteresis), + 0.5 within 8 m of the hook
// go if score > rescueThreshold.
import { MateTracker } from './matetrack.js';

export const rescueSpace = {
  rescueClosestW:   [0, 4, 2],      // weight of "I'm the closest" (2 P(closest) - 1)
  rescueStageGo:    [0, 4, 1.5],    // weight of hook-stage urgency (share of the stage gone on arrival; x2 in struggle)
  rescueCampFear:   [0, 4, 2],      // penalty x P(the hunter is camping within 16 m of the hook)
  rescueBusyBonus:  [0, 3, 1],      // bonus while the hunter is busy (another teammate chased / carried)
  rescueClaimDefer: [0, 4, 2],      // penalty when a teammate claimed the rescue first ("going for unhook" / HUD rescuing)
  rescueSelfRiskW:  [0, 3, 0.5],    // penalty x own risk (injured, Deep Wound, threat along the route, terror)
  rescueThreshold:  [-3, 3, 0],     // go when the score beats this
  mateSpread:       [0.2, 1.2, 0.6],// teammate whereabouts: uncertainty radius growth as a share of run speed once the trail is cold
  chaseFromHookW:   [-1, 1, 0],     // chased / fleeing: >0 prefer routes / loops / hide spots away from the nearest hooked teammate's hook, <0 toward it
};

const sig = (x) => 1 / (1 + Math.exp(-1.702 * x));   // ~ normal CDF
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function makeRescuePlanner(ctx, P, belief) {
  const tracker = new MateTracker(ctx, { spread: P.mateSpread });
  const HK = ctx.config.hooks || {}, stageS = HK.stageS ?? 70, deathStage = HK.deathStage ?? 3;
  const vRun = ctx.config.survivor.runSpeed ?? 4;
  const hooked = {};        // victim -> { x, z, t, stage, stageT, resolve, resolveUpT }
  let notesRead = 0, going = -1;
  const mySent = {};        // victim -> { hookT, t }: when I said "going for unhook" for that hooking
  let evalT = -99, evalKey = '', evalBest = null;   // utility re-evaluated at 2 Hz (it moves slowly)
  const stats = { evals: 0, goes: 0 };

  function update(obs) {
    tracker.update(obs);
    const notes = obs.notifications || [];
    for (; notesRead < notes.length; notesRead++) {
      const n = notes[notesRead];
      if (n.type === 'hooked') hooked[n.who] = { x: n.x, z: n.z, t: n.t, stage: 0, stageT: n.t, resolve: 0, resolveUpT: -99 };
      else if (n.type === 'unhooked' || n.type === 'died') delete hooked[n.who];
    }
    const hud = obs.hud;
    if (!hud) return;
    for (const k of Object.keys(hooked)) {
      const v = hud[k], hk = hooked[k];
      if (!v || v.state !== 'hooked') { delete hooked[k]; continue; }
      if (v.hookStage !== hk.stage) { if (hk.stage) hk.stageT = obs.t; hk.stage = v.hookStage; }   // struggle: the stage timer restarts
      if ((v.resolve ?? 0) > hk.resolve + 1e-6) hk.resolveUpT = obs.t;                            // Resolve fills only with the hunter within 16 m
      hk.resolve = v.resolve ?? 0;
    }
  }

  // nearest hooked teammate's hook (for the chase route bias), or null
  function nearestHook(me) {
    let best = null, bd = Infinity;
    for (const k of Object.keys(hooked)) { const hk = hooked[k], d = d2(me, hk); if (d < bd) { bd = d; best = hk; } }
    return best;
  }
  // route-bias term: chaseFromHookW x 10 x normalised distance gain (pt farther from the hook than I am now: +)
  function fromHookTerm(me, hk, pt) {
    if (!hk || P.chaseFromHookW === 0) return 0;
    const g = (d2(pt, hk) - d2(me, hk)) / 20;
    return P.chaseFromHookW * 10 * Math.max(-1, Math.min(1, g));
  }

  function campP(obs, hk, myD, beliefFull) {
    const h = obs.hunter, t = obs.t;
    let p;
    const near = (d) => (d < 12 ? 1 : d < 24 ? (24 - d) / 12 : 0);
    if (h) p = near(d2(h, hk));
    else {
      const lh = obs.lastHunter;
      if (lh && t - lh.t < 6) p = near(Math.max(0, d2(lh, hk) - 4.6 * (t - lh.t)));
      else if (beliefFull) p = belief.pHunterWithin(hk, 16);
      else p = Math.exp(-(t - hk.t) / 20);
      // heard terror while I'm near the hook: the hunter is near me, so near the hook
      if (obs.terror && myD < 24) p = Math.max(p, (obs.terror.layer / 3) * (myD < 12 ? 1 : 0.6));
    }
    if (t - hk.resolveUpT < 3) p = Math.max(p, 0.9);
    return Math.min(1, p);
  }

  // returns an action or null. opts: { holdProtection, say(action, msg), beliefFull }
  function decide(obs, api, opts) {
    const keys = Object.keys(hooked);
    if (!keys.length) { going = -1; return null; }
    const me = obs.self, hud = obs.hud, t = obs.t, nav = api.nav;
    const key = keys.join(',') + me.state;
    if (t - evalT >= 0.5 || key !== evalKey || (evalBest && !hooked[evalBest.j])) { evalT = t; evalKey = key; evalBest = evaluate(obs, api, opts, keys); }
    if (!evalBest) { going = -1; return null; }
    const { j, hk } = evalBest;
    if (going !== j) stats.goes++;
    going = j;
    if (d2(me, hk) <= 1.6 && !opts.holdProtection) return { act: 'rescue', target: j };
    const mv = { moveTo: { x: hk.x, z: hk.z } };
    if (!mySent[j] || mySent[j].hookT !== hk.t) { const a = opts.say(mv, 'goingForUnhook'); if (a.intent) mySent[j] = { hookT: hk.t, t }; return a; }
    return mv;
  }

  function evaluate(obs, api, opts, keys) {
    const me = obs.self, hud = obs.hud, t = obs.t, nav = api.nav;
    const busy = !!hud && hud.some((x) => x.id !== me.id && !hooked[x.id] && (x.chased || x.state === 'carried'));
    const risk = (me.state === 'injured' ? 0.5 : 0) + (me.deepWoundS != null ? 1 : 0) + (obs.terror ? obs.terror.layer / 3 : 0);
    let best = null, bs = -Infinity;
    for (const k of keys) {
      const j = +k, hk = hooked[k];
      if (j === me.id) continue;
      stats.evals++;
      const myD = nav.dist(me, hk);
      if (!isFinite(myD)) continue;
      const travel = myD / vRun;
      const remaining = stageS - (t - hk.stageT);
      const struggle = (hud && hud[j] ? hud[j].hookStage : hk.stage) >= deathStage - 1;
      if (struggle && travel > remaining + 0.5) continue;                 // can't make it in time
      // P(I'm the closest): each standing, un-chased teammate's estimated path distance vs mine
      let pClosest = 1;
      if (hud) for (const x of hud) {
        if (x.id === me.id || x.id === j || x.chased || (x.state !== 'healthy' && x.state !== 'injured')) continue;
        const e = tracker.pathTo(x.id, hk, t);
        pClosest *= 1 - sig((myD - e.d) / (0.4 * e.r + 3));
      }
      const u = Math.max(0, Math.min(1, 1 - remaining / stageS));   // share of the stage gone (not of my travel: that would send the far ones first)
      // claims: an earlier "going for unhook" (after this hook; not after my own claim), or a teammate unhooking right now
      let claim = 0;
      const mine = mySent[j] && mySent[j].hookT === hk.t ? mySent[j].t : Infinity;
      if (hud) for (const x of hud) {
        if (x.id === me.id || x.id === j || x.state === 'downed' || x.state === 'hooked' || x.state === 'dead') continue;
        if (x.activity === 'rescue' && keys.length === 1 && myD > 3) claim = Math.max(claim, 2);
        else if (!x.chased && tracker.claimedUnhook(x.id, hk.t, t) && tracker.intent[x.id].t < mine) claim = Math.max(claim, keys.length > 1 ? 0.5 : 1);
      }
      let rk = risk;
      if (opts.beliefFull) rk += belief.threatAt({ x: (me.x + hk.x) / 2, z: (me.z + hk.z) / 2 }, 12);
      const camp = campP(obs, hk, myD, opts.beliefFull);
      let s = P.rescueClosestW * (2 * pClosest - 1)
        + P.rescueStageGo * u * (struggle ? 2 : 1)
        - P.rescueCampFear * camp
        + (busy ? P.rescueBusyBonus : 0)
        - P.rescueClaimDefer * claim * (myD > 8 ? 1 : 0.3)
        - P.rescueSelfRiskW * rk;
      if (going === j) s += 0.75;
      if (myD < 8) s += 0.5;
      stats.last = { j, myD, pClosest, u, camp, claim, rk, s, t };
      if (s > P.rescueThreshold && s > bs) { bs = s; best = { j, hk }; }
    }
    return best;
  }

  return { update, decide, nearestHook, fromHookTerm, tracker, stats, hooked };
}
