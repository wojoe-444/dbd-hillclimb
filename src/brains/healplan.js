// Heal / pick-up decisions for the parametric survivor, with a local healer <-> patient handshake.
// Solo-queue info only (HUD, intents heard, own sight, downed auras; see src/sim/README.md).
//
// The engine only heals an AVAILABLE patient (standing still, no interaction of its own). A patient only knows it is being
// healed once healing has started (HUD beingHealed), so without a handshake a healer stands next to a repairing teammate
// forever. Handshake (docs/research/survivor-weakness.md §5):
//   healer:  picks a VISIBLE patient (or a downed aura), says the existing wheel intent "healing" once it is within
//            healOfferS of run time (the intent carries no target / position), walks up and heals; gives up the
//            rendezvous if healing hasn't started healAbortS after arriving (that pair then cools down for COOL_S).
//   patient: injured, and a teammate it can SEE, that said "healing" recently, is within healAcceptDist and coming toward it
//            (or already adjacent) -> pause (stand still, drop its repair) for at most healAbortS; once healing starts the
//            HUD beingHealed rule keeps it still. Never for a gen at >= healGenKeep progress or under threat.
// Priorities: picking up a downed teammate (slug) weighs slugRecoveryPriority vs 1 for an optional injured -> healthy reset;
// injured survivors pick up slugs when slugRecoveryPriority > 0.5, and reset injured teammates only with mutualHeal > 0.5
// while the HUD shows nobody healthy standing (the everybody-injured deadlock). Optional resets yield to threat
// (resetThreatMargin) and to nearly finished generators (healGenKeep).

export const healSpace = {
  healOfferS:           [0, 10, 4],     // healer: say "healing" once within this many seconds of run time from the visible patient (0 = never: no handshake)
  healAcceptDist:       [0, 12, 6],     // patient: pause for a visible teammate that said "healing" and is approaching within this (m); 0 = never accept
  healAbortS:           [1, 15, 5],     // both: abandon a rendezvous where healing hasn't started this long after arriving / accepting
  slugRecoveryPriority: [0, 3, 1.5],    // weight of picking up a downed teammate vs an optional injured -> healthy heal (1); > 0.5: injured survivors pick up too
  mutualHeal:           [0, 1, 0.3],    // > 0.5: injured survivors heal injured teammates while the HUD shows no healthy teammate standing
  resetThreatMargin:    [0, 40, 16],    // no optional heal while the hunter (seen < 15 s ago, or the terror radius midpoint) is within this (m) of me / the patient; 0 = ignore
  healGenKeep:          [0, 1.01, 0.8], // don't leave / pause a generator for an optional heal once its progress is at least this (> 1 = always may)
};

const COOL_S = 20;           // pair cool-down after an abandoned rendezvous
const ARRIVE_M = 3;          // "arrived" for the abort clock
const MEMORY_S = 2;          // keep going for a chosen patient that briefly left my view (camera turned / occluded)
const STICK = 0.2;           // score hysteresis for the patient I'm already going for
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const approach = (t, me, r = 1.2) => { const dx = me.x - t.x, dz = me.z - t.z, L = Math.hypot(dx, dz) || 1; return { x: t.x + (dx / L) * r, z: t.z + (dz / L) * r }; };

export function makeHealPlanner(ctx, P, tracker) {
  const vRun = ctx.config.survivor.runSpeed ?? 4;
  let offer = null;          // healer side: { id, t0, near (time first within ARRIVE_M, or last heal tick), said }
  let accept = null;         // patient side: { from, t0 }
  const giveUp = [-1, -1, -1, -1];   // healer: no new offer to this teammate before this time
  const refuse = [-1, -1, -1, -1];   // patient: no new accept from this teammate before this time
  const stats = { offers: 0, said: 0, aborts: 0, accepts: 0, acceptAborts: 0, slugPicks: 0 };

  // hunter close to p (me or the patient): visible / sighting < 15 s within the margin, or the terror midpoint within it
  function threatened(obs, ps) {
    const R = P.resetThreatMargin;
    if (!(R > 0)) return false;
    const hp = obs.hunter ?? (obs.lastHunter && obs.t - obs.lastHunter.t < 15 ? obs.lastHunter : null);
    if (hp && ps.some((p) => d2(hp, p) < R)) return true;
    return obs.terror !== null && obs.terror !== undefined && obs.terror.approx < R;
  }
  // progress of the generator I'm repairing (own HUD entry), else -1
  const myGenProg = (obs) => {
    const e = obs.hud && obs.hud[obs.self.id];
    return obs.self.act === 'repair' && e && e.activity === 'repair' ? (e.activityProgress ?? 0) : -1;
  };

  // healer: an action, or null (nothing worth healing / gave up)
  function healer(obs, opts) {
    const me = obs.self, hud = obs.hud || null, t = obs.t;
    if (me.state !== 'healthy' && me.state !== 'injured') return null;
    const injured = me.state === 'injured';
    const slugOk = !injured || P.slugRecoveryPriority > 0.5;
    const resetOk = !injured || (P.mutualHeal > 0.5 && !!hud && !hud.some((x) => x.id !== me.id && x.state === 'healthy'));
    if (!slugOk && !resetOk) { offer = null; return null; }
    const genKeep = myGenProg(obs) >= P.healGenKeep;
    const cands = [];
    for (const tm of obs.teammates) cands.push({ id: tm.id, x: tm.x, z: tm.z, state: tm.state, seen: true });
    for (const a of obs.downedAuras || []) if (!cands.some((c) => c.id === a.id)) cands.push({ id: a.id, x: a.x, z: a.z, state: 'downed', seen: false });
    if (offer && !cands.some((c) => c.id === offer.id) && t - offer.seenT <= MEMORY_S && hud && hud[offer.id] && hud[offer.id].state === offer.state)
      cands.push({ id: offer.id, x: offer.lx, z: offer.lz, state: offer.state, seen: true });   // where I last saw it
    let best = null, bs = -Infinity;
    for (const c of cands) {
      if (c.state !== 'injured' && c.state !== 'downed') continue;
      const d = d2(c, me);
      if (d >= opts.healDist) continue;
      const e = hud && hud[c.id];
      if (t < giveUp[c.id] && !(offer && offer.id === c.id)) continue;
      if (e && e.deepWound !== null && e.deepWound !== undefined) continue;          // must mend first
      if (e && e.beingHealed && me.act !== 'heal') continue;                          // someone's on it
      let w;
      if (c.state === 'downed') { if (!slugOk) continue; w = P.slugRecoveryPriority; }
      else {
        if (!resetOk || !c.seen || genKeep) continue;
        if (e && e.activity === 'repair' && (e.activityProgress ?? 0) >= P.healGenKeep) continue;   // it won't stop for me
        if (threatened(obs, [me, c])) continue;
        w = 1;
      }
      const s = w - d / Math.max(1, opts.healDist) + (offer && offer.id === c.id ? STICK : 0);
      if (s > bs) { bs = s; best = c; }
    }
    if (!best) { offer = null; return null; }
    if (!offer || offer.id !== best.id) { offer = { id: best.id, t0: t, near: null, said: false, lx: best.x, lz: best.z, seenT: t, state: best.state }; stats.offers++; if (best.state === 'downed') stats.slugPicks++; }
    if (obs.teammates.some((m) => m.id === best.id) || best.state === 'downed') { offer.lx = best.x; offer.lz = best.z; offer.seenT = t; }
    const d = d2(best, me);
    // abort clock: from arrival (or the last tick I actually healed)
    if (me.act === 'heal') offer.near = t;
    else if (d <= ARRIVE_M && offer.near === null) offer.near = t;
    const stale = offer.near !== null ? t - offer.near > P.healAbortS : t - offer.t0 > P.healAbortS + opts.healDist / vRun + 5;
    if (stale && me.act !== 'heal') { giveUp[best.id] = t + COOL_S; stats.aborts++; offer = null; return null; }
    let a;
    if (d <= 1.5) a = opts.holdProtection ? {} : { act: 'heal', target: best.id };
    else a = { moveTo: approach(best, me) };
    // announce on the wheel (no target / position) when close; downed patients lie still anyway
    if (best.state === 'injured' && !offer.said && P.healOfferS > 0 && d <= P.healOfferS * vRun) {
      const s = opts.say(a, 'healing');
      if (s.intent) { offer.said = true; stats.said++; }
      return s;
    }
    return a;
  }

  // patient: {} (stand still to be healed), or null
  function patient(obs) {
    const me = obs.self, hud = obs.hud || null, t = obs.t;
    if (me.state !== 'injured' || !(P.healAcceptDist > 0) || !hud) { accept = null; return null; }
    const mine = hud[me.id];
    if (mine && mine.deepWound !== null && mine.deepWound !== undefined) { accept = null; return null; }
    if (accept) {
      const tm = obs.teammates.find((x) => x.id === accept.from);
      const gone = hud[accept.from] && hud[accept.from].state !== 'healthy' && hud[accept.from].state !== 'injured';
      if (gone || t - accept.t0 > P.healAbortS) { refuse[accept.from] = t + COOL_S; stats.acceptAborts++; accept = null; return null; }
      return tm ? { look: { x: tm.x, z: tm.z } } : {};
    }
    if (myGenProg(obs) >= P.healGenKeep) return null;
    const win = P.healOfferS + P.healAbortS + 1;
    for (const tm of obs.teammates) {
      if (tm.state !== 'healthy' && tm.state !== 'injured') continue;
      if (t < refuse[tm.id]) continue;
      const it = tracker.intent[tm.id];
      if (!it || it.intent !== 'healing' || t - it.t > win) continue;
      const d = d2(tm, me);
      if (d > P.healAcceptDist) continue;
      const v = Math.hypot(tm.vx || 0, tm.vz || 0);
      const coming = d <= 2.5 || (v > 0.5 && ((me.x - tm.x) * tm.vx + (me.z - tm.z) * tm.vz) > 0.7 * v * d);
      if (!coming) continue;
      if (threatened(obs, [me, tm])) continue;
      accept = { from: tm.id, t0: t }; stats.accepts++;
      return { look: { x: tm.x, z: tm.z } };
    }
    return null;
  }

  // every decision tick: an accepted heal that is actually progressing keeps the patient's rendezvous alive
  function update(obs) {
    const e = obs.hud && obs.hud[obs.self.id];
    if (accept && e && e.beingHealed) accept.t0 = obs.t;
  }

  return { update, healer, patient, stats, get offer() { return offer; }, get accept() { return accept; } };
}
