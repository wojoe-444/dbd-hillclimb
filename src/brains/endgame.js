// Endgame for the parametric survivor (gates powered): which lever / exit, no duplicate lever work, and optionally holding
// a lever just short of opening while a teammate is hooked / downed / carried (the collapse only starts at the first
// opening). Going back for a hooked teammate is the rescue planner's job (rescue.js, `endgame` option): the survivor
// asks it first and only then comes here.
// Solo-queue info only (src/sim/README.md): lever progress only while I perceive the lever (own sightings, remembered),
// visible teammates, HUD 'gate' activity continuity via the teammate tracker (seen at a lever, HUD still 'gate' with
// rising progress -> still there), gate powered / open announcements, the collapse clock.
//
// Gate cost (seconds to get out through it):
//   open gate     path to the exit / run speed
//   free lever    path to the lever / run speed + (1 - progress) x leverS + lever-to-exit walk
//   held lever    (a teammate is on it) path / run speed + max(2, (1 - progress) x leverS) waiting + lever-to-exit walk;
//                 I wait near it instead of trying to work it (one survivor per lever)
// Hold (gateHoldProg < 1): my lever is at >= gateHoldProg, the collapse hasn't begun, a teammate is hooked / downed /
// carried, nobody is HUD-chased (a chased teammate needs an open exit), I'm not chased and the hunter isn't seen within
// gateHoldThreatM, terror below the inner layer -> stop working it and wait at the lever; otherwise finish it.
export const endgameSpace = {
  gateHoldProg:    [0.5, 1, 1],    // hold a lever at this progress while a teammate is incapacitated (1 = never: open and leave)
  gateHoldThreatM: [0, 40, 16],    // ...but finish it at once when the hunter is seen within this many m
};

const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function makeEndgame(ctx, P, tracker) {
  const M = ctx.map;
  const vRun = ctx.config.survivor.runSpeed ?? 4, leverS = ctx.config.gates?.leverS ?? 20;
  const reach = ctx.config.reach?.lever ?? 1.5;
  const mem = {};        // gate id -> { prog, t (last perceived), riseT (last seen rising without me) }
  const stats = { holdTicks: 0, heldWait: 0, levers: 0 };
  const gdOf = (id) => M.exitGates.find((x) => x.id === id);

  function atLever(me, gd) { return d2(me, gd.lever) <= reach; }

  function update(obs) {
    const me = obs.self;
    for (const g of obs.gates || []) {
      if (g.open || g.progress === undefined || g.progress === null) continue;
      const gd = gdOf(g.id), m = mem[g.id] || (mem[g.id] = { prog: 0, t: -99, riseT: -99 });
      const mine = me.act === 'openGate' && atLever(me, gd);
      if (!mine && g.progress > m.prog + 1e-4 && obs.t - m.t < 1.5) m.riseT = obs.t;
      m.prog = g.progress; m.t = obs.t;
    }
  }

  function progOf(g) { return g.open ? 1 : (g.progress ?? (mem[g.id] ? mem[g.id].prog : 0)); }

  // a teammate is working this lever (and I'm not)
  function heldByMate(obs, g, gd) {
    const me = obs.self;
    if (me.act === 'openGate' && atLever(me, gd)) return false;
    const hud = obs.hud;
    for (const t of obs.teammates) if (d2(t, gd.lever) <= reach + 0.2 && (!hud || !hud[t.id] || hud[t.id].activity === 'gate')) return true;
    for (let j = 0; j < 4; j++) {
      if (j === me.id) continue;
      const f = tracker.fix[j];
      if (f.coldT === null && f.act === 'gate' && d2(f, gd.lever) < 2.5) return true;
    }
    const m = mem[g.id];
    return !!m && obs.t - m.riseT < 1.5;
  }

  // seconds from pt out through the best gate (for the rescue planner's endgame deadline)
  function exitS(obs, nav, pt) {
    let best = Infinity;
    for (const g of obs.gates) {
      const gd = gdOf(g.id);
      const s = g.open ? nav.dist(pt, gd.exit) / vRun : (nav.dist(pt, gd.lever) + nav.dist(gd.lever, gd.exit)) / vRun + (1 - progOf(g)) * leverS;
      if (s < best) best = s;
    }
    return isFinite(best) ? best : 60;
  }

  // returns an action or null. opts: { holdProtection }
  function decide(obs, api, opts) {
    const me = obs.self, nav = api.nav, h = obs.hunter;
    let best = null, bs = Infinity;
    for (const g of obs.gates) {
      const gd = gdOf(g.id);
      if (!gd) continue;
      let s, held = false;
      if (g.open) s = nav.dist(me, gd.exit) / vRun;
      else {
        held = heldByMate(obs, g, gd);
        const left = (1 - progOf(g)) * leverS;
        s = nav.dist(me, gd.lever) / vRun + (held ? Math.max(2, left) : left) + nav.dist(gd.lever, gd.exit) / vRun;
      }
      if (s < bs) { bs = s; best = { g, gd, held }; }
    }
    if (!best) return null;
    const { g, gd, held } = best;
    if (g.open) return { moveTo: gd.exit };
    if (held) {                                         // someone's on it: wait close by, don't fight for the lever
      stats.heldWait++;
      const dl = d2(me, gd.lever);
      if (dl > 3) return { moveTo: gd.lever };
      return dl < 2 ? { moveDir: { x: me.x - gd.lever.x, z: me.z - gd.lever.z }, walk: true } : {};
    }
    if (!atLever(me, gd)) return { moveTo: gd.lever };
    if (opts.holdProtection) return {};
    if (P.gateHoldProg < 1 && !obs.endgame && progOf(g) >= P.gateHoldProg) {
      const hud = obs.hud || [];
      const down = hud.some((x) => x.id !== me.id && (x.state === 'hooked' || x.state === 'downed' || x.state === 'carried'));
      const chased = hud.some((x) => x.chased);
      const threat = me.chased || (h && d2(h, me) < P.gateHoldThreatM) || (obs.terror && obs.terror.layer >= 3);
      if (down && !chased && !threat) { stats.holdTicks++; return {}; }
    }
    stats.levers++;
    return { act: 'openGate', target: g.id };
  }

  return { update, decide, exitS, heldByMate, mem, stats };
}
