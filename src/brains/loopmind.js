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
// Why these rarely paid (docs/research/hunter-window-play.md): a pass needs the survivor RUNNING round the tile
// (|omega| > 0.1, speed > 1), so neither ever fires at a window hold (the survivor stands still); a stand-off against a
// running survivor just gives up distance (it never vaults back into me: survivors only vault away from my side); and
// reversals are kill-neutral (reverseChance 1 vs 0, n=256: 3.29 vs 3.27; ~80 % of reversal ticks are out of sight,
// and evolved survivors read them: loopReverseDist ~9 m, loopReactS 0 in evo-v16), so the GA dropped them.
//
// Window holds (holdVaultP < 1; see the section below): the counter-play to a survivor standing at a window on the
// far side -- zone / fake / walk round instead of vaulting into it.
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
    if (holdOn) { const ha = holdStep(obs, api, me, s, d); if (ha) return ha; }
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
    if (holdOn && hold) { const ha = holdUnseen(obs, api, me); if (ha) return ha; }
    if (!mode || !curTile) return null;
    if (obs.t >= mode.until || obs.t - seenT > 3) { mode = null; return null; }
    if (mode.kind === 'stand') { stats.standTicks++; return { moveDir: { x: 0, z: 0 }, face: mode.face }; }
    const pt = ringStep(api, me, curTile, -mode.sgn);
    if (!pt) { mode = null; return null; }
    stats.revTicks++; stats.revUnseenTicks++;
    return { moveTo: pt };
  }

  // ================= window holds: the chased survivor waits at a window on the far side from me =================
  // It vaults away from whichever side I come round to; vaulting into it hands it my 1.7 s vault to run (diag-holds.js:
  // the old hunter did that in ~half the holds). Per hold episode one plan, drawn once (no RNG draw at all while
  // holdVaultP is 1 = the old behaviour, bit-identical):
  //   vault  (holdVaultP)            path straight at it (the engine vaults the window) -- the old behaviour;
  //   zone   (holdZoneP of the rest) stand on my side holdDepthM out from the window and zoneW along the wall toward the
  //                                  shorter way round: a vault toward me lands in my reach (so it won't), and if it runs
  //                                  off on its side I'm already part-way round;
  //   fake   (holdFakeP of the rest) walk round (same detour cap) for holdFakeFrac of the detour, then come back to the
  //                                  zone spot (a survivor that commits to the vault-back as I come round lands by me);
  //   around (the rest)              walk round the shorter way, never through the window (detour <= holdAroundMaxM, else
  //                                  zone): it has to vault toward my old side (a medium vault from standing; it counts
  //                                  toward the entity blocker) or be hit.
  // After holdPatienceS on a plan that has not ended the hold, holdThen picks: < 1/3 vault (old behaviour); < 2/3 walk
  // round (once; holdPatienceS or the walk + 1 s; detour cap as above, else vault); else break the chase off (hunter.js
  // ignores this survivor for 10 s). Legit info only: the survivor seen standing at the window, the static map.
  const W0 = M.windows || [];
  const holdOn = P.holdVaultP < 1;
  let hold = null;                  // { wi, sid, plan, t0, seenT, sgnS, D0, zone, fakeBack, done, last: {x, z} (last seen) }
  const aroundF = new Map();        // side index (2 wi + (u > 0)) -> Int32Array walk distance (x10 m, -1 = unreached)
  Object.assign(stats, { holds: 0, hVault: 0, hZone: 0, hFake: 0, hAround: 0, hTicks: 0, hUnseenTicks: 0, hPatience: 0, hBreak: 0,
    hThenAround: 0, hTooFar: 0, hEndSide: 0, hEndMoved: 0, hEndVault: 0, hEndLost: 0 });
  const winGeo = (wi) => {
    const w = W0[wi], c = { x: w.x + 0.5, z: w.z + 0.5 }, ax = w.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
    return { c, u: (p) => (p.x - c.x) * ax.x + (p.z - c.z) * ax.z, l: (p) => -(p.x - c.x) * ax.z + (p.z - c.z) * ax.x,
      at: (u, l) => ({ x: c.x + ax.x * u - ax.z * l, z: c.z + ax.z * u + ax.x * l }) };
  };
  // walk distance field (all anchors solid: never through a window / pallet) to window wi's side point at sign sg
  // (anchor k = wi: LoopModel lists the windows first; side 0 is at u = -1.6, side 1 at u = +1.6)
  function fieldTo(wi, sg) {
    const key = 2 * wi + (sg > 0 ? 1 : 0);
    let f = aroundF.get(key);
    if (f) return f;
    const Wd = loops.W, Hd = loops.H, solid = loops.solid;
    f = new Int32Array(Wd * Hd).fill(-1);
    aroundF.set(key, f);
    const c0 = loops.sideCell[key];
    if (c0 < 0) return f;
    const R = 600, buckets = [[c0]]; f[c0] = 0;
    for (let b = 0; b < buckets.length && b <= R; b++) {
      const bk = buckets[b]; if (!bk) continue;
      for (let q = 0; q < bk.length; q++) {
        const c = bk[q]; if (f[c] !== b) continue;
        const i = c % Wd, j = (c / Wd) | 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= Wd || nj >= Hd) continue;
          const n = nj * Wd + ni;
          if (solid[n] || (di && dj && (solid[j * Wd + ni] || solid[nj * Wd + i]))) continue;
          const nd = b + (di && dj ? 14 : 10);
          if (nd > R || (f[n] >= 0 && f[n] <= nd)) continue;
          f[n] = nd;
          (buckets[nd] || (buckets[nd] = [])).push(n);
        }
      }
    }
    return f;
  }
  // p's cell in field f, or the best reached neighbour (p may stand on a cell the anchor grid calls solid: an up pallet)
  function cellIn(f, p) {
    const Wd = loops.W, i0 = Math.floor(p.x), j0 = Math.floor(p.z);
    let best = -1, bv = Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= Wd || j >= loops.H) continue;
      const c = j * Wd + i, v = f[c];
      if (v < 0) continue;
      const vv = v + ((di || dj) ? 10 : 0);
      if (vv < bv) { bv = vv; best = c; }
    }
    return { c: best, v: bv };
  }
  const fieldM = (f, p) => { const r = cellIn(f, p); return r.c < 0 ? Infinity : r.v / 10; };
  // next point to walk to along field f: descent, string-pulled to the farthest cell reachable in a straight line
  function descend(api, f, me) {
    const Wd = loops.W, solid = loops.solid;
    let c = cellIn(f, me).c;
    if (c < 0) return null;
    const path = [c];
    for (let k = 0; k < 14 && f[c] > 0; k++) {
      const i = c % Wd, j = (c / Wd) | 0;
      let bn = -1, bv = f[c];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= Wd || nj >= loops.H) continue;
        const n = nj * Wd + ni;
        if (f[n] < 0 || (di && dj && (solid[j * Wd + ni] || solid[nj * Wd + i]))) continue;
        if (f[n] < bv) { bv = f[n]; bn = n; }
      }
      if (bn < 0) break;
      c = bn; path.push(c);
    }
    const ctr = (cc) => ({ x: cc % Wd + 0.5, z: ((cc / Wd) | 0) + 0.5 });
    for (let k = path.length - 1; k >= 1; k--) { const pt = ctr(path[k]); if (api.walkClear(me, pt)) return pt; }
    return ctr(path[Math.min(1, path.length - 1)]);
  }
  // the zone spot: my side, holdDepthM out, zoneW along the wall toward the shorter way round (shrunk until walkable)
  function zoneSpot(api, me, G, sgnMe, f) {
    let side = 0;
    if (P.zoneW > 0.05) {
      const da = fieldM(f, G.at(sgnMe * P.holdDepthM, P.zoneW)), db = fieldM(f, G.at(sgnMe * P.holdDepthM, -P.zoneW));
      side = da < db ? 1 : db < da ? -1 : (G.l(me) >= 0 ? 1 : -1);
    }
    for (let k = 0; k <= 4; k++) {
      const z = G.at(sgnMe * P.holdDepthM, side * P.zoneW * (1 - k / 4));
      if (cellIn(f, z).c >= 0 && Number.isFinite(api.nav.dist(me, z))) return z;
    }
    return G.at(sgnMe * 1.6, 0);
  }
  function endHold(why) { stats[why]++; hold = null; }

  function holdStep(obs, api, me, s, d) {
    const spd = Math.hypot(s.vx || 0, s.vz || 0);
    if (hold && obs.t - hold.seenT > 3.5) hold = null;   // stale (the chase moved on while it was out of sight)
    if (hold) {
      const G = winGeo(hold.wi), us = G.u(s), um = G.u(me);
      if (hold.sid !== s.id) endHold('hEndLost');
      else if (s.vaulting) endHold('hEndVault');
      else if (Math.sign(um) === Math.sign(us) && Math.abs(um) > 0.6) endHold('hEndSide');
      else if (Math.hypot(us, G.l(s)) > 3.6 || spd > 2.5 || Math.sign(us) !== hold.sgnS) endHold('hEndMoved');
      else if (hold.done) return null;     // patience ran out on this hold: the old behaviour until it ends
    }
    if (!hold) {
      // a hold: s (seen now) standing still in front of a window, me on the other side, not too far off
      if (s.vaulting || spd > 1.0 || d > 16 || !(s.state === 'healthy' || s.state === 'injured')) return null;
      let wi = -1, bd = 3.0;
      for (let i = 0; i < W0.length; i++) {
        const G = winGeo(i), us = G.u(s), ls = G.l(s);
        if (Math.abs(ls) > 1.2 || Math.abs(us) < 0.7 || Math.abs(us) > 3.0) continue;
        const um = G.u(me);
        if (Math.sign(um) === Math.sign(us) || Math.abs(um) < 0.6) continue;
        const dd = Math.hypot(us, ls);
        if (dd < bd) { bd = dd; wi = i; }
      }
      if (wi < 0) return null;
      if (!loops) loops = new LoopModel(ctx);
      const sgnS = Math.sign(winGeo(wi).u(s));
      hold = { wi, sid: s.id, plan: 'vault', t0: obs.t, seenT: obs.t, sgnS, D0: 0, zone: null, fakeBack: false, done: false };
      stats.holds++;
      const r = ctx.rng.next();
      if (r >= P.holdVaultP) {
        const r2 = (r - P.holdVaultP) / (1 - P.holdVaultP);
        hold.plan = r2 < P.holdZoneP ? 'zone' : r2 < P.holdZoneP + (1 - P.holdZoneP) * P.holdFakeP ? 'fake' : 'around';
        if (hold.plan !== 'zone') {
          hold.D0 = fieldM(fieldTo(wi, sgnS), me);
          if (!(hold.D0 <= P.holdAroundMaxM)) { hold.plan = 'zone'; stats.hTooFar++; }   // too far round: zone instead
        }
      }
      stats[{ vault: 'hVault', zone: 'hZone', fake: 'hFake', around: 'hAround' }[hold.plan]]++;
    }
    hold.seenT = obs.t; hold.last = { x: s.x, z: s.z };
    return holdAct(obs, api, me, s);
  }

  function holdAct(obs, api, me, s) {
    const H = hold;
    if (H.plan === 'vault') return null;
    if (obs.t - H.t0 > (H.then ? Math.max(P.holdPatienceS, H.D0 / 4 + 1) : P.holdPatienceS)) {
      stats.hPatience++;
      if (P.holdThen >= 2 / 3) { stats.hBreak++; hold = null; return { breakOff: true }; }
      if (P.holdThen >= 1 / 3 && !H.then && H.plan !== 'around') {
        H.then = true; H.t0 = obs.t;
        H.D0 = fieldM(fieldTo(H.wi, H.sgnS), me);
        if (H.D0 <= P.holdAroundMaxM) { H.plan = 'around'; stats.hThenAround++; return holdAct(obs, api, me, s); }
      }
      H.done = true; return null;
    }
    stats.hTicks++;
    const G = winGeo(H.wi), f = fieldTo(H.wi, H.sgnS);
    if (H.plan === 'fake' && !H.fakeBack && fieldM(f, me) <= (1 - P.holdFakeFrac) * H.D0) H.fakeBack = true;
    if (H.plan === 'around' || (H.plan === 'fake' && !H.fakeBack)) {
      const pt = descend(api, f, me);
      if (pt) return { moveTo: pt, face: H.last };      // keep it in view while I go round
      H.done = true; return null;
    }
    if (!H.zone) H.zone = zoneSpot(api, me, G, -H.sgnS, f);
    const face = s ? { x: s.x, z: s.z } : G.c;
    if (Math.hypot(me.x - H.zone.x, me.z - H.zone.z) > 0.5) return { moveTo: H.zone, face };
    return { moveDir: { x: 0, z: 0 }, face };
  }

  // out of sight during a hold plan (walking round puts the wall between us): keep it going for up to 3 s
  function holdUnseen(obs, api, me) {
    if (hold.done || hold.plan === 'vault' || obs.t - hold.seenT > 3) { hold = null; return null; }
    const um = winGeo(hold.wi).u(me);   // round on its side and it's gone: the normal search takes over
    if (Math.sign(um) === hold.sgnS && Math.abs(um) > 0.6) { endHold('hEndSide'); return null; }
    stats.hUnseenTicks++;
    return holdAct(obs, api, me, null);
  }

  return { step, unseen, aim, predict, stats, get mode() { return mode; },
    get still() { return !!(hold && !hold.done && hold.zone); }, get hold() { return hold; } };
}
