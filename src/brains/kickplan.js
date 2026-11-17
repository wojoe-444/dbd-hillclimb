// Kicked / threatened generator: when the hunter drives me off the gen I was repairing (and kicks it, or is likely to),
// either HIDE NEARBY — a spot within kickHideMaxM of the gen that the gen's sides can't see (the hunter kicks from
// there), ideally a peek spot whose camera still sees the gen — watch for the hunter to leave and come straight back
// to stop the regression; or LEAVE for another gen (the survivor's normal sneak / gen choice). A utility decision:
//
//   U(hide) = kickHideW                                   affinity (negative .. positive = against .. for)
//           + kickHideProgW x progress x (1.5 if I've seen it regressing / being kicked)    owner: more common near done
//           + kickAltW x how poor the alternative is      (nearest other known unfinished gen: far / little progress /
//                                                          none known -> 1)
//           - kickRiskW x risk                            (hunter closeness: sighting distance or terror layer; the
//                                                          spot's thin cover; being injured)
//   hide if U > 0 and a spot exists; otherwise leave (one decision per episode, then the normal logic runs).
//
// Hiding: walk/run (coverRun) to the spot, freeze, look at the hunter if seen else at the gen. The hunter counts as
// "near the gen" while seen within 20 m of it (not walking away beyond 10 m), or its terror layer >= 2 is heard, or it
// was seen < 1 s ago near it. Return kickReturnS after it was last near; give up after kickHideMaxS. Abort (normal
// logic takes over: chase / stealth) as soon as I'm chased or the visible hunter could see me. Returning: repair the
// gen until it's seen not regressing; a hunter coming back (seen approaching within 12 m of the gen, could see me, or
// terror layer 3) sends me back into hiding once, then the plan ends.
//
// Legit info only: own sight / camera (gen progress + `regressing` only while perceived, the visible hunter's act),
// terror layer, last sighting, the static cover map (hunterbelief.js) and line of sight. No module-level state: one
// planner per survivor brain closure.

export const kickSpace = {
  kickHideW:     [-3, 3, -0.6],  // affinity for hiding near my gen when the hunter drives me off it (vs leaving)
  kickHideProgW: [0, 3, 1.2],    // ... + this x the gen's progress (x1.5 if I've seen it regressing / being kicked)
  kickAltW:      [0, 2, 0.5],    // ... + this x how poor the alternative gen is (far, little progress, none known = 1)
  kickRiskW:     [0, 2, 0.6],    // ... - this x risk (hunter closeness, the spot's thin cover, injured)
  kickHideMaxM:  [4, 24, 12],    // hiding spot at most this far from the gen
  kickReturnS:   [0, 10, 2],     // go back this long after the hunter was last near the gen
  kickHideMaxS:  [5, 60, 25],    // give up hiding near the gen after this long
};

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// deps: { belief (HunterBelief: coverAt, fine, exposure, topCells), peekValue(api, pt, targets) -> {v, look},
//         hunterCouldSee(api, h, pt), slots (slot picker), stats, beliefOn }
export function makeKickPlanner(ctx, P, deps) {
  const M = ctx.map, W = M.w, H = M.h;
  const { belief, peekValue, hunterCouldSee, slots, stats } = deps;
  for (const k of ['kickHides', 'kickLeaves', 'kickReturns', 'kickGiveUps', 'kickAborts', 'kickStops']) stats[k] = 0;
  let plan = null;            // { gi, phase: 'hide'|'return', start, spot, look, lastNearT, retT, rehides, sawReg }
  let lastWork = { gi: -1, t: -99 };
  const cool = new Map();     // gi -> time until which no new decision is taken for this gen
  const statics = new Map();  // gi -> static spot candidates around that gen (cover, hidden from its sides, peek)

  const genPts = (g) => (g.slots && g.slots.length ? g.slots.map((s) => ({ x: s.x, z: s.z, p: 1 })) : [{ x: g.x, z: g.z, p: 1 }]);
  // static candidates for gen g: walkable cells on rings around it, body hidden from every repair side (where the
  // hunter stands to kick), scored by cover + how well a camera there sees the gen (peek)
  function staticSpots(gi, g, api) {
    let list = statics.get(gi);
    if (list && list.R === P.kickHideMaxM) return list;
    list = []; list.R = P.kickHideMaxM;
    const tg = genPts(g), seen = new Set();
    for (let rr = 3; rr <= P.kickHideMaxM; rr += 1.5) {
      const n = Math.min(24, Math.round(2 * Math.PI * rr / 2));
      for (let k = 0; k < n; k++) {
        const a = ((k + (Math.round(rr * 2) % 2 ? 0.5 : 0)) / n) * 2 * Math.PI;
        const i = Math.floor(g.x + Math.cos(a) * rr), j = Math.floor(g.z + Math.sin(a) * rr);
        if (i < 0 || j < 0 || i >= W || j >= H || !belief.fine[j * W + i]) continue;
        const key = j * W + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const pt = { x: i + 0.5, z: j + 0.5 };
        if (tg.some((t) => api.los(t, pt))) continue;                     // a kicking hunter would see me here
        const pv = peekValue(api, pt, tg);
        list.push({ pt, r: rr, cover: belief.coverAt(pt.x, pt.z), peek: pv.v, look: pv.look });
      }
    }
    statics.set(gi, list);
    return list;
  }

  // best hiding spot for gen gi right now: static score + not visible to / not toward the visible hunter + belief
  // exposure + path length from me
  function pickSpot(obs, api, gi) {
    const g = obs.gens[gi], me = obs.self, h = obs.hunter;
    const cands = staticSpots(gi, g, api).map((c) => ({ c, s: P.coverW * c.cover + P.peekW * 0.5 * c.peek - 0.3 * c.r / P.kickHideMaxM - 0.5 * d2(me, c.pt) / P.kickHideMaxM }));
    cands.sort((x, y) => y.s - x.s);
    const top = deps.beliefOn && !h ? belief.topCells(8) : null;
    let best = null, bs = -Infinity, tried = 0;
    for (const { c, s: s0 } of cands) {
      if (tried >= 8) break;
      if (h && (hunterCouldSee(api, h, c.pt) || api.los(h, c.pt))) continue;
      if (h && d2(c.pt, h) < Math.min(8, d2(me, h))) continue;                 // not right next to the hunter
      const nd = api.nav.dist(me, c.pt);
      if (!(nd < 2 * P.kickHideMaxM + 6)) continue;
      tried++;
      let s = s0 - 0.5 * nd / P.kickHideMaxM;
      if (top) s -= P.exposeW * belief.exposure(api, c.pt, top);
      if (h) {   // the walk there must not close in on the hunter much
        const closer = d2(me, h) - d2(c.pt, h);
        if (closer > 2) s -= 0.2 * (closer - 2);
      }
      if (s > bs) { bs = s; best = c; }
    }
    return best;
  }

  const seenKick = (obs, g) => g.regressing === true || !!(obs.hunter && obs.hunter.act === 'kickGen' && obs.hunter.actTarget === g.id);

  // how poor the alternative is (0 = a close, well-progressed known gen; 1 = none known)
  function altBad(obs, api, gi) {
    let best = 1;
    for (let j = 0; j < obs.gens.length; j++) {
      const g = obs.gens[j];
      if (j === gi || !g.known || g.done || g.blocked) continue;
      const nd = api.nav.dist(obs.self, g);
      if (!(nd < Infinity)) continue;
      best = Math.min(best, 0.6 * clamp01(nd / 60) + 0.4 * (1 - g.progress));
    }
    return best;
  }

  function risk(obs, spot) {
    const me = obs.self, h = obs.hunter;
    let r = 0;
    if (h) r += clamp01(1 - d2(h, me) / 24);
    else if (obs.terror) r += 0.25 * obs.terror.layer;
    r += 0.5 * (1 - (spot ? spot.cover : 0));
    if (me.state === 'injured') r += 0.25;
    return r;
  }

  // the hunter is (likely) still at / around the gen
  function hunterNear(obs, g) {
    const h = obs.hunter;
    if (h) {
      const dg = d2(h, g), away = (h.vx || 0) * (h.x - g.x) + (h.vz || 0) * (h.z - g.z) > 0.5 * dg;
      return dg < 20 && !(away && dg > 10);
    }
    const lh = obs.lastHunter;
    if (lh && obs.t - lh.t < 1 && d2(lh, g) < 20) return true;
    if (!obs.terror) return false;
    // heard: the inner layer = near; the middle layer only while it isn't receding (it just dropped from 3 to 2 = leaving)
    return obs.terror.layer >= 3 || (obs.terror.layer === 2 && belief.trend(obs.t, 4) >= 0);
  }
  // returning: the hunter is coming back
  function hunterBack(obs, api, g) {
    const h = obs.hunter, me = obs.self;
    if (h) {
      if (hunterCouldSee(api, h, me) && d2(h, me) < 24) return true;
      const dg = d2(h, g), toward = (h.vx || 0) * (g.x - h.x) + (h.vz || 0) * (g.z - h.z) > 0.5 * dg;
      return dg < 12 && toward;
    }
    return !!obs.terror && obs.terror.layer >= 3;
  }

  const end = (obs, gi, why) => { if (why) stats[why]++; plan = null; cool.set(gi, obs.t + 20); };

  return {
    get active() { return !!plan; },
    get gen() { return plan ? plan.gi : -1; },
    get phase() { return plan ? plan.phase : null; },
    // every decide, before the hook: remember the gen I'm repairing
    note(obs, genTarget) {
      if (obs.self.act === 'repair' && genTarget >= 0) lastWork = { gi: genTarget, t: obs.t };
    },
    // threat: the normal logic is about to pull me off my gen (sneak / flee / slip out of view). Returns an action or
    // null (no plan / plan ended / leave decided: the normal logic runs).
    decide(obs, api, threat) {
      const me = obs.self, h = obs.hunter;
      if (me.chased || obs.gatesPowered || (me.state !== 'healthy' && me.state !== 'injured')) {
        if (plan) end(obs, plan.gi, me.chased ? 'kickAborts' : null);
        return null;
      }
      if (!plan) {
        if (!threat || lastWork.gi < 0 || obs.t - lastWork.t > 3) return null;
        const gi = lastWork.gi, g = obs.gens[gi];
        if (!g.known || g.done || g.blocked || g.progress <= 0 || (cool.get(gi) ?? -99) > obs.t) return null;
        if (h && hunterCouldSee(api, h, me) && d2(h, me) < 16) return null;      // already spotted: run (normal logic)
        const spot = pickSpot(obs, api, gi);
        const reg = seenKick(obs, g);
        const U = P.kickHideW + P.kickHideProgW * g.progress * (reg ? 1.5 : 1) + P.kickAltW * altBad(obs, api, gi) - P.kickRiskW * risk(obs, spot);
        cool.set(gi, obs.t + 20);
        lastWork = { gi: -1, t: -99 };
        if (!spot || U <= 0) { stats.kickLeaves++; return null; }
        stats.kickHides++;
        plan = { gi, phase: 'hide', start: obs.t, spot, lastNearT: obs.t, retT: -1, rehides: 0, sawReg: reg };
      }
      const gi = plan.gi, g = obs.gens[gi];
      if (g.done || g.blocked) { end(obs, gi, null); return null; }
      if (seenKick(obs, g)) plan.sawReg = true;
      if (plan.phase === 'hide') {
        if (h && hunterCouldSee(api, h, me) && d2(h, me) < Math.max(P.hideNerveM, 12)) { end(obs, gi, 'kickAborts'); return null; }
        if (hunterNear(obs, g)) plan.lastNearT = obs.t;
        if (obs.t - plan.start > P.kickHideMaxS) { end(obs, gi, 'kickGiveUps'); return null; }
        if (obs.t - plan.lastNearT >= P.kickReturnS) { plan.phase = 'return'; plan.retT = obs.t; stats.kickReturns++; }
        else {
          const sp = plan.spot.pt;
          const look = h ? { x: h.x + (h.vx || 0) * 0.5, z: h.z + (h.vz || 0) * 0.5 } : (plan.spot.look || { x: g.x, z: g.z });
          if (d2(me, sp) > 0.6) {
            // the spot got exposed to the visible hunter on the way: pick another (once a second at most)
            if (h && hunterCouldSee(api, h, sp) && obs.t - (plan.repickT ?? -99) > 1) {
              plan.repickT = obs.t;
              const s2 = pickSpot(obs, api, gi);
              if (!s2) { end(obs, gi, 'kickAborts'); return null; }
              plan.spot = s2;
            }
            // walk (no scratch marks; a walking survivor doesn't start a chase) while the hunter is seen / heard close
            return { moveTo: plan.spot.pt, walk: P.coverRun <= 0.5 && (!!h || (!!obs.terror && obs.terror.layer >= 2)), look };
          }
          return { look };
        }
      }
      // ---- return: repair it until it's seen not regressing ----
      if (hunterBack(obs, api, g)) {
        if (plan.rehides >= 1) { end(obs, gi, 'kickAborts'); return null; }
        const s2 = pickSpot(obs, api, gi);
        if (!s2) { end(obs, gi, 'kickAborts'); return null; }
        plan.rehides++; plan.phase = 'hide'; plan.spot = s2; plan.lastNearT = obs.t; plan.start = Math.min(plan.start, obs.t);
        return { moveTo: s2.pt, walk: false };
      }
      if (obs.t - plan.retT > 30) { end(obs, gi, null); return null; }
      if (me.act === 'repair' && g.visible && g.regressing === false && obs.t - plan.retT > 1) { end(obs, gi, plan.sawReg ? 'kickStops' : null); return null; }
      return slots.act(obs, gi, g, { walk: false });
    },
  };
}
