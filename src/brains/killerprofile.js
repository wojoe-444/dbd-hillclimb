// Killer profile: what THIS survivor has learned about the hunter's habits during the match, from its own observations
// only (own sight of the hunter / teammates, the game HUD, hook notifications; src/sim/README.md "Solo queue + HUD").
// One instance per survivor brain closure; no module-level mutable state, nothing shared between survivors, the
// hunter's params are never read. No rng is consumed, so tracking alone never changes a match.
//
// Every trait is a rate with a Beta prior: p = (hits + N p0) / (trials + N), N = profilePriorN (how many observations the
// prior is worth: small = trust what I see quickly). conf = trials. The adaptations use dev = p - p0, so before any
// evidence (and with every *Adapt knob at 0) the survivor plays exactly as it did without the profile.
//
// tracked trait (p0)                 evidence (one trial each unless noted)
//   respect  pallet respect (0.5)    a survivor (me / a visible teammate) stands at an UP pallet and the visible hunter is
//                                    within 6 m of its stun zone: it holds still outside the zone >= 0.5 s (1) vs walks
//                                    into the zone / gets stunned (0). One trial per pallet episode.
//   mind     loop mind games (0.07)   2 s windows of a chase on me with the hunter visible within 14 m: it stood off (still,
//                                    not acting / stunned / in a pallet hold) or reversed while I kept my direction (1) vs
//                                    plain pursuit (0).
//   follow   window follow (0.5)     I vault a window with the hunter visible within 8 m: it vaults the same window within
//                                    4 s (1) vs not (0, needs a sighting in that time).
//   abandon  quick abandon (0.3)     a chase on me ends with me standing and the hunter seen within 14 m in the last 2 s,
//                                    not switching to a teammate / carrying (1) vs ends with me downed / lasts 45 s (0).
//   tunnel   tunnelling (0.3)         after an unhook (HUD / notification): the next chase (HUD chased flag) or down is the
//                                    unhooked survivor (1) vs someone else (0); nobody for 60 s: 0 with weight 0.5.
//   camp     camping / proxy (0.2)   first 30 s of a teammate's hook, 1 Hz samples of weight 0.15: hooked mate's Resolve
//                                    rising (= hunter within 16 m) or the hunter seen within 16 m of the hook (1) vs seen
//                                    > 28 m away, or terror heard while I'm > 48 m from the hook (0); flat Resolve after
//                                    the 7 s grace with no near evidence: 0 at half weight.
//   slug     slugging (0.2)          a survivor goes down (HUD): picked up within 12 s (0) vs left (someone else chased
//                                    meanwhile / still down after 20 s / back up without a pick-up) (1).
//   kicks    gen kicks / minute      visible kick starts + known gens seen regressing (count, no prior).
//   lunge    attack distance (m)     distance to the nearest standing survivor when a visible hunter starts a windup
//                                    (mean, prior 2.5 m worth N).
//
// Adaptations (all 0 = ignore the profile):
//   palletRespectAdapt  respecter: palletGreed up (save the pallet, loop on; no pre-drop), stunSeek down;
//                       runner: stunSeek up (hold the drop for the stun); greed unchanged (lowering it A/B'd worse)
//   chaseAbandonAdapt   quick abandoner: palletGreed up (pre-drop less, it will give up anyway)
//   reverseAdapt        mind gamer: loopReverseDist up (turns the reversal read on), loopReactS shorter; plain
//                       pursuer: loopReverseDist down, loopReactS longer
//   tunnelAdapt         for 60 s after MY unhook vs a tunneller: fleeSeenDist / fleeTR up (flee earlier, leave gens on
//                       terror); vs a non-tunneller: down
//   campAdapt           rescue utility: camper -> rescue later (do gens); no change vs a leaver (sooner A/B'd worse)
//   slugAdapt           slugger: healDist up (go farther to pick up / heal teammates left on the floor)

export const profileSpace = {
  profilePriorN:      [0.5, 20, 4],   // prior strength (observations the prior is worth): small = adapt quickly
  palletRespectAdapt: [0, 2, 0],      // pallet play vs observed pallet respect (respecter: keep pallets; runner: drop for the stun)
  chaseAbandonAdapt:  [0, 2, 0],      // pallet play vs observed chase abandon rate (quick abandoner: pre-drop less)
  reverseAdapt:       [0, 2, 0],      // loop reversal read vs observed mind games (stand-offs / reversals)
  tunnelAdapt:        [0, 2, 0],      // after my unhook vs an observed tunneller: flee earlier
  campAdapt:          [0, 2, 0],      // rescue timing vs observed camping (camper: later, leaver: sooner)
  slugAdapt:          [0, 2, 0],      // heal / pick-up radius vs observed slugging
};

// Beta-prior rate: s successes out of n (weighted) trials
function rate(p0) {
  return {
    p0, s: 0, n: 0,
    add(x, w = 1) { this.s += x * w; this.n += w; },
    p(N) { return (this.s + N * this.p0) / (this.n + N); },
    dev(N) { return (this.s + N * this.p0) / (this.n + N) - this.p0; },
  };
}

const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rectDist = (o, x0, z0, x1, z1) => Math.hypot(Math.max(x0 - o.x, 0, o.x - x1), Math.max(z0 - o.z, 0, o.z - z1));
const standing = (st) => st === 'healthy' || st === 'injured';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function makeKillerProfile(ctx, P) {
  const M = ctx.map;
  const al = (ctx.config.hunter && ctx.config.hunter.palletStunAlongM) ?? 1;
  const N = () => Math.max(1e-6, P.profilePriorN ?? 4);
  // p0 = roughly the midpoint of what the detectors read against the extreme hunters (scripts/exp-killer-profile.js)
  const R = { respect: rate(0.5), mind: rate(0.07), follow: rate(0.5), abandon: rate(0.3), tunnel: rate(0.3), camp: rate(0.2), slug: rate(0.2) };
  const kicks = { n: 0 }, lunge = { sum: 0, n: 0 };
  const stats = { palletEpisodes: 0, mindWindows: 0, unhooks: 0, hooks: 0, downs: 0 };

  let lastT = null, notesRead = 0;
  let prevHud = null, prevPal = null, prevH = null;   // previous update's HUD states / pallet states / visible hunter
  const palEp = new Map();                            // pallet index -> { last, still, done }
  let mindW = null;                                   // { t0, vis, flag }
  const vHist = [];                                   // [{ t, hvx, hvz, mvx, mvz }] ~ last 1 s (visible hunter + me)
  let myChase = null;                                 // { t0, lastSeenT, lastSeenD, done }
  let follow = null;                                  // { win, t, seen }
  let wasVaulting = false, prevGenReg = null;
  const tunEps = [];                                  // { who, t, done }
  const campEps = {};                                 // victim -> { x, z, t, nextT, resolve }
  const slugEps = {};                                 // victim -> { t }
  let myUnhookT = -99, otherChaseT = -99;

  function stunZoneDist(o, p) {
    return p.axis === 'x' ? rectDist(o, p.x0 - al, p.z0, p.x1 + al, p.z1) : rectDist(o, p.x0, p.z0 - al, p.x1, p.z1 + al);
  }

  function hudUpdate(obs) {
    const hud = obs.hud, t = obs.t;
    // hook notifications (teammates): camp episodes
    const notes = obs.notifications || [];
    for (; notesRead < notes.length; notesRead++) {
      const n = notes[notesRead];
      if (n.type === 'hooked') { campEps[n.who] = { x: n.x, z: n.z, t: n.t, nextT: n.t + 1, resolve: 0, upT: -99 }; stats.hooks++; }
    }
    if (!hud) return;
    const rising = [], downs = [];
    for (const x of hud) {
      const pv = prevHud && prevHud[x.id];
      if (!pv) continue;
      // unhook (anyone, me included): hooked -> standing
      if (pv.state === 'hooked' && standing(x.state)) { tunEps.push({ who: x.id, t }); stats.unhooks++; if (x.id === obs.self.id) myUnhookT = t; }
      if (x.chased && !pv.chased && standing(x.state)) { rising.push(x.id); if (x.id !== obs.self.id) otherChaseT = t; }
      if (x.state === 'downed' && pv.state !== 'downed' && pv.state !== 'carried') downs.push(x.id);
    }
    // tunnelling: the first chase / down after an unhook
    for (const e of tunEps) {
      if (e.done) continue;
      if (t - e.t > 60) { R.tunnel.add(0, 0.5); e.done = true; continue; }
      const first = downs.length ? downs : rising;
      if (!first.length) continue;
      R.tunnel.add(first.includes(e.who) ? 1 : 0); e.done = true;
    }
    for (let i = tunEps.length - 1; i >= 0; i--) if (tunEps[i].done) tunEps.splice(i, 1);
    // slugging
    for (const v of downs) { slugEps[v] = { t }; stats.downs++; }
    for (const k of Object.keys(slugEps)) {
      const e = slugEps[k], st = hud[k] ? hud[k].state : null;
      if (st === 'carried' || st === 'hooked') { if (t - e.t <= 12) R.slug.add(0); else R.slug.add(1, 0.5); delete slugEps[k]; continue; }
      if (st === 'dead' || st === 'escaped') { delete slugEps[k]; continue; }
      if (standing(st) || t - e.t > 20 || (t - e.t > 1 && rising.some((j) => j !== +k))) { R.slug.add(1); delete slugEps[k]; }
    }
    // camping: first 30 s of each teammate hook, 1 Hz samples
    for (const k of Object.keys(campEps)) {
      const e = campEps[k], v = hud[k];
      if (!v || v.state !== 'hooked' || t - e.t > 30) { delete campEps[k]; continue; }
      if ((v.resolve ?? 0) > e.resolve + 1e-6) e.upT = t;
      e.resolve = v.resolve ?? 0;
      if (t < e.nextT) continue;
      e.nextT = t + 1;
      const h = obs.hunter, me = obs.self;
      if (t - e.upT < 1.5 || (h && d2(h, e) < 16)) R.camp.add(1, 0.15);
      else if ((h && d2(h, e) > 28) || (obs.terror && me.x !== undefined && d2(me, e) > 48)) R.camp.add(0, 0.15);
      else if (t - e.t > 8) R.camp.add(0, 0.075);
    }
    prevHud = hud.map((x) => ({ state: x.state, chased: x.chased }));
  }

  function update(obs) {
    const t = obs.t, dt = lastT === null ? 0 : Math.max(0, t - lastT);
    lastT = t;
    hudUpdate(obs);
    if (!obs.pallets) return;            // minimal (hooked) obs: HUD / notifications only
    const me = obs.self, h = obs.hunter;
    const meUp = standing(me.state);

    // ---- pallet respect ----
    let palletHold = false;
    for (let i = 0; i < M.pallets.length; i++) {
      if (obs.pallets[i] !== 'up') continue;
      const p = M.pallets[i];
      const at = (meUp && rectDist(me, p.x0, p.z0, p.x1, p.z1) <= 1.5) || obs.teammates.some((m) => standing(m.state) && rectDist(m, p.x0, p.z0, p.x1, p.z1) <= 1.5);
      if (!at || !h) continue;
      const zd = stunZoneDist(h, p);
      if (zd > 6) continue;
      let ep = palEp.get(i);
      if (!ep || t - ep.last > 3) { ep = { last: t, still: 0, done: false }; palEp.set(i, ep); stats.palletEpisodes++; }
      ep.last = t;
      if (ep.done) continue;
      const spd = Math.hypot(h.vx || 0, h.vz || 0);
      if (zd <= 0.05 && !h.stunned) { R.respect.add(0); ep.done = true; }
      else if (spd < 0.6 && !h.windup && !h.cooldown && !h.stunned && !h.act && zd < 4.5) {
        palletHold = true;
        ep.still += dt;
        if (ep.still >= 0.5 - 1e-9) { R.respect.add(1); ep.done = true; }
      } else ep.still = 0;
    }
    // a drop that stunned the hunter: it ran in (if that episode is still open)
    if (prevPal && h && h.stunned && !(prevH && prevH.stunned)) {
      for (let i = 0; i < M.pallets.length; i++) {
        if (prevPal[i] !== 'up' || obs.pallets[i] !== 'dropped') continue;
        const ep = palEp.get(i);
        if (ep && !ep.done && t - ep.last < 1) { R.respect.add(0); ep.done = true; }
      }
    }

    // ---- loop mind games: 2 s windows of a chase on me, hunter visible within 14 m ----
    if (h) vHist.push({ t, hvx: h.vx || 0, hvz: h.vz || 0, mvx: me.vx || 0, mvz: me.vz || 0 });
    while (vHist.length && t - vHist[0].t > 1.0) vHist.shift();
    if (me.chased && meUp) {
      if (!mindW) mindW = { t0: t, vis: 0, flag: false, still: 0 };
      if (h && d2(h, me) < 14 && !h.vaulting && !h.carrying) {
        mindW.vis += dt;
        const spd = Math.hypot(h.vx || 0, h.vz || 0);
        if (spd < 0.5 && !h.windup && !h.cooldown && !h.stunned && !h.act && !palletHold) { mindW.still += dt; if (mindW.still >= 0.4 - 1e-9) mindW.flag = true; }
        else mindW.still = 0;
        const o = vHist[0];
        if (o && t - o.t >= 0.4) {
          const hs = Math.hypot(o.hvx, o.hvz), ms0 = Math.hypot(o.mvx, o.mvz), ms = Math.hypot(me.vx || 0, me.vz || 0);
          const hDot = (h.vx || 0) * o.hvx + (h.vz || 0) * o.hvz, mDot = (me.vx || 0) * o.mvx + (me.vz || 0) * o.mvz;
          if (hs > 2 && spd > 2 && hDot < -0.3 * hs * spd && ms0 > 2 && ms > 2 && mDot > 0.5 * ms0 * ms) mindW.flag = true;
        }
      }
      if (t - mindW.t0 >= 2) { if (mindW.vis >= 1.5) { R.mind.add(mindW.flag ? 1 : 0); stats.mindWindows++; } mindW = null; }
    } else mindW = null;

    // ---- window follow: my own window vaults with the hunter close ----
    if (me.vaulting && !wasVaulting && h && d2(h, me) < 8) {
      let win = null, bd = 2.6;
      for (const w of M.windows || []) { const c = { x: w.x + 0.5, z: w.z + 0.5 }; const d = d2(c, me); if (d < bd) { bd = d; win = w.id; } }
      if (win !== null) follow = { win, t, seen: false };
    }
    wasVaulting = !!me.vaulting;
    if (follow) {
      if (h) follow.seen = true;
      if (h && h.vaulting && h.vault && h.vault.window === follow.win) { R.follow.add(1); follow = null; }
      else if (t - follow.t > 4) { if (follow.seen) R.follow.add(0); follow = null; }
    }

    // ---- chase commitment (own chases) ----
    if (me.chased && !myChase) myChase = { t0: t, lastSeenT: -99, lastSeenD: Infinity, done: false };
    if (myChase && h) { myChase.lastSeenT = t; myChase.lastSeenD = d2(h, me); }
    if (myChase && me.chased && !myChase.done && t - myChase.t0 >= 45) { R.abandon.add(0); myChase.done = true; }
    if (myChase && !me.chased) {
      if (!myChase.done) {
        if (!meUp) R.abandon.add(0);
        // ended in contact (seen < 14 m in the last 2 s), not because it switched to a teammate (a HUD chase starting now)
        // or picked someone up (seen carrying)
        else if (t - myChase.lastSeenT <= 2 && myChase.lastSeenD < 14 && !(t - otherChaseT < 1.5) && !(h && h.carrying)) R.abandon.add(1);
      }
      myChase = null;
    }

    // ---- gen kicks (visible kick starts, known gens seen starting to regress) ----
    if (h && h.act === 'kickGen' && !(prevH && prevH.act === 'kickGen')) kicks.n++;
    const reg = obs.gens.map((g) => !!(g.known && g.visible && g.regressing));
    if (prevGenReg) for (let i = 0; i < reg.length; i++) if (reg[i] && !prevGenReg[i] && !(h && h.act === 'kickGen')) kicks.n++;
    prevGenReg = reg;

    // ---- lunge distance: windup starts ----
    if (h && h.windup && !(prevH && prevH.windup)) {
      let bd = meUp ? d2(h, me) : Infinity;
      for (const m of obs.teammates) if (standing(m.state)) bd = Math.min(bd, d2(h, m));
      if (bd < 6) { lunge.sum += bd; lunge.n++; }
    }

    prevPal = obs.pallets.slice();
    prevH = h ? { stunned: !!h.stunned, act: h.act, windup: !!h.windup } : null;
  }

  // ---- read-outs ----
  const dev = (k) => R[k].dev(N());
  const est = () => {
    const n = N(), o = {};
    for (const k of Object.keys(R)) o[k] = { p: R[k].p(n), conf: R[k].n };
    o.kicksPerMin = lastT > 0 ? kicks.n / (lastT / 60) : 0;
    o.lunge = { m: (lunge.sum + n * 2.5) / (lunge.n + n), conf: lunge.n };
    return o;
  };

  // ---- adaptation hooks (each exactly 0 / identity when its knob is 0 or there is no evidence yet) ----
  // greed only goes UP for a respecter: lowering it vs a runner ("drop earlier") cost kills in the A/B (more drops, more hits)
  const palletGreed = (g) => Math.max(0, g + 2 * P.palletRespectAdapt * Math.max(0, dev('respect')) + 2 * P.chaseAbandonAdapt * dev('abandon'));
  const stunSeek = (s) => clamp(s - 2 * P.palletRespectAdapt * dev('respect'), 0, 1);
  const reverseDist = (d) => Math.max(0, d + 150 * P.reverseAdapt * dev('mind'));   // p0 0.07: +0.05 -> 7.5 m per unit knob
  const reactS = (s) => s * Math.max(0.2, 1 - 8 * P.reverseAdapt * dev('mind'));
  const tunnelC = (obs) => (obs.t - myUnhookT < 60 ? 2 * P.tunnelAdapt * dev('tunnel') : 0);
  const fleeSeenDist = (obs, d) => Math.max(6, d + clamp(20 * tunnelC(obs), -10, 20));
  const fleeTR = (obs, d) => Math.max(0, d + clamp(15 * tunnelC(obs), -8, 15));
  // one-sided: camper -> rescue later; "rescue sooner vs a leaver" cost kills in the A/B (the read is noisy)
  const rescueTerm = () => -8 * P.campAdapt * Math.max(0, dev('camp'));            // p0 0.2: +0.1 -> -0.8 per unit knob
  const healDist = (d) => Math.max(0, d + 40 * P.slugAdapt * dev('slug'));

  return { update, est, stats, palletGreed, stunSeek, reverseDist, reactS, fleeSeenDist, fleeTR, rescueTerm, healDist, _rates: R };
}
