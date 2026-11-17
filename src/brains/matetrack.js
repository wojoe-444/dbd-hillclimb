// Per-teammate whereabouts, from legitimate solo-queue info only (one instance per survivor brain; no shared state):
//   * own sightings (camera: obs.teammates) -> a fix (position + time);
//   * HUD activity continuity: seen doing a stationary interaction (repair / heal / mend / gate / recover) and the HUD
//     has shown that same activity ever since with non-falling progress -> still there (the fix stays fresh);
//   * downed auras (live position), the HUD hook notifications (hooked: at that hook; unhooked: victim + rescuer at the
//     hook), HUD 'rescue' activity while exactly one teammate is hooked (at that hook);
//   * HUD state / chased, intents heard.
// Rescue claims ("going for unhook" intents): first heard (t0: keeps the order when the claimant re-announces), last heard
// (t), and interrupted once the HUD shows the claimant chased / downed / carried / hooked / dead / escaped after the claim,
// or doing a stationary non-rescue interaction (repair / heal / mend / gate) for > 2 s (it went back to work); spent once
// the HUD says it unhooked someone.
// Once the trail goes cold the position is uncertain within a radius growing at `spread` x run speed.
const STATIONARY = new Set(['repair', 'heal', 'mend', 'gate', 'recover', 'rescue', 'wiggle', 'selfUnhook']);

export class MateTracker {
  constructor(ctx, { spread = 0.6 } = {}) {
    this.me = ctx.id;
    this.spread = spread;
    this.vRun = ctx.config.survivor.runSpeed ?? 4;
    this.nav = ctx.nav;
    this.fix = [];
    // spawn: the four survivors start within the spawn group radius of each other
    const r0 = ctx.config.spawn?.groupRadius ?? 12;
    for (let j = 0; j < 4; j++) this.fix.push({ x: ctx.spawn.x, z: ctx.spawn.z, t: 0, r0, coldT: 0, act: null, prog: 0, okT: 0 });
    this.hooks = {};                 // victim id -> { x, z, t } (own copy of the HUD hook notifications)
    this.intent = [null, null, null, null];   // last intent heard per teammate: { intent, t }
    this.claim = [null, null, null, null];    // rescue claim per teammate: { t0, t, dead, busyT }
    this.notesRead = 0;
    this.state = ['healthy', 'healthy', 'healthy', 'healthy'];
    this.chased = [false, false, false, false];
  }

  setFix(j, x, z, t, r0 = 0.5, act = null, prog = 0) {
    const f = this.fix[j];
    f.x = x; f.z = z; f.t = t; f.r0 = r0; f.act = act; f.prog = prog; f.okT = t;
    f.coldT = act && STATIONARY.has(act) ? null : t;   // null = anchored (HUD continuity keeps it fresh)
  }

  update(obs) {
    const t = obs.t, hud = obs.hud;
    const notes = obs.notifications || [];
    for (; this.notesRead < notes.length; this.notesRead++) {
      const n = notes[this.notesRead];
      if (n.type === 'hooked') { this.hooks[n.who] = { x: n.x, z: n.z, t: n.t }; this.setFix(n.who, n.x, n.z, n.t, 0.5, 'hooked'); this.fix[n.who].coldT = null; }
      else if (n.type === 'unhooked') {
        const hk = this.hooks[n.who];
        if (hk) {
          this.setFix(n.who, hk.x, hk.z, n.t, 1.5);
          if (typeof n.by === 'number' && n.by !== this.me) this.setFix(n.by, hk.x, hk.z, n.t, 1.5);
        }
        if (typeof n.by === 'number' && this.claim[n.by]) this.claim[n.by].dead = true;   // that claim is spent

        delete this.hooks[n.who];
      } else if (n.type === 'died') delete this.hooks[n.who];
      else if (n.type === 'intent') {
        this.intent[n.from] = { intent: n.intent, t: n.t };
        if (n.intent === 'goingForUnhook') {
          const c = this.claim[n.from];
          // a re-announcement of a live claim (within 30 s) keeps its first-heard time; otherwise a new claim
          if (c && !c.dead && n.t - c.t <= 30) c.t = n.t;
          else this.claim[n.from] = { t0: n.t, t: n.t, dead: false, busyT: -1 };
        }
      }
    }
    if (!hud) return;
    const hookedIds = Object.keys(this.hooks);
    for (let j = 0; j < 4; j++) {
      if (j === this.me) continue;
      const hj = hud[j], f = this.fix[j];
      this.state[j] = hj.state; this.chased[j] = !!hj.chased;
      const c = this.claim[j];
      if (c && !c.dead && t > c.t) {
        if (hj.chased || (hj.state !== 'healthy' && hj.state !== 'injured')) c.dead = true;
        else if (hj.activity === 'repair' || hj.activity === 'heal' || hj.activity === 'mend' || hj.activity === 'gate') {
          if (c.busyT < 0) c.busyT = t; else if (t - c.busyT > 2) c.dead = true;
        } else c.busyT = -1;
      }
      if (hj.state === 'hooked' || hj.state === 'dead' || hj.state === 'escaped') continue;
      const seen = obs.teammates.find((m) => m.id === j);
      if (seen) { this.setFix(j, seen.x, seen.z, t, 0.5, hj.activity, hj.activityProgress); continue; }
      const aura = obs.downedAuras && obs.downedAuras.find((a) => a.id === j);
      if (aura) { this.setFix(j, aura.x, aura.z, t, 0.5); continue; }
      if (hj.activity === 'rescue' && hookedIds.length === 1) { const hk = this.hooks[hookedIds[0]]; this.setFix(j, hk.x, hk.z, t, 1.5, 'rescue'); continue; }
      if (f.coldT === null) {
        // anchored: still the same stationary interaction, progress not falling (a heal / repair keeps rising)
        const same = hj.activity === f.act && (hj.activityProgress ?? 0) >= (f.prog ?? 0) - 0.02;
        if (same) { f.prog = hj.activityProgress ?? 0; f.okT = t; }
        else f.coldT = f.okT;
      }
    }
  }

  // teammates I last saw repairing whose HUD still shows that same repair (anchored fix): [{ j, x, z }]
  repairFixes() {
    const out = [];
    for (let j = 0; j < 4; j++) { const f = this.fix[j]; if (j !== this.me && f.coldT === null && f.act === 'repair') out.push({ j, x: f.x, z: f.z }); }
    return out;
  }

  // estimated whereabouts of teammate j: { x, z, r (uncertainty radius, m), conf (0..1), age (s since the trail went cold) }
  est(j, t) {
    const f = this.fix[j];
    const speed = this.state[j] === 'downed' ? 0.7 : this.vRun;
    const age = f.coldT === null ? 0 : Math.max(0, t - f.coldT);
    const r = Math.min(150, f.r0 + (f.coldT === null ? 0.5 : this.spread * speed * age));
    return { x: f.x, z: f.z, r, conf: 1 / (1 + r / 15), age };
  }

  // expected path distance from teammate j's estimate to pt (a map feature, e.g. a hook: O(1) field lookup) + its spread
  pathTo(j, pt, t) {
    const e = this.est(j, t);
    let d = this.nav.dist(e, pt);
    if (!isFinite(d)) d = 1.3 * Math.hypot(e.x - pt.x, e.z - pt.z);
    return { d, r: e.r, conf: e.conf };
  }

  // teammate j's live rescue claim, first heard at or after time t0 (a hooking), last heard within maxAge s, not
  // interrupted since: { t0, t } or null
  liveClaim(j, t0, now, maxAge = 25) {
    const c = this.claim[j];
    return c && !c.dead && c.t0 >= t0 && now - c.t <= maxAge ? c : null;
  }

  // teammate j said "going for unhook" at or after time t0, within maxAge s (and hasn't been interrupted since)
  claimedUnhook(j, t0, now, maxAge = 25) { return !!this.liveClaim(j, t0, now, maxAge); }
}
