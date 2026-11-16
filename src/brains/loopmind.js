// Hunter loop mind games (used by hunter.js while it chases a visible survivor). Per brain instance: no module-level
// state; everything lives in the closure of makeLoopMind(ctx, P). The hunter knows the static map (like the genre's
// killer): the tile the survivor is looping is the best distance-held circuit (loops.js) through the anchor nearest to
// the survivor, and its centre / radius come from that circuit's side points.
//
// Knobs (hunterSpace, all off by default = the old "path straight at the survivor" chase, bit-identical: no RNG draw
// and no LoopModel are made while every knob is 0):
//   reverseChance  per loop pass: commit to running the tile the OTHER way round (opposite to the survivor's rotation
//                  about the tile centre) to meet it head-on, instead of following it;
//   standOffChance per loop pass (if not reversing): stop and wait, facing the survivor, to bait a reversal / a vault
//                  back into me; at most standOffMaxS;
//   predictLeadS   aim at the survivor's position this many seconds ahead (its velocity, slid along walls), not at
//                  where it is now.
// A "pass" starts when the loop situation begins (survivor near an anchor of a real circuit, both of us on that tile,
// hunter close) and again at each vault the survivor starts; at most one roll per 2 s.
import { LoopModel } from './loops.js';

const TAU = 2 * Math.PI;
const angMod = (a) => ((a % TAU) + TAU) % TAU;

export function makeLoopMind(ctx, P) {
  const on = (P.reverseChance > 0) || (P.standOffChance > 0);
  const M = ctx.map;
  let loops = null;                 // lazily (only once a mind game can happen)
  const tileCache = new Map();      // anchor k -> { ver, tile }
  let tileK = -1, omega = 0;        // current tile (anchor index) and the survivor's smoothed rotation about it
  let curTile = null, seenT = -99;  // that tile ({ c, r }) / when step() last ran (survivor in sight)
  let wasLoop = false, lastRollT = -99, wasVaulting = false;
  let mode = null;                  // null | { kind: 'rev', sgn, until } | { kind: 'stand', until, d0 }
  const stats = { loopTicks: 0, passes: 0, reversals: 0, standOffs: 0, revTicks: 0, revUnseenTicks: 0, standTicks: 0 };

  function tileOf(obs, k) {
    const ver = obs.pallets.join(',');
    const c = tileCache.get(k);
    if (c && c.ver === ver) return c.tile;
    const broken = (x) => { const a = loops.anchors[x >> 1]; return a.kind === 'p' && obs.pallets[a.i] === 'broken'; };
    let best = null, bf = -Infinity;
    for (const c0 of [2 * k, 2 * k + 1]) {
      for (const o of loops.circuitsFrom(c0)) {
        if (new Set(o.seq.map((x) => x >> 1)).size < 2 || o.seq.some(broken)) continue;   // a real loop, not a one-anchor hold
        if (o.fresh > bf) { bf = o.fresh; best = o; }
      }
    }
    let tile = null;
    if (best) {
      const pts = [];
      for (const c of best.seq) pts.push(loops.sidePt[c], loops.sidePt[c ^ 1]);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
      const r = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.z - cz), 0) / pts.length;
      tile = { c: { x: cx, z: cz }, r };
    }
    tileCache.set(k, { ver, tile });
    return tile;
  }

  // the survivor's position dt s ahead: its velocity, stepped 0.2 s at a time, sliding along walls (walkClear)
  function predict(api, s, dt) {
    let x = s.x, z = s.z;
    const vx = s.vx || 0, vz = s.vz || 0;
    if (Math.hypot(vx, vz) < 0.5) return { x, z };
    const n = Math.max(1, Math.ceil(dt / 0.2)), h = dt / n;
    for (let k = 0; k < n; k++) {
      const tries = [[vx * h, vz * h], [vx * h, 0], [0, vz * h]];
      let moved = false;
      for (const [dx, dz] of tries) {
        if (Math.abs(dx) + Math.abs(dz) < 1e-3) continue;
        const q = { x: x + dx, z: z + dz };
        if (api.walkClear({ x, z }, q)) { x = q.x; z = q.z; moved = true; break; }
      }
      if (!moved) break;
    }
    return { x, z };
  }

  // where to aim the chase move at: the survivor now, or its predicted position predictLeadS ahead
  function aim(api, s) {
    if (!(P.predictLeadS > 0.05) || s.vaulting) return { x: s.x, z: s.z };
    return predict(api, s, P.predictLeadS);
  }

  // a walkable point on the tile ring, from my angle around the centre in rotation sense dir (+1 / -1), whose path from
  // me is short (it really goes that way round, not the long way)
  function ringStep(api, me, t, dir) {
    const nav = api.nav;
    const phH = Math.atan2(me.z - t.c.z, me.x - t.c.x);
    const rho = Math.min(t.r + 4, Math.max(t.r * 0.8, Math.hypot(me.x - t.c.x, me.z - t.c.z)));
    for (let k = 3; k <= 8; k++) {
      const a = phH + dir * k * (Math.PI / 12);
      const pt = { x: t.c.x + Math.cos(a) * rho, z: t.c.z + Math.sin(a) * rho };
      const e = Math.hypot(pt.x - me.x, pt.z - me.z), d = nav.dist(me, pt);
      if (Number.isFinite(d) && d <= 1.5 * e + 2) return pt;
    }
    return null;
  }

  // called for the chased, visible survivor `s` at distance d when no attack / pallet break is due; returns an action
  // or null (then hunter.js moves to aim()).
  function step(obs, api, me, s, d) {
    if (!on) return null;
    if (!loops) loops = new LoopModel(ctx);
    seenT = obs.t;
    // the loop situation: s near an anchor whose best circuit is a real loop, both of us on / near that tile (a
    // committed mind game keeps its tile)
    let ak = tileK, t = curTile;
    if (!mode) {
      ak = -1; let ad = 7;
      for (const a of loops.anchors) {
        if (a.kind === 'p' && obs.pallets[a.i] === 'broken') continue;
        const dd = Math.hypot(a.c.x - s.x, a.c.z - s.z);
        if (dd < ad) { ad = dd; ak = a.k; }
      }
      t = ak >= 0 ? tileOf(obs, ak) : null;
    }
    const rS = t ? Math.hypot(s.x - t.c.x, s.z - t.c.z) : Infinity, rH = t ? Math.hypot(me.x - t.c.x, me.z - t.c.z) : Infinity;
    const loop = !!t && d < Math.max(16, 2 * t.r + 8) && rS < t.r + 4 && rH < t.r + 10;
    if (!loop && mode) stats.endLeft = (stats.endLeft || 0) + 1;
    if (!loop) { wasLoop = false; mode = null; tileK = -1; curTile = null; wasVaulting = !!s.vaulting; return null; }
    if (ak !== tileK) { tileK = ak; omega = 0; }
    curTile = t;
    // the survivor's rotation about the centre (rad/s; + = counter-clockwise in x/z), smoothed over decisions
    const w = ((s.x - t.c.x) * (s.vz || 0) - (s.z - t.c.z) * (s.vx || 0)) / Math.max(1, rS * rS);
    omega = 0.6 * omega + 0.4 * w;
    const sgn = omega >= 0 ? 1 : -1;
    const phS = Math.atan2(s.z - t.c.z, s.x - t.c.x), phH = Math.atan2(me.z - t.c.z, me.x - t.c.x);
    // angle from me to the survivor going AGAINST its rotation (a reversal meets it after this much of the ring)
    const headOn = angMod(sgn * (phH - phS));
    const vaultStart = !!s.vaulting && !wasVaulting;
    wasVaulting = !!s.vaulting;
    const newPass = (!wasLoop || vaultStart) && obs.t - lastRollT >= 2;
    wasLoop = true;
    stats.loopTicks++;

    if (mode && obs.t >= mode.until) mode = null;
    if (mode && mode.kind === 'rev') {
      // done: met it (small head-on angle), straight line open and close, or the survivor turned round too
      const flipped = Math.abs(omega) > 0.15 && sgn !== mode.sgn;
      const why = headOn < Math.PI / 4 ? 'endMet' : (d < 6 && api.walkClear(me, s)) ? 'endClear' : flipped ? 'endFlip' : null;
      if (why) { stats[why] = (stats[why] || 0) + 1; mode = null; }
    } else if (mode && mode.kind === 'stand') {
      if (s.vaulting || d > mode.d0 + 4 || d < 2.5) mode = null;
    }
    if (!mode && newPass && Math.abs(omega) > 0.1 && Math.hypot(s.vx || 0, s.vz || 0) > 1) {
      lastRollT = obs.t; stats.passes++;
      // reversal only pays when the survivor is well round the tile from me the way it runs (head-on angle > 90 deg)
      if (P.reverseChance > 0 && ctx.rng.next() < P.reverseChance && headOn > Math.PI / 2 && !api.walkClear(me, s)) {
        mode = { kind: 'rev', sgn, until: obs.t + 6 }; stats.reversals++;
      } else if (P.standOffChance > 0 && ctx.rng.next() < P.standOffChance && d > 3) {
        mode = { kind: 'stand', until: obs.t + P.standOffMaxS, d0: d, face: { x: s.x, z: s.z } }; stats.standOffs++;
      }
    }
    if (mode && mode.kind === 'rev') {
      const pt = ringStep(api, me, t, -mode.sgn);
      if (pt) { stats.revTicks++; return { moveTo: pt }; }
      stats.endNoRing = (stats.endNoRing || 0) + 1;
      mode = null;
    }
    if (mode && mode.kind === 'stand') { mode.face = { x: s.x, z: s.z }; stats.standTicks++; return { moveDir: { x: 0, z: 0 }, face: mode.face }; }
    return null;
  }

  // the survivor went out of sight (behind the tile -- a reversal runs away from where it was seen): keep the committed
  // reversal / stand-off going for up to 3 s unseen (within its own time limit); null = do the normal search
  function unseen(obs, api, me) {
    if (!mode || !curTile) return null;
    if (obs.t >= mode.until || obs.t - seenT > 3) { mode = null; return null; }
    if (mode.kind === 'stand') { stats.standTicks++; return { moveDir: { x: 0, z: 0 }, face: mode.face }; }
    const pt = ringStep(api, me, curTile, -mode.sgn);
    if (!pt) { mode = null; return null; }
    stats.revTicks++; stats.revUnseenTicks++;
    return { moveTo: pt };
  }

  return { step, unseen, aim, predict, stats, get mode() { return mode; } };
}
