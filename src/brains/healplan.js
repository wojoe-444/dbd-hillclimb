// Heal / pick-up decisions for the parametric survivor, with a local healer <-> patient handshake and the solo-queue
// "let go vs keep repairing" signal. Solo-queue info only (HUD, intents heard, own sight, downed auras; src/sim/README.md).
//
// The engine only heals an AVAILABLE patient (standing still, no interaction of its own), and a patient only learns it is
// being healed once healing has started (HUD beingHealed). So healing needs an implicit agreement (survivor-weakness.md §5):
//
//   healer  picks a VISIBLE patient (or a downed aura) and walks over; says the wheel intent "healing" once within
//           healOfferS of run time (the intent carries no target / position).
//           Arriving next to a patient that is REPAIRING it does not spam a heal: it stands by for up to readSignalS and
//           reads the patient's answer:
//             - the patient LETS GO of the gen  -> "heal me": heal it;
//             - it KEEPS REPAIRING              -> "join me": take a free slot on that gen and repair with it. When the
//               gen pops (or the patient stops repairing) heal it afterwards if healAfterGenW > 0.5, else leave it be.
//           A rendezvous where healing hasn't started healAbortS after the answer / arrival is abandoned (pair cool-down).
//   patient injured and repairing, a visible standing teammate comes next to me (within SIGNAL_M, not passing by) and
//           isn't repairing itself: decide ONCE per arrival
//             let go  iff  letGoW - letGoProgW * genProgress + letGoThreatW * threat - (teammate injured ? 0.5 : 0) > 0
//           (threat = how close the heard terror radius is, 0..1; with the hunter within resetThreatMargin I keep
//           repairing unless letGoThreatW > 0). Let go = stand still for up to healAbortS (refreshed while actually being
//           healed; dropped at once if the teammate starts repairing instead). Keep = carry on repairing; that teammate
//           isn't re-read for KEEP_S.
//           Injured and NOT repairing: pause for a visible teammate that said "healing" within healAcceptDist and is
//           coming toward me (the explicit handshake).
//   mutual  both injured: the survivor who arrives is the healer and the one on the gen is the patient (it signals);
//           an injured survivor never leaves a gen it is repairing to heal someone (only arrivals carry the signal).
//           Neither on a gen and both offered: whoever said "healing" first heals, the other stands still (tie: lower id heals).
//
// Whom to heal: score = w - d / healDist (must be > 0 for optional heals) + 0.2 for the one I'm already going for;
// w = slugRecoveryPriority for a downed teammate (urgent; injured healers too when > 0.5; ignores threat and the > 0 bar),
// 1 for an optional injured -> healthy heal by a healthy survivor, injuredHealW by an injured one (+0.5 for a patient whose
// gen I joined). Optional heals yield to threat (resetThreatMargin) and to gens at >= healGenKeep progress.

export const healSpace = {
  healOfferS:           [0, 10, 4],     // healer: say "healing" once within this many seconds of run time from the visible patient (0 = never)
  healAcceptDist:       [0, 12, 6],     // patient (not repairing): pause for a visible teammate that said "healing" and is approaching within this (m); 0 = never
  healAbortS:           [1, 15, 5],     // both: abandon a rendezvous where healing hasn't started this long after the answer / accepting
  slugRecoveryPriority: [0, 3, 1.5],    // weight of picking up a downed teammate vs an optional heal (1); > 0.5: injured survivors pick up too
  injuredHealW:         [0, 2, 0.5],    // injured survivor's willingness to heal an injured teammate (1 = like a healthy one, 0 = never): heals within injuredHealW x healDist
  resetThreatMargin:    [0, 40, 16],    // no optional heal while the hunter (seen < 15 s ago, or the terror radius midpoint) is within this (m) of me / the patient; 0 = ignore
  healGenKeep:          [0, 1.01, 0.8], // don't leave / pause a generator for an optional heal once its progress is at least this (> 1 = always may)
  // ---- the let-go signal (patient: injured, repairing, a teammate comes up to me) ----
  letGoW:               [-2, 2, 0.5],   // base inclination to let go of the gen (= "heal me") rather than keep repairing (= "join me")
  letGoProgW:           [0, 4, 1.5],    // ... minus this x my gen's progress (a nearly done gen: keep repairing)
  letGoThreatW:         [-2, 2, -0.5],  // ... plus this x threat (terror radius closeness 0..1): < 0 keep working under threat, > 0 get healed first
  readSignalS:          [0.5, 6, 2],    // healer: stand by this long next to a repairing patient for its answer before joining its gen
  healAfterGenW:        [0, 1, 0.7],    // healer who joined: > 0.5 = heal the patient once the gen pops / it stops repairing
};

const COOL_S = 20;           // pair cool-down after an abandoned rendezvous
const ARRIVE_M = 3;          // "arrived" for the abort clock
const SIGNAL_M = 2.5;        // patient: a teammate this close "came up to me"
const KEEP_S = 30;           // patient: after "keep repairing", don't re-read the same teammate for this long
const AFTER_S = 40;          // healer: a joined patient stays my heal-after candidate this long
const MEMORY_S = 2;          // keep going for a chosen patient that briefly left my view (camera turned / occluded)
const STICK = 0.2;           // score hysteresis for the patient I'm already going for
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const approach = (t, me, r = 1.2) => { const dx = me.x - t.x, dz = me.z - t.z, L = Math.hypot(dx, dz) || 1; return { x: t.x + (dx / L) * r, z: t.z + (dz / L) * r }; };
const NEXT = { injured: 'healthy', downed: 'injured' };

export function makeHealPlanner(ctx, P, tracker) {
  const vRun = ctx.config.survivor.runSpeed ?? 4;
  // healer side: { id, t0, near, said, lx, lz, seenT, state, phase: 'go'|'read'|'join'|'heal', arriveT, gi, how, healing }
  let offer = null;
  let accept = null;         // patient side: { from, t0 }
  const giveUp = [-1, -1, -1, -1];   // healer: no new offer to this teammate before this time
  const refuse = [-1, -1, -1, -1];   // patient: no new accept from this teammate before this time
  const kept = [-1e9, -1e9, -1e9, -1e9];   // patient: kept repairing when this teammate came up (time)
  const after = [-1, -1, -1, -1];    // healer: joined this teammate's gen; heal-after candidate until this time
  const stats = {
    offers: 0, said: 0, aborts: 0, accepts: 0, acceptAborts: 0, acceptLeft: 0, slugPicks: 0,
    arrivals: 0,       // healer came up (within ARRIVE_M) to a REPAIRING patient (signal episodes)
    readLetGo: 0,      // ... it let go as I came up / within readSignalS -> heal
    readKept: 0,       // ... it kept repairing -> join its gen
    joinNoGen: 0,      // ... kept, but I couldn't make out the gen to join (gave up)
    healedDirect: 0, healedLetGo: 0, healedAfterGen: 0,   // heals I completed, by how the rendezvous went
    sigLetGo: 0, sigKeep: 0, sigJoined: 0,                // patient: answers when a teammate came up to my gen (+ it then joined instead)
  };

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
  // the known, unfinished generator next to p (the one it is visibly working)
  const genAt = (obs, p) => {
    let bi = -1, bd = 2.6;
    for (let i = 0; i < obs.gens.length; i++) { const g = obs.gens[i]; if (!g.known || g.done || !g.slots) continue; const d = d2(g, p); if (d < bd) { bd = d; bi = i; } }
    return bi;
  };

  // every decision tick, before any branch decides
  function update(obs) {
    const hud = obs.hud;
    if (!hud) return;
    const e = hud[obs.self.id];
    if (accept && e && e.beingHealed) accept.t0 = obs.t;
    if (offer && obs.self.act === 'heal') offer.healing = true;
    // a heal I was on completed: injured -> healthy / downed -> injured
    if (offer && offer.healing && hud[offer.id] && hud[offer.id].state === NEXT[offer.state]) {
      if (offer.how === 'letGo') stats.healedLetGo++; else if (offer.how === 'afterGen') stats.healedAfterGen++; else stats.healedDirect++;
      after[offer.id] = -1; offer = null;
    }
  }

  // healer: an action, or null (nothing worth healing / gave up). opts: { healDist, holdProtection, say, joinGen(gi) -> action }
  function healer(obs, opts) {
    const me = obs.self, hud = obs.hud || null, t = obs.t;
    if (me.state !== 'healthy' && me.state !== 'injured') return null;
    if (offer && t - offer.lastT > 1.5) offer = null;   // another branch (chase, rescue, hiding ...) took over meanwhile: start over
    const injured = me.state === 'injured';
    const joining = !!offer && offer.phase === 'join';
    const slugOk = !injured || P.slugRecoveryPriority > 0.5;
    const wOpt = injured ? P.injuredHealW : 1;
    const resetOk = wOpt > 0 && !(injured && me.act === 'repair' && !joining);
    if (!slugOk && !resetOk) { offer = null; return null; }
    const genKeep = myGenProg(obs) >= P.healGenKeep && !joining;
    const cands = [];
    for (const tm of obs.teammates) cands.push({ id: tm.id, x: tm.x, z: tm.z, state: tm.state, seen: true });
    for (const a of obs.downedAuras || []) if (!cands.some((c) => c.id === a.id)) cands.push({ id: a.id, x: a.x, z: a.z, state: 'downed', seen: false });
    if (offer && !cands.some((c) => c.id === offer.id) && t - offer.seenT <= MEMORY_S && hud && hud[offer.id] && hud[offer.id].state === offer.state)
      cands.push({ id: offer.id, x: offer.lx, z: offer.lz, state: offer.state, seen: true });   // where I last saw it
    let best = null, bs = -Infinity;
    for (const c of cands) {
      if (c.state !== 'injured' && c.state !== 'downed') continue;
      const mineNow = !!offer && offer.id === c.id;
      const d = d2(c, me);
      if (d >= opts.healDist && !mineNow) continue;
      const e = hud && hud[c.id];
      if (t < giveUp[c.id] && !mineNow) continue;
      if (e && e.deepWound !== null && e.deepWound !== undefined) continue;          // must mend first
      if (e && e.beingHealed && me.act !== 'heal') continue;                          // someone's on it
      let w;
      if (c.state === 'downed') { if (!slugOk) continue; w = P.slugRecoveryPriority; }
      else {
        if (!resetOk || !c.seen || genKeep) continue;
        const joinedIt = mineNow && joining;
        if (!joinedIt) {
          if (e && e.activity === 'repair' && (e.activityProgress ?? 0) >= P.healGenKeep) continue;   // it won't stop for me
          if (threatened(obs, [me, c])) continue;
          if (!mineNow && t < after[c.id] && e && e.activity === 'repair') continue;   // said "join me": wait until it stops
        }
        w = wOpt + (t < after[c.id] ? 0.5 : 0);
      }
      const s = w - d / Math.max(1, opts.healDist) + (mineNow ? STICK : 0);
      if (c.state !== 'downed' && s <= 0) continue;
      if (s > bs) { bs = s; best = c; }
    }
    if (!best || (offer && offer.id !== best.id && joining)) { offer = null; if (!best) return null; }
    if (!offer || offer.id !== best.id) {
      offer = { id: best.id, t0: t, near: null, said: false, lx: best.x, lz: best.z, seenT: t, state: best.state, phase: 'go', arriveT: -1, gi: -1,
        how: t < after[best.id] ? 'afterGen' : 'direct', healing: false };
      stats.offers++; if (best.state === 'downed') stats.slugPicks++;
    }
    offer.lastT = t;
    if (obs.teammates.some((m) => m.id === best.id) || best.state === 'downed') { offer.lx = best.x; offer.lz = best.z; offer.seenT = t; }
    const d = d2(best, me);
    const pe = hud && hud[best.id];
    const patientRepairs = best.state === 'injured' && !!pe && pe.activity === 'repair';

    // ---- joined the patient's gen: repair with it; afterwards heal it (healAfterGenW) or let it be ----
    if (offer.phase === 'join') {
      const g = obs.gens[offer.gi];
      if (g && !g.done && patientRepairs) return opts.joinGen(offer.gi);
      if (P.healAfterGenW > 0.5) { after[best.id] = t + AFTER_S; offer.phase = 'go'; offer.how = 'afterGen'; offer.sig = false; offer.near = null; offer.t0 = t; offer.said = false; }
      else { giveUp[best.id] = t + COOL_S; offer = null; return null; }
    }

    // ---- reading the answer: next to a patient that was repairing when I arrived ----
    if (offer.phase === 'read') {
      if (!patientRepairs) { offer.phase = 'heal'; offer.how = 'letGo'; offer.near = t; stats.readLetGo++; }
      else if (t - offer.arriveT >= P.readSignalS) {
        stats.readKept++;
        const gi = genAt(obs, best);
        if (gi < 0) { stats.joinNoGen++; giveUp[best.id] = t + COOL_S; offer = null; return null; }
        offer.phase = 'join'; offer.gi = gi; after[best.id] = t + AFTER_S;
        return opts.joinGen(gi);
      } else return { look: { x: best.x, z: best.z } };   // standing by: no heal request while it's still on the gen
    }

    // abort clock: from arrival / the answer (or the last tick I actually healed)
    if (me.act === 'heal') offer.near = t;
    else if (d <= ARRIVE_M && offer.near === null) offer.near = t;
    // signal episode: the patient was on its gen when I came up (within ARRIVE_M); letting go now = "heal me"
    if (offer.phase === 'go' && best.state === 'injured' && d <= ARRIVE_M) {
      if (patientRepairs && !offer.sig && offer.how !== 'afterGen') { offer.sig = true; stats.arrivals++; }
      else if (!patientRepairs && offer.sig) { offer.sig = false; offer.phase = 'heal'; offer.how = 'letGo'; offer.near = t; stats.readLetGo++; }
    }
    const stale = offer.near !== null ? t - offer.near > P.healAbortS : t - offer.t0 > P.healAbortS + opts.healDist / vRun + 5;
    if (stale && me.act !== 'heal') { giveUp[best.id] = t + COOL_S; stats.aborts++; offer = null; return null; }
    let a;
    if (d <= 1.5) {
      if (patientRepairs && offer.phase === 'go') { offer.phase = 'read'; offer.arriveT = t; return { look: { x: best.x, z: best.z } }; }
      if (offer.phase === 'go') offer.phase = 'heal';
      a = opts.holdProtection ? {} : { act: 'heal', target: best.id };
    } else a = { moveTo: approach(best, me) };
    // announce on the wheel (no target / position) when close; downed patients lie still anyway
    if (best.state === 'injured' && !offer.said && P.healOfferS > 0 && d <= P.healOfferS * vRun) {
      const s = opts.say(a, 'healing');
      if (s.intent) { offer.said = true; offer.saidT = t; stats.said++; }
      return s;
    }
    return a;
  }

  // patient: an action to stand still and be healed, or null (carry on)
  function patient(obs) {
    const me = obs.self, hud = obs.hud || null, t = obs.t;
    if (me.state !== 'injured' || !hud) { accept = null; return null; }
    const mine = hud[me.id];
    if (mine && mine.deepWound !== null && mine.deepWound !== undefined) { accept = null; return null; }
    if (accept) {
      const tm = obs.teammates.find((x) => x.id === accept.from), te = hud[accept.from];
      const gone = te && te.state !== 'healthy' && te.state !== 'injured';
      if (te && te.activity === 'repair' && !(mine && mine.beingHealed)) { kept[accept.from] = t; stats.sigJoined++; accept = null; return null; }   // it chose to repair, not heal
      // the teammate visibly walks off (it dropped the plan) or is out of sight beyond acceptance range: stop waiting
      const dt = tm ? d2(tm, me) : Infinity, vt = tm ? Math.hypot(tm.vx || 0, tm.vz || 0) : 0;
      const leaving = tm ? dt > SIGNAL_M && vt > 0.5 && (me.x - tm.x) * tm.vx + (me.z - tm.z) * tm.vz < 0 : t - accept.t0 > 3;
      if (gone || leaving || t - accept.t0 > P.healAbortS) { refuse[accept.from] = t + (leaving ? COOL_S / 2 : COOL_S); stats.acceptAborts++; if (leaving) stats.acceptLeft++; accept = null; return null; }
      return tm ? { look: { x: tm.x, z: tm.z } } : {};
    }
    const prog = myGenProg(obs);
    const repairing = prog >= 0;
    const win = P.healOfferS + P.healAbortS + 1;
    for (const tm of obs.teammates) {
      if (tm.state !== 'healthy' && tm.state !== 'injured') continue;
      if (t < refuse[tm.id]) continue;
      const it = tracker.intent[tm.id];
      const heard = !!it && it.intent === 'healing' && t - it.t <= win;
      const d = d2(tm, me);
      const v = Math.hypot(tm.vx || 0, tm.vz || 0);
      const toward = (me.x - tm.x) * (tm.vx || 0) + (me.z - tm.z) * (tm.vz || 0);
      if (repairing) {
        // the implicit signal: it came up to me (not passing by, not working this gen itself) -> let go or keep repairing, once
        const te = hud[tm.id];
        if (d > SIGNAL_M || (te && te.activity) || t - kept[tm.id] < KEEP_S) continue;
        if (!heard && v > 0.5 && toward <= 0) continue;
        let z;
        if (threatened(obs, [me]) && !(P.letGoThreatW > 0)) z = -1;
        else {
          const threat = obs.terror ? Math.max(0, Math.min(1, 1 - obs.terror.approx / 32)) : 0;
          z = P.letGoW - P.letGoProgW * prog + P.letGoThreatW * threat - (tm.state === 'healthy' ? 0 : 0.5);
        }
        if (z <= 0) { kept[tm.id] = t; stats.sigKeep++; continue; }
        stats.sigLetGo++;
      } else {
        if (!(P.healAcceptDist > 0) || !heard || d > P.healAcceptDist) continue;
        // both of us offered (two injured survivors): whoever said "healing" first heals, the other is healed (tie: lower id heals)
        if (offer && offer.id === tm.id && offer.said && (offer.saidT < it.t || (offer.saidT === it.t && me.id < tm.id))) continue;
        if (!(d <= SIGNAL_M || (v > 0.5 && toward > 0.7 * v * d))) continue;
        if (threatened(obs, [me, tm])) continue;
      }
      accept = { from: tm.id, t0: t }; stats.accepts++;
      if (offer && offer.id === tm.id) offer = null;   // I was going to heal it: it heals me instead
      return { look: { x: tm.x, z: tm.z } };
    }
    return null;
  }

  return { update, healer, patient, stats, get offer() { return offer; }, get accept() { return accept; } };
}
