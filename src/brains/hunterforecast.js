// Short-horizon forecast of where the hunter is GOING (per survivor brain instance; no module-level state).
//
// Legit info only: the hunter as seen now (position, velocity, a visible vault), the last sighting, and my own
// position / plan. Nothing hidden is read.
//
// A small mixture of motion models, each predicting the hunter's position dt s ahead (0.5-3 s):
//   pursue   : runs at me along the walkable path (first string-pulled waypoint, then straight at me) -- what routes.js
//              assumes everywhere (pure pursuit);
//   momentum : keeps its current velocity, sliding along walls (it is committed to a direction: going round a tile,
//              walking to a generator, ...);
//   cut      : heads for the point I'm about to come out at (the survivor names it: the far side of my next loop
//              crossing / my flee point), else for where I'll be (my velocity) -- a cut-off / intercept;
//   stand    : stays put (a stand-off at a window, a break, a kick, a hook).
// Every model's prediction made REACT s ago is scored against where the hunter actually is now (when seen); the model
// weights are prior x exp(-recent error / 1.5 m), errors kept as an exponential average over learnS. So the forecast
// learns, within a chase, which way this hunter plays: a follower keeps "pursue" on top, a hunter that commits round
// the tile turns "momentum" / "cut" up, a stand-off turns up "stand".
//
// commit(a, me): around one anchor (window / pallet) between us: P(through) (it vaults / follows me over), P(around)
// (walks round the obstacle) and P(stand), from the visible vault, the mixture's predicted approach to the anchor and
// the smoothed velocity relative to the anchor.

const MODELS = ['pursue', 'momentum', 'cut', 'stand'];
export const FC_MODELS = MODELS;

export class HunterForecast {
  constructor(ctx, loops, opts = {}) {
    this.L = loops;
    this.W = loops.W; this.H = loops.H;
    this.vH = (ctx.config.hunter && ctx.config.hunter.speed) || 4.6;
    this.react = opts.react ?? 0.5;                 // scoring lag (s): predictions made this long ago are checked now
    this.learnS = Math.max(0.2, opts.learnS ?? 1.5);
    this.prior = opts.prior ?? [1, 0.6, 0.4, 0.3];  // pursue / momentum / cut / stand
    this.err = new Float64Array(MODELS.length);     // smoothed prediction error (m)
    this.pend = [];                                 // [{ due, px[], pz[] }]
    this.last = null;                               // last visible hunter { t, x, z, vx, vz }
    this.sv = { x: 0, z: 0 };                       // smoothed velocity (0.3 s)
    this.t = -99;
    this.cutPt = null;
    this.w = this.prior.map((p) => p / this.prior.reduce((a, b) => a + b, 0));
    this.stats = { scored: 0 };
  }

  solidAt(x, z) {
    const i = Math.floor(x), j = Math.floor(z);
    return i < 0 || j < 0 || i >= this.W || j >= this.H || this.L.solid[j * this.W + i] === 1;
  }
  // move from (x,z) toward (tx,tz) by s metres in 0.25 m steps, sliding along walls (axis-wise) when blocked
  slide(x, z, tx, tz, s) {
    let left = s;
    for (let g = 0; g < 80 && left > 1e-6; g++) {
      const dx = tx - x, dz = tz - z, L = Math.hypot(dx, dz);
      if (L < 0.05) break;
      const st = Math.min(0.25, left, L), ux = dx / L, uz = dz / L;
      if (!this.solidAt(x + ux * st, z + uz * st)) { x += ux * st; z += uz * st; }
      else if (Math.abs(ux) > 0.1 && !this.solidAt(x + Math.sign(ux) * st, z)) x += Math.sign(ux) * st;
      else if (Math.abs(uz) > 0.1 && !this.solidAt(x, z + Math.sign(uz) * st)) z += Math.sign(uz) * st;
      else break;
      left -= st;
    }
    return { x, z };
  }

  // each model's prediction dt s ahead from hunter state h for me at `me` (moving at me.vx/vz)
  models(api, h, me, dt) {
    const vH = Math.max(this.vH, Math.hypot(h.vx || 0, h.vz || 0));
    const out = new Array(MODELS.length);
    // pursue: first waypoint of the walkable path, then straight at me; stops at ~1 m from me
    let wp = null;
    try { wp = api && api.nav ? api.nav.nextWaypoint(h, me) : null; } catch { wp = null; }
    const dMe = Math.hypot(me.x - h.x, me.z - h.z), s = Math.min(vH * dt, Math.max(0, dMe - 1));
    if (wp) {
      const dW = Math.hypot(wp.x - h.x, wp.z - h.z);
      if (dW >= s) out[0] = this.slide(h.x, h.z, wp.x, wp.z, s);
      else { const p = this.slide(h.x, h.z, wp.x, wp.z, dW); out[0] = this.slide(p.x, p.z, me.x, me.z, s - dW); }
    } else out[0] = this.slide(h.x, h.z, me.x, me.z, s);
    // momentum: current (smoothed) velocity
    const vx = this.sv.x, vz = this.sv.z, sp = Math.hypot(vx, vz);
    out[1] = sp < 0.3 ? { x: h.x, z: h.z } : this.slide(h.x, h.z, h.x + vx * 10, h.z + vz * 10, sp * dt);
    // cut: to the point I come out at (named), else where I'll be
    const c = this.cutPt || { x: me.x + (me.vx || 0) * dt, z: me.z + (me.vz || 0) * dt };
    out[2] = this.slide(h.x, h.z, c.x, c.z, Math.min(vH * dt, Math.hypot(c.x - h.x, c.z - h.z)));
    out[3] = { x: h.x, z: h.z };
    return out;
  }

  // per decision: obs (hunter visible or not), me, cutPt (optional point I'm about to come out at)
  update(obs, api, me, cutPt = null) {
    this.cutPt = cutPt;
    const h = obs.hunter, t = obs.t;
    if (!h) { this.t = t; return; }
    if (this.last) {
      const dt = Math.max(1e-3, t - this.last.t), k = Math.min(1, dt / 0.3);
      this.sv.x += ((h.vx || 0) - this.sv.x) * k; this.sv.z += ((h.vz || 0) - this.sv.z) * k;
    } else { this.sv.x = h.vx || 0; this.sv.z = h.vz || 0; }
    // score predictions that are due (the hunter is seen now)
    const keep = [];
    for (const p of this.pend) {
      if (p.due > t + 1e-9) { keep.push(p); continue; }
      if (t - p.due > 0.3) continue;                 // stale (the hunter was out of sight at the due time)
      const k = Math.min(1, this.react / this.learnS);
      for (let m = 0; m < MODELS.length; m++) this.err[m] += (Math.hypot(p.px[m] - h.x, p.pz[m] - h.z) - this.err[m]) * k;
      this.stats.scored++;
    }
    this.pend = keep;
    if (!h.vaulting && (!this.pend.length || t - this.pend[this.pend.length - 1].made >= 0.199)) {
      const pr = this.models(api, h, me, this.react);
      this.pend.push({ made: t, due: t + this.react, px: pr.map((q) => q.x), pz: pr.map((q) => q.z) });
    }
    let tot = 0;
    for (let m = 0; m < MODELS.length; m++) { this.w[m] = this.prior[m] * Math.exp(-this.err[m] / 1.5); tot += this.w[m]; }
    for (let m = 0; m < MODELS.length; m++) this.w[m] /= tot || 1;
    this.last = { t, x: h.x, z: h.z, vx: h.vx || 0, vz: h.vz || 0, vaulting: !!h.vaulting, vault: h.vault };
    this.t = t;
  }

  // a new chase / long loss of sight: forget the learned weights
  reset() { this.err.fill(0); this.pend.length = 0; this.last = null; for (let m = 0; m < MODELS.length; m++) this.w[m] = this.prior[m] / this.prior.reduce((a, b) => a + b, 0); }

  // hunter state to predict from: visible now, or the last sighting carried along for at most 1.5 s
  base(obs) {
    if (obs.hunter) return obs.hunter;
    const l = this.last;
    if (!l || obs.t - l.t > 1.5) return null;
    return { x: l.x, z: l.z, vx: l.vx, vz: l.vz };
  }

  // branches [{ w, x, z }] dt s ahead (a visible vault: it lands on the far side first)
  branches(obs, api, me, dt) {
    let h = this.base(obs);
    if (!h) return null;
    if (h.vaulting && h.vault) {
      const rem = (1 - (h.vault.progress || 0)) * 1.7;
      h = { x: h.vault.toX, z: h.vault.toZ, vx: 0, vz: 0 };
      dt = Math.max(0, dt - rem);
    } else if (!obs.hunter && this.last) {
      const age = obs.t - this.last.t; dt += age;          // last sighting: predict from then
    }
    const pr = this.models(api, h, me, dt);
    return pr.map((p, m) => ({ w: this.w[m], x: p.x, z: p.z, m: MODELS[m] }));
  }

  predict(obs, api, me, dt) {
    const b = this.branches(obs, api, me, dt);
    if (!b) return null;
    let x = 0, z = 0;
    for (const q of b) { x += q.w * q.x; z += q.w * q.z; }
    return { x, z };
  }

  // around anchor a (my side point mine, far side point far): P(through / around / stand)
  commit(obs, api, me, a, mine, far) {
    const h = obs.hunter;
    if (!h) return null;
    if (h.vaulting && h.vault) {
      const toMe = Math.hypot(h.vault.toX - mine.x, h.vault.toZ - mine.z) < Math.hypot(h.vault.fromX - mine.x, h.vault.fromZ - mine.z);
      return toMe ? { through: 1, around: 0, stand: 0 } : { through: 0, around: 1, stand: 0 };
    }
    const sp = Math.hypot(this.sv.x, this.sv.z);
    const dA = Math.hypot(a.c.x - h.x, a.c.z - h.z);
    // velocity toward the anchor (the lane) vs sideways / away
    const toward = dA > 0.5 ? (this.sv.x * (a.c.x - h.x) + this.sv.z * (a.c.z - h.z)) / dA : sp;
    const pStand = Math.max(0, Math.min(1, 1 - sp / 1.5)) * Math.max(this.w[3] * 2, 0.5);
    // the mixture's 1 s prediction: closer to the anchor than now = coming through
    const p1 = this.predict(obs, api, me, 1.0);
    const closer = p1 ? dA - Math.hypot(a.c.x - p1.x, a.c.z - p1.z) : 0;
    const cosT = sp > 0.5 ? toward / sp : 0;
    let through = Math.max(0, Math.min(1, 0.5 + 0.35 * cosT + 0.08 * closer));
    if (dA > 10) through *= 0.7;                           // far away: it can still choose
    const moving = 1 - Math.min(1, pStand);
    return { through: moving * through, around: moving * (1 - through), stand: 1 - moving };
  }
}
