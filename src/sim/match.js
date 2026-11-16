// The match engine: state, perception/observations, actions and rules. See README.md for the full contract.
// Zero dependencies, no Node-only APIs.

import { mergeConfig, deepFreeze } from './config.js';
import { makeRng } from './rng.js';
import { prepareMap, K_SOLID, K_WIN_X, K_WIN_Z, K_PAL_X, K_PAL_Z } from './mapdata.js';
import { rayVis } from './sight.js';
import { NavView, getShared, circleFree } from './nav.js';

const S_HEALTHY = 0, S_INJURED = 1, S_DOWNED = 2, S_CARRIED = 3, S_HOOKED = 4, S_DEAD = 5, S_ESCAPED = 6;
const S_NAME = ['healthy', 'injured', 'downed', 'carried', 'hooked', 'dead', 'escaped'];
const PAL_NAME = ['up', 'dropped', 'broken'];
const ACT_CODE = { repair: 1, heal: 2, rescue: 3, dropPallet: 4, openGate: 5, wiggle: 6, vault: 7, mend: 8 };
const CONSPICUOUS = { repair: 1, heal: 1, rescue: 1, openGate: 1 };   // end unhook protections (mend / dropPallet do not)
const EPS = 1e-6;
const FRAC = [0.5, 0.25, 0.1];
const IDLE = Object.freeze({});
const DEG = Math.PI / 180;

function rectDist2(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return dx * dx + dz * dz;
}
function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return Math.sqrt(dx * dx + dz * dz);
}
const hyp = (a, b) => Math.sqrt(a * a + b * b);   // Math.hypot is slow in V8
const r2 = v => Math.round(v * 100) / 100;

export class Match {
  constructor(opts) {
    if (!opts || !opts.map) throw new Error('createMatch: opts.map required');
    const cfg = this.cfg = mergeConfig(opts.config);
    const md = this.md = prepareMap(opts.map);
    this.seed = opts.seed ?? 1;
    this.world = makeRng(this.seed, 'world');
    this.dt = 1 / cfg.tickHz;
    this.maxTicks = Math.round(cfg.maxMatchS * cfg.tickHz);
    this.tick = 0; this.t = 0; this.over = false;
    this.W = md.w; this.Hh = md.h; this.R = cfg.radius;
    this.coll = md.coll0.slice();
    this.ps = new Uint8Array(md.pallets.length);   // 0 up, 1 dropped, 2 broken
    // window blocking: too many survivor vaults through one window in a short time blocks it for survivors
    this.winVaults = md.windows.map(() => [[], [], [], []]);
    this.winBlockT = new Float64Array(md.windows.length * 4); // [window * 4 + survivor]
    this.winOfCell = new Map(md.windows.map((w, i) => [w.cell, i]));
    this.palVersion = 0; this.droppedCount = 0;
    this.shared = getShared(md, cfg);
    this.events = [];
    this.recordOn = !!opts.record;
    this.frames = [];
    this._prevP = null;
    this.stats = { hits: 0, downs: 0, hooks: 0, pickups: 0, stuns: 0, palletsDropped: 0, palletsBroken: 0, vaults: 0, wiggles: 0, rescues: 0, heals: 0, fumbles: 0, missed: 0 };
    this._wp = { x: 0, z: 0 };
    this._sdx = 0; this._sdz = 0;

    // ---- generators (7 of the candidates, seeded) ----
    const cands = md.genCands;
    const order = cands.map((_, i) => i);
    this.world.shuffle(order);
    const chosen = order.slice(0, Math.min(cfg.gens.placed, cands.length)).sort((a, b) => a - b);
    this.gens = chosen.map((ci, gi) => {
      const c = cands[ci];
      return { idx: gi, ci, id: c.id, x: c.x, z: c.z, i: c.i, j: c.j, x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1,
        p: 0, done: false, regress: false, nWork: 0, wIds: [-1, -1, -1, -1], lastN: 0 };
    });
    this.genById = new Map(this.gens.map(g => [g.id, g]));
    this.gensDone = 0;
    this.gensNeeded = Math.min(cfg.gens.needed, this.gens.length);
    this.need = cfg.gens.repairS;

    this.hooks = md.hooks.map((h, i) => ({ idx: i, id: h.id, x: h.x, z: h.z, occ: -1 }));
    this.gates = md.gates.map((g, i) => ({ idx: i, id: g.id, lx: g.lever.x, lz: g.lever.z, ex: g.exit.x, ez: g.exit.z, prog: 0, open: false, user: -1, userTick: -2 }));
    this.gatesPowered = false; this.endgameT = -1;
    this.palletById = new Map(md.pallets.map(p => [p.id, p]));

    // ---- actors ----
    const rs = this.world;
    const { hunter: hs, survivors: spawns } = this._chooseSpawns(rs);
    const G = this.gens.length, P = md.pallets.length;
    this.hunter = {
      role: 'hunter', id: 'hunter', x: hs.x, z: hs.z, vx: 0, vz: 0, face: Math.atan2(this.Hh / 2 - hs.z, this.W / 2 - hs.x),
      carrying: -1, cdT: 0, cdSpeed: 1, windT: 0, stunT: 0, vault: null, prog: 0, curAct: null, curTgt: null,
      seen: [false, false, false, false], gSeen: new Uint8Array(G), lastSeen: [null, null, null, null], visMarks: [],
      grunts: [], inbox: [], inboxRead: 0, lastAction: IDLE, nav: null, brain: null, api: null, ctx: null, spawn: hs,
    };
    this.survivors = [];
    for (let i = 0; i < 4; i++) {
      this.survivors.push({
        role: 'survivor', id: i, x: spawns[i].x, z: spawns[i].z, vx: 0, vz: 0, face: rs.range(-Math.PI, Math.PI),
        st: S_HEALTHY, boostT: 0, runD: 0, runDx: 0, runDz: 0, protT: 0, endure: false, dwT: -1, mendP: 0, hookCount: 0, hookStage: 0, hookTimer: 0, hookIdx: -1, resolve: 0, campT: 0, outT: 0, graceT: 0, selfT: -1, bleedT: 0, heal: 0, wiggle: 0,
        vault: null, curAct: null, curTgt: null, prog: 0, gruntT: 0, scratchT: 0, outcome: null, cause: null, tOut: -1, repairS: 0, repairC: 0, leverS: 0,
        seesHunter: false, trLayer: 0, trPend: 0, trPendT: 0, seesMate: [false, false, false, false], gSeen: new Uint8Array(G), pSeen: new Uint8Array(P),
        mem: { lastHunter: null, lastSeen: [null, null, null, null], gens: this.gens.map(() => ({ progress: 0, done: false, workers: null, seenT: -1 })), pal: new Uint8Array(P) },
        inbox: [], inboxRead: 0, lastAction: IDLE, nav: null, brain: null, api: null, ctx: null, spawn: spawns[i],
      });
    }
    this.marks = [];
    this.chaseTgt = -1; this.chaseSeenT = 0;      // engine-level chase state (config.chase): at most one chased survivor
    this._hudTick = -1; this._hudB = null; this._downB = null;   // per-tick HUD cache shared by all survivor obs

    // ---- brains ----
    const mapInfoBase = {
      ...md.info,
      generators: Object.freeze(this.gens.map(g => Object.freeze({ id: g.id, x: g.x, z: g.z }))),
      gensNeeded: this.gensNeeded,
    };
    const sf = opts.survivors;
    const factories = Array.isArray(sf) ? sf : [sf, sf, sf, sf];
    this._mkAgent(this.hunter, 'hunter', mapInfoBase, opts.hunter);
    for (let i = 0; i < 4; i++) this._mkAgent(this.survivors[i], 'survivor', mapInfoBase, factories[i]);

    this.ev('start', { seed: this.seed, gens: this.gens.map(g => g.id) });
    if (this.recordOn) this._record();
  }

  // Spawns: survivors grouped around a seeded anchor (map.spawns.survivors = anchor candidates), hunter on the far side.
  _chooseSpawns(rs) {
    const md = this.md, sc = this.cfg.spawn, W = this.W, Hh = this.Hh, kind = md.kind, R = this.R;
    const cellOf = (x, z) => Math.floor(z) * W + Math.floor(x);
    const free = (x, z) => x > 0 && z > 0 && x < W && z < Hh && kind[cellOf(x, z)] === 0 && circleFree(this.coll, W, Hh, x, z, R);
    // inset test against the outline polygon
    const ol = md.info.outline || [[0, 0], [W, 0], [W, Hh], [0, Hh]];
    const edgeDist = (x, z) => {
      let best = Infinity;
      for (let i = 0, j = ol.length - 1; i < ol.length; j = i++) {
        const ax = ol[j][0], az = ol[j][1], bx = ol[i][0], bz = ol[i][1], ex = bx - ax, ez = bz - az;
        const L = ex * ex + ez * ez, u = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L)) : 0;
        const dx = ax + u * ex - x, dz = az + u * ez - z, d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    let freeCells = null;
    const allFree = () => {
      if (!freeCells) { freeCells = []; for (let c = 0; c < md.N; c++) { const x = (c % W) + 0.5, z = Math.floor(c / W) + 0.5; if (free(x, z)) freeCells.push(c); } }
      return freeCells;
    };
    // anchor
    const anchors = md.spawns.survivors.filter(p => free(p.x, p.z));
    let anchor;
    if (anchors.length) { const p = anchors[rs.int(anchors.length)]; anchor = { x: p.x, z: p.z }; }
    else {
      const ins = allFree().filter(c => edgeDist((c % W) + 0.5, Math.floor(c / W) + 0.5) >= sc.edgeInset);
      const pool = ins.length ? ins : allFree();
      const c = pool[rs.int(pool.length)]; anchor = { x: (c % W) + 0.5, z: Math.floor(c / W) + 0.5 };
    }
    const field = this.shared.computeField(cellOf(anchor.x, anchor.z), null, 0);   // mm, path distance from the anchor
    const pd = (x, z) => field[cellOf(x, z)] / 1000;
    // survivors: anchor first, then map candidates nearest the anchor, then random walkable cells within the radius
    const gr = sc.groupRadius, minSep = 1.5;
    const surv = [anchor];
    const fits = (x, z) => {
      if (!free(x, z) || !(pd(x, z) <= gr)) return false;
      for (const q of surv) { const d = hyp(q.x - x, q.z - z); if (d < minSep || d > gr) return false; }
      return true;
    };
    const near = md.spawns.survivors.filter(p => !(p.x === anchor.x && p.z === anchor.z))
      .map(p => ({ x: p.x, z: p.z, d: pd(p.x, p.z) })).filter(p => p.d <= gr)
      .sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
    for (const p of near) { if (surv.length >= 4) break; if (fits(p.x, p.z)) surv.push({ x: p.x, z: p.z }); }
    if (surv.length < 4) {
      const pool = allFree().filter(c => field[c] / 1000 <= gr);
      rs.shuffle(pool);
      for (const c of pool) {
        if (surv.length >= 4) break;
        const x = (c % W) + 0.5, z = Math.floor(c / W) + 0.5;
        if (fits(x, z)) surv.push({ x, z });
      }
    }
    while (surv.length < 4) surv.push({ x: anchor.x, z: anchor.z });   // degenerate map: stack on the anchor
    // hunter: reference = farthest (path) walkable cell at least edgeInset inside the outline
    let far = null, farD = -1;
    for (const c of allFree()) {
      const d = field[c];
      if (!(d < Infinity) || d <= farD) continue;
      const x = (c % W) + 0.5, z = Math.floor(c / W) + 0.5;
      if (edgeDist(x, z) < sc.edgeInset) continue;
      far = { x, z }; farD = d;
    }
    const thr = sc.hunterMinFrac * farD / 1000;
    const elig = md.spawns.hunter.filter(p => free(p.x, p.z) && pd(p.x, p.z) < Infinity && pd(p.x, p.z) >= thr);
    let hunter;
    if (elig.length) { const p = elig[rs.int(elig.length)]; hunter = { x: p.x, z: p.z }; }
    else if (far) hunter = far;
    else { const p = md.spawns.hunter[0] || anchor; hunter = { x: p.x, z: p.z }; }
    return { hunter, survivors: surv };
  }

  _mkAgent(a, role, mapInfoBase, factory) {
    if (typeof factory !== 'function') throw new Error(`createMatch: brain factory for ${role} ${a.id} missing`);
    const nav = a.nav = new NavView(this.shared, this, role);
    const m = this;
    const api = a.api = {
      role, id: a.id, dt: this.dt, nav,
      visibility(p, q) { return rayVis(m.md, p.x, p.z, q.x, q.z, m.cfg.sight.semiTransparency, 0); },
      los(p, q) { return rayVis(m.md, p.x, p.z, q.x, q.z, m.cfg.sight.semiTransparency, m.cfg.sight.visThreshold) >= m.cfg.sight.visThreshold; },
      walkClear(p, q) { return nav.walkClear(p.x, p.z, q.x, q.z); },
      cellOf(x, z) { return nav.cell(x, z); },
    };
    const ctx = a.ctx = {
      id: a.id, role, map: { ...mapInfoBase }, config: this.cfg, rng: makeRng(this.seed, 'agent:' + role + ':' + a.id),
      spawn: { x: a.spawn.x, z: a.spawn.z }, nav, api,
    };
    a.brain = factory(ctx);
    if (!a.brain || typeof a.brain.decide !== 'function') throw new Error(`brain factory for ${role} ${a.id} must return { decide }`);
  }

  // ------------------------------------------------------------------ utilities
  ev(type, f) {
    if (!this.cfg.recordEvents) return;
    const e = { t: r2(this.t), type };
    if (f) for (const k in f) e[k] = f[k];
    this.events.push(e);
  }
  inGame(s) { return s.st < S_DEAD; }
  inGameCount() { let n = 0; for (const s of this.survivors) if (s.st < S_DEAD) n++; return n; }

  _notify(a, n) { a.inbox.push(n); }
  _notifyAllSurvivors(n) { for (const s of this.survivors) if (s.st < S_DEAD) s.inbox.push({ ...n }); }
  _notifyMates(who, n) { for (const s of this.survivors) if (s !== who && s.st < S_DEAD) s.inbox.push({ ...n }); }

  // ------------------------------------------------------------------ chase state (config.chase; rules assumed, see README)
  // Starts when the hunter currently sees a standing survivor within startRange and either moves toward them
  // (velocity component toward them > approachSpeed) or is winding up / swinging with them inside the attack arc.
  // Ends when the hunter hasn't seen the target for loseS, or the target is downed/carried/hooked/out. At most one
  // chased survivor: a different survivor meeting the start rule takes over (the most recent chase), unless the
  // current target meets it too; several new candidates in one tick => the nearest.
  _updateChase() {
    const cc = this.cfg.chase;
    if (!cc) return;
    const H = this.hunter, S = this.survivors, t = this.t;
    let cur = this.chaseTgt;
    if (cur >= 0) {
      const s = S[cur];
      if (s.st > S_INJURED) { this.ev('chaseEnd', { who: cur, reason: S_NAME[s.st] }); cur = -1; }
      else if (H.seen[cur]) this.chaseSeenT = t;
      else if (t - this.chaseSeenT >= cc.loseS - EPS) { this.ev('chaseEnd', { who: cur, reason: 'lost' }); cur = -1; }
    }
    if (H.carrying >= 0) {   // a carrying hunter is never in a chase
      if (cur >= 0) { this.ev('chaseEnd', { who: cur, reason: 'carrying' }); cur = -1; }
      this.chaseTgt = cur;
      return;
    }
    const attacking = H.windT > 0 || H.curAct === 'attack';
    const fx = Math.cos(H.face), fz = Math.sin(H.face), cosArc = Math.cos(this.cfg.hunter.attackHalfArcDeg * DEG);
    const r2 = cc.startRange * cc.startRange;
    let best = -1, bd = Infinity, curOk = false;
    for (let i = 0; i < 4; i++) {
      const s = S[i];
      if (!H.seen[i] || s.st > S_INJURED) continue;
      const dx = s.x - H.x, dz = s.z - H.z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const toward = d > 0.05 && (H.vx * dx + H.vz * dz) > cc.approachSpeed * d;
      const swing = attacking && (d <= 0.05 || (dx * fx + dz * fz) >= d * cosArc);
      if (!toward && !swing) continue;
      if (i === cur) { curOk = true; break; }
      if (d < bd) { bd = d; best = i; }
    }
    if (!curOk && best >= 0) {
      if (cur >= 0) this.ev('chaseEnd', { who: cur, reason: 'switch' });
      cur = best; this.chaseSeenT = t;
      this.ev('chaseStart', { who: best });
    }
    this.chaseTgt = cur;
  }

  // ------------------------------------------------------------------ survivor HUD (computed once per tick, copied per survivor)
  _hudBase() {
    if (this._hudTick === this.tick) return;
    this._hudTick = this.tick;
    const S = this.survivors;
    const b = this._hudB || (this._hudB = S.map(s => ({ id: s.id })));
    for (const e of b) e.beingHealed = false;
    for (let i = 0; i < 4; i++) {
      const s = S[i], e = b[i], up = s.st <= S_INJURED;   // curAct is stale for dead/escaped survivors
      e.state = S_NAME[s.st]; e.hookCount = s.hookCount; e.hookStage = s.st === S_HOOKED ? s.hookStage : 0;
      e.healing = up && s.curAct === 'heal';
      e.repairing = up && s.curAct === 'repair' ? s.curTgt : null;
      e.chased = this.chaseTgt === i;
      if (e.healing && typeof s.curTgt === 'number') b[s.curTgt].beingHealed = true;
    }
    const dn = this._downB = [];
    for (const s of S) if (s.st === S_DOWNED) dn.push(s);
  }

  // ------------------------------------------------------------------ perception
  _perceive() {
    const cfg = this.cfg, sc = cfg.sight, md = this.md, tick = this.tick;
    const H = this.hunter, S = this.survivors;
    const range2 = sc.range * sc.range, thr = sc.visThreshold, semi = sc.semiTransparency;
    if (tick % sc.perceptionEvery === 0) {
      const hfx = Math.cos(H.face), hfz = Math.sin(H.face);
      const cosH = Math.cos(sc.hunterFovDeg * 0.5 * DEG);
      for (let i = 0; i < 4; i++) {
        const s = S[i];
        H.seen[i] = false; s.seesHunter = false;
        const sm = s.seesMate; sm[0] = sm[1] = sm[2] = sm[3] = false;
      }
      for (let i = 0; i < 4; i++) {
        const s = S[i];
        if (s.st >= S_DEAD) continue;
        const dx = s.x - H.x, dz = s.z - H.z, d2 = dx * dx + dz * dz;
        if (d2 <= range2) {
          const vis = rayVis(md, H.x, H.z, s.x, s.z, semi, thr);
          if (vis >= thr) {
            s.seesHunter = true;                     // survivors are 360 deg
            if (d2 < 1e-6 || (dx * hfx + dz * hfz) >= Math.sqrt(d2) * cosH) H.seen[i] = true;
          }
        }
        for (let j = i + 1; j < 4; j++) {
          const o = S[j];
          if (o.st >= S_DEAD) continue;
          const ex = o.x - s.x, ez = o.z - s.z;
          if (ex * ex + ez * ez > range2) continue;
          if (rayVis(md, s.x, s.z, o.x, o.z, semi, thr) >= thr) { s.seesMate[j] = true; o.seesMate[i] = true; }
        }
      }
      // hunter: scratch marks in cone
      const mem = cfg.senses.scratchMemoryS, rng2 = cfg.senses.scratchRange * cfg.senses.scratchRange;
      if (this.marks.length) {
        let k = 0;
        while (k < this.marks.length && this.t - this.marks[k].t > mem) k++;
        if (k) this.marks.splice(0, k);
      }
      const vm = [];
      for (const m of this.marks) {
        const dx = m.x - H.x, dz = m.z - H.z, d2 = dx * dx + dz * dz;
        if (d2 > rng2) continue;
        if (d2 > 1e-6 && (dx * hfx + dz * hfz) < Math.sqrt(d2) * cosH) continue;
        if (rayVis(md, H.x, H.z, m.x, m.z, semi, thr) >= thr) vm.push(m);
      }
      H.visMarks = vm;
      // hunter: generators in cone (cell visibility mask + cone test)
      const hm = this._featMask(H.x, H.z);
      for (let g = 0; g < this.gens.length; g++) {
        const ge = this.gens[g], gx = ge.x - H.x, gz = ge.z - H.z, d2 = gx * gx + gz * gz;
        H.gSeen[g] = (hm !== null && ((hm.g >>> ge.ci) & 1) === 1 && (d2 < 1e-6 || (gx * hfx + gz * hfz) >= Math.sqrt(d2) * cosH)) ? 1 : 0;
      }
    }
    // survivors: generators / pallets (static geometry => per-cell cached visibility bitmasks, shared across matches)
    for (let i = 0; i < 4; i++) {
      const s = S[i];
      if (s.st >= S_DEAD || (tick + i) % sc.staticPerceptionEvery !== 0) continue;
      const fm = this._featMask(s.x, s.z);
      if (fm === null) continue;
      const gm = fm.g, pm = fm.p;
      for (let g = 0; g < this.gens.length; g++) s.gSeen[g] = (gm >>> this.gens[g].ci) & 1;
      for (let p = 0; p < s.pSeen.length; p++) s.pSeen[p] = (pm >>> p) & 1;
    }
  }

  // Which generator candidates / pallets are visible from the centre of the cell containing (x,z). Pure function of
  // (map, sight config, cell) so it is cached on the prepared map and shared by all matches. null if the map has
  // more than 32 candidates or pallets (not expected).
  _featMask(x, z) {
    const md = this.md;
    let cache = this._fmCache;
    if (cache === undefined) {
      const sc0 = this.cfg.sight;
      if (md.genCands.length > 32 || md.pallets.length > 32) cache = null;
      else {
        const key = sc0.semiTransparency + '|' + sc0.visThreshold + '|' + sc0.range;
        cache = md.featCache;
        if (!cache || cache.key !== key) cache = md.featCache = { key, cells: new Array(md.N).fill(null) };
      }
      this._fmCache = cache;
    }
    if (cache === null) return null;
    const i = Math.floor(x), j = Math.floor(z), c = j * md.w + i;
    if (i < 0 || j < 0 || i >= md.w || j >= md.h) return null;
    let e = cache.cells[c];
    if (e === null) {
      const sc = this.cfg.sight;
      const cx = i + 0.5, cz = j + 0.5, r2 = sc.range * sc.range;
      let g = 0, p = 0;
      for (let k = 0; k < md.genCands.length; k++) {
        const ge = md.genCands[k], dx = ge.x - cx, dz = ge.z - cz;
        if (dx * dx + dz * dz <= r2 && rayVis(md, cx, cz, ge.x, ge.z, sc.semiTransparency, sc.visThreshold) >= sc.visThreshold) g |= (1 << k);
      }
      for (let k = 0; k < md.pallets.length; k++) {
        const pa = md.pallets[k], dx = pa.cx - cx, dz = pa.cz - cz;
        if (dx * dx + dz * dz <= r2 && rayVis(md, cx, cz, pa.cx, pa.cz, sc.semiTransparency, sc.visThreshold) >= sc.visThreshold) p |= (1 << k);
      }
      e = cache.cells[c] = { g: g >>> 0, p: p >>> 0 };
    }
    return e;
  }

  // ------------------------------------------------------------------ observations
  _palNames() {
    if (this._pnV !== this.palVersion) { this._pn = Array.from(this.ps, v => PAL_NAME[v]); this._pnV = this.palVersion; }
    return this._pn.slice();
  }

  // viewer: survivor object, the hunter, or null. Lever progress (0..1) is included only for an open gate (public) or a powered
  // gate whose lever the viewer perceives: survivors 360 deg / range / visibility or within sight.adjacentReach; hunter also needs its cone.
  _gatesObs(viewer) {
    const out = [], sc = this.cfg.sight, P = this.gatesPowered, leverS = this.cfg.gates.leverS;
    for (const g of this.gates) {
      const o = { id: g.id, powered: P, open: g.open };
      if (g.open) o.progress = 1;
      else if (P && viewer && this._seesLever(viewer, g, sc)) o.progress = Math.min(1, g.prog / leverS);
      out.push(o);
    }
    return out;
  }

  _seesLever(a, g, sc) {
    const dx = g.lx - a.x, dz = g.lz - a.z, d2 = dx * dx + dz * dz;
    if (d2 <= sc.adjacentReach * sc.adjacentReach) return true;
    if (d2 > sc.range * sc.range) return false;
    if (a === this.hunter && (dx * Math.cos(a.face) + dz * Math.sin(a.face)) < Math.sqrt(d2) * Math.cos(sc.hunterFovDeg * 0.5 * DEG)) return false;
    return rayVis(this.md, a.x, a.z, g.lx, g.lz, sc.semiTransparency, sc.visThreshold) >= sc.visThreshold;
  }

  _obsSurvivor(s) {
    const cfg = this.cfg, H = this.hunter, m = s.mem, sc = cfg.sight;
    const adj2 = sc.adjacentReach * sc.adjacentReach;
    const self = {
      id: s.id, x: s.x, z: s.z, vx: s.vx, vz: s.vz, facing: s.face, state: S_NAME[s.st],
      hookCount: s.hookCount, hookStage: s.st === S_HOOKED ? s.hookStage : 0, hookTimerS: s.st === S_HOOKED ? s.hookTimer : null,
      boosted: s.boostT > 0, vaulting: !!s.vault, act: s.curAct, progress: s.prog,
      bleedS: s.st === S_DOWNED ? s.bleedT : null, healProgress: s.heal / cfg.survivor.healS, wiggle: s.wiggle / cfg.survivor.wiggleS,
      deepWoundS: s.dwT >= 0 ? s.dwT : null, protectedS: s.protT > 0 ? s.protT : null, chased: this.chaseTgt === s.id,
    };
    this._hudBase();
    const hud = new Array(4), hb = this._hudB;
    for (let j = 0; j < 4; j++) {
      const e = hb[j];
      hud[j] = { id: e.id, state: e.state, hookCount: e.hookCount, hookStage: e.hookStage, beingHealed: e.beingHealed,
        healing: e.healing, repairing: e.repairing, chased: e.chased };
    }
    const downedAuras = [];
    for (const o of this._downB) if (o !== s) downedAuras.push({ id: o.id, x: o.x, z: o.z });
    let hunter = null;
    if (s.seesHunter) {
      hunter = { x: H.x, z: H.z, vx: H.vx, vz: H.vz, facing: H.face, fx: Math.cos(H.face), fz: Math.sin(H.face),
        carrying: H.carrying >= 0, windup: H.windT > 0, cooldown: H.cdT > 0, stunned: H.stunT > 0 };
      m.lastHunter = { x: H.x, z: H.z, vx: H.vx, vz: H.vz, facing: H.face, t: this.t };
    }
    const dh = hyp(H.x - s.x, H.z - s.z);
    const teammates = [];
    for (let j = 0; j < 4; j++) {
      if (j === s.id) continue;
      const o = this.survivors[j];
      if (!s.seesMate[j] || o.st >= S_DEAD) continue;
      teammates.push({ id: j, x: o.x, z: o.z, vx: o.vx, vz: o.vz, facing: o.face, state: S_NAME[o.st] });
      m.lastSeen[j] = { x: o.x, z: o.z, state: S_NAME[o.st], t: this.t };
    }
    const gens = [];
    for (let g = 0; g < this.gens.length; g++) {
      const ge = this.gens[g], me = m.gens[g];
      const vis = !ge.done && (s.gSeen[g] === 1 || rectDist2(s.x, s.z, ge.x0, ge.z0, ge.x1, ge.z1) <= adj2);
      if (vis) { me.progress = ge.p / this.need; me.seenT = this.t; me.workers = ge.wIds.slice(0, ge.lastN); }
      gens.push({ id: ge.id, x: ge.x, z: ge.z, progress: me.done ? 1 : me.progress, done: me.done, blocked: this.gatesPowered && !ge.done, regressing: vis ? ge.regress : null, visible: vis, workers: vis ? me.workers : null, seenT: me.seenT });
    }
    const pals = [];
    const pd = this.md.pallets;
    for (let p = 0; p < pd.length; p++) {
      const pa = pd[p];
      if (s.pSeen[p] === 1 || (Math.abs(pa.cx - s.x) < 5 && Math.abs(pa.cz - s.z) < 5 && rectDist2(s.x, s.z, pa.x0, pa.z0, pa.x1, pa.z1) <= adj2)) m.pal[p] = this.ps[p];
      pals.push(PAL_NAME[m.pal[p]]);
    }
    const inbox = s.inbox;
    const newN = inbox.slice(s.inboxRead); s.inboxRead = inbox.length;
    return {
      t: this.t, tick: this.tick, self, hunter, lastHunter: m.lastHunter,
      terror: s.trLayer > 0 ? { layer: s.trLayer, approx: this._terrorApprox(s.trLayer) } : null,
      teammates, lastSeen: m.lastSeen.slice(), hud, downedAuras,
      gens, gensDone: this.gensDone, gensNeeded: this.gensNeeded,
      pallets: pals, gates: this._gatesObs(s), gatesPowered: this.gatesPowered, blockedWindows: this._blockedWindows(s.id),
      endgame: this.endgameT >= 0 ? { remainingS: this.endgameT } : null,
      notifications: inbox, newNotifications: newN,
    };
  }

  _obsHunter() {
    const cfg = this.cfg, H = this.hunter, t = this.t;
    const survivors = [];
    for (let i = 0; i < 4; i++) {
      const s = this.survivors[i];
      if (!H.seen[i] || s.st >= S_DEAD) continue;
      survivors.push({ id: i, x: s.x, z: s.z, vx: s.vx, vz: s.vz, facing: s.face, state: S_NAME[s.st], hookCount: s.hookCount, vaulting: !!s.vault });
      H.lastSeen[i] = { x: s.x, z: s.z, state: S_NAME[s.st], t };
    }
    const gm = cfg.senses.gruntMemoryS;
    let k = 0; while (k < H.grunts.length && t - H.grunts[k].t > gm) k++;
    if (k) H.grunts.splice(0, k);
    const grunts = H.grunts.map(g => ({ x: g.x, z: g.z, t: g.t }));
    const scratches = H.visMarks.filter(m => t - m.t <= cfg.senses.scratchMemoryS).map(m => ({ x: m.x, z: m.z, t: m.t, dx: m.dx, dz: m.dz }));
    const gens = this.gens.map((g, i) => {
      const vis = H.gSeen[i] === 1;
      return { id: g.id, x: g.x, z: g.z, progress: g.done ? 1 : g.p / this.need, done: g.done, blocked: this.gatesPowered && !g.done, regressing: g.regress, visible: vis, workers: vis ? g.wIds.slice(0, g.lastN) : null };
    });
    const noisyGens = [], nr = cfg.senses.repairNoiseRadius;
    for (const g of this.gens) if (g.lastN > 0 && rectDist(H.x, H.z, g.x0, g.z0, g.x1, g.z1) <= nr) noisyGens.push({ id: g.id, x: g.x, z: g.z });
    const hooked = [];
    const out = [];
    for (const s of this.survivors) {
      if (s.st === S_HOOKED) hooked.push({ id: s.id, hookId: this.hooks[s.hookIdx].id, stage: s.hookStage, timerS: s.hookTimer, hookCount: s.hookCount });
      out.push(s.st === S_DEAD ? 'dead' : s.st === S_ESCAPED ? 'escaped' : 'alive');
    }
    const inbox = H.inbox;
    const newN = inbox.slice(H.inboxRead); H.inboxRead = inbox.length;
    return {
      t, tick: this.tick,
      self: { x: H.x, z: H.z, vx: H.vx, vz: H.vz, facing: H.face, fx: Math.cos(H.face), fz: Math.sin(H.face),
        carrying: H.carrying >= 0 ? H.carrying : null, cooldownS: H.cdT, windupS: H.windT, stunS: H.stunT, vaulting: !!H.vault, act: H.curAct, progress: H.prog },
      survivors, lastSeen: H.lastSeen.slice(), grunts, scratches, gens, noisyGens, gensDone: this.gensDone, gensNeeded: this.gensNeeded,
      hooked, status: out, chase: { target: this.chaseTgt >= 0 ? this.chaseTgt : null }, pallets: this._palNames(), gates: this._gatesObs(H), gatesPowered: this.gatesPowered, blockedWindows: [],
      endgame: this.endgameT >= 0 ? { remainingS: this.endgameT } : null,
      notifications: inbox, newNotifications: newN,
    };
  }

  // ------------------------------------------------------------------ movement
  // Steering: returns true if a step was requested; direction in this._sdx/_sdz, length in this._sstep.
  _steer(a, A, speed) {
    let dx = 0, dz = 0, step = 0;
    const mv = A.moveDir;
    if (mv) {
      const l = Math.sqrt(mv.x * mv.x + mv.z * mv.z);
      if (l > 1e-6) { dx = mv.x / l; dz = mv.z / l; step = speed * this.dt; }
    } else if (A.moveTo) {
      const wp = this._wp;
      if (a.nav._next(a.x, a.z, A.moveTo.x, A.moveTo.z, wp)) {
        const ex = wp.x - a.x, ez = wp.z - a.z, l = Math.sqrt(ex * ex + ez * ez);
        if (l > this.cfg.reach.arrive) { dx = ex / l; dz = ez / l; step = Math.min(speed * this.dt, l); }
      }
    }
    this._sdx = dx; this._sdz = dz; this._sstep = step;
    return step > 0;
  }

  _applyMove(a, dx, dz, step, isHunter) {
    const px = a.x, pz = a.z;
    const coll = this.coll, W = this.W, Hh = this.Hh, R = this.R;
    const nx = px + dx * step, nz = pz + dz * step;
    if (circleFree(coll, W, Hh, nx, nz, R)) { a.x = nx; a.z = nz; }
    else {
      // blocked: take the candidate (axis slides / shortened steps, all tried at full and fractional length) that
      // gains the most distance, so walls are approached flush and slid along
      const ddx = nx - px, ddz = nz - pz, len = Math.sqrt(ddx * ddx + ddz * ddz);
      let bx = px, bz = pz, gain = 0;
      for (let k = -1; k < FRAC.length; k++) {
        const f = k < 0 ? 1 : FRAC[k];
        if (k >= 0 && f * len <= gain) break;
        if (k >= 0 && circleFree(coll, W, Hh, px + ddx * f, pz + ddz * f, R)) { bx = px + ddx * f; bz = pz + ddz * f; gain = f * len; break; }
        const gx = ddx * f < 0 ? -ddx * f : ddx * f;
        if (gx > gain && ddx !== 0 && circleFree(coll, W, Hh, px + ddx * f, pz, R)) { bx = px + ddx * f; bz = pz; gain = gx; }
        const gz = ddz * f < 0 ? -ddz * f : ddz * f;
        if (gz > gain && ddz !== 0 && circleFree(coll, W, Hh, px, pz + ddz * f, R)) { bx = px; bz = pz + ddz * f; gain = gz; }
      }
      a.x = bx; a.z = bz;
    }
    const mx = a.x - px, mz = a.z - pz;
    if (mx * mx + mz * mz < 0.36 * step * step) this._tryVault(a, dx, dz, isHunter);
    a.vx = (a.x - px) / this.dt; a.vz = (a.z - pz) / this.dt;
  }

  _tryVault(a, dx, dz, isHunter) {
    const md = this.md, W = md.w, Hh = md.h, kind = md.kind;
    const ci = Math.floor(a.x), cj = Math.floor(a.z);
    const adx = Math.abs(dx), adz = Math.abs(dz);
    for (let pass = 0; pass < 2; pass++) {
      let nx = 0, nz = 0;
      const useX = pass === 0 ? adx >= adz : adx < adz;
      if (useX) { if (adx < 0.35) continue; nx = dx > 0 ? 1 : -1; } else { if (adz < 0.35) continue; nz = dz > 0 ? 1 : -1; }
      const wi = ci + nx, wj = cj + nz, fi = ci + 2 * nx, fj = cj + 2 * nz;
      if (wi < 0 || wj < 0 || wi >= W || wj >= Hh || fi < 0 || fj < 0 || fi >= W || fj >= Hh) continue;
      const wc = wj * W + wi, k = kind[wc];
      let dur;
      if (k === K_WIN_X || k === K_WIN_Z) {
        if ((k === K_WIN_X) !== (nx !== 0)) continue;
        if (!isHunter && this.winBlockT[this.winOfCell.get(wc) * 4 + a.id] > this.t) continue;
        dur = isHunter ? this.cfg.hunter.vaultS : this._survivorVaultS(a, nx, nz);
      } else if ((k === K_PAL_X || k === K_PAL_Z) && !isHunter && this.ps[md.palIdx[wc] - 1] === 1) {
        if ((k === K_PAL_X) !== (nx !== 0)) continue;
        dur = this.cfg.survivor.palletVaultS;
      } else continue;
      if (this.coll[fj * W + fi] !== 0) continue;
      const lat = nx !== 0 ? Math.abs(a.z - (cj + 0.5)) : Math.abs(a.x - (ci + 0.5));
      if (lat > this.cfg.reach.vaultLane) continue;
      const along = nx > 0 ? wi - a.x : nx < 0 ? a.x - (wi + 1) : nz > 0 ? wj - a.z : a.z - (wj + 1);
      if (along > this.R + 0.3) continue;
      a.vault = { t: 0, dur, x0: a.x, z0: a.z, x1: fi + 0.5, z1: fj + 0.5 };
      if (!isHunter) {
        if (dur === this.cfg.survivor.vaultFastS && (k === K_WIN_X || k === K_WIN_Z)) this._loudNoise('vault', a.x, a.z);
        a.runD = 0;
      }
      if (!isHunter && (k === K_WIN_X || k === K_WIN_Z)) this._noteWindowVault(this.winOfCell.get(wc), a.id);
      a.face = Math.atan2(nz, nx);
      this.stats.vaults++;
      if (!isHunter) this.ev('vault', { who: a.id, chased: this.chaseTgt === a.id });
      return true;
    }
    return false;
  }

  // Window vault tier for a survivor vaulting in direction (nx, nz): walking = slow; running with a straight run-up = fast.
  _survivorVaultS(a, nx, nz) {
    const sv = this.cfg.survivor;
    if (a.lastAction && a.lastAction.walk) return sv.vaultSlowS;
    const cosT = Math.cos(sv.fastVaultAngleDeg * DEG);
    if (a.runD >= sv.fastVaultRunupM - EPS && a.runDx * nx + a.runDz * nz >= cosT) return sv.vaultFastS;
    return sv.vaultMediumS;
  }

  _loudNoise(cause, x, z) {
    const H = this.hunter, r = this.cfg.senses.loudNoiseRange;
    this.ev('loudNoise', { cause, x, z });
    if (!(r < Infinity) || hyp(H.x - x, H.z - z) <= r) this._notify(H, { type: 'loudNoise', cause, x, z, t: this.t });
  }

  // Genre entity blocker: the Nth vault of one window by one survivor within withinS ("one chase") blocks that
  // window for that survivor only, for blockS. Others (and the hunter) can still use it.
  _noteWindowVault(wi, sid) {
    const wb = this.cfg.windowBlock;
    if (!wb || !wb.vaults) return;
    const log = this.winVaults[wi][sid].filter((t) => this.t - t < wb.withinS);
    log.push(this.t);
    if (log.length >= wb.vaults) {
      this.winBlockT[wi * 4 + sid] = this.t + wb.blockS;
      this.winVaults[wi][sid] = [];
      this.ev('windowBlocked', { window: this.md.windows[wi].id, who: sid });
    } else this.winVaults[wi][sid] = log;
  }

  _blockedWindows(sid) {
    const out = [];
    for (let i = 0; i < this.md.windows.length; i++) if (this.winBlockT[i * 4 + sid] > this.t) out.push(this.md.windows[i].id);
    return out;
  }

  _advanceVault(a) {
    const v = a.vault;
    const px = a.x, pz = a.z;
    v.t += this.dt;
    const u = v.t >= v.dur - EPS ? 1 : v.t / v.dur;
    a.x = v.x0 + (v.x1 - v.x0) * u; a.z = v.z0 + (v.z1 - v.z0) * u;
    a.vx = (a.x - px) / this.dt; a.vz = (a.z - pz) / this.dt;
    if (u >= 1) a.vault = null;
  }

  // ------------------------------------------------------------------ step
  // Terror radius as survivors actually experience it: the radius is split into terrorLayers equal bands (layer 1 =
  // outermost). Entering/leaving the radius is noticed after terrorEnterLagS; a change between inner layers only after
  // the new layer has persisted for terrorLayerLagS (you don't instantly hear "32 m -> 24 m"). No direction, no distance.
  _updateTerror() {
    const sc = this.cfg.senses, H = this.hunter, R = sc.terrorRadius, L = sc.terrorLayers;
    for (const s of this.survivors) {
      if (s.st >= S_DEAD) continue;
      const d = Math.sqrt((s.x - H.x) ** 2 + (s.z - H.z) ** 2);
      const truth = d > R ? 0 : Math.min(L, 1 + Math.floor(((R - d) / R) * L));
      if (truth === s.trLayer) { s.trPend = truth; continue; }
      if (truth !== s.trPend) { s.trPend = truth; s.trPendT = this.t; }
      const lag = truth === 0 || s.trLayer === 0 ? sc.terrorEnterLagS : sc.terrorLayerLagS;
      if (this.t - s.trPendT >= lag - 1e-9) s.trLayer = truth;
    }
  }

  _terrorApprox(layer) { // midpoint distance of the band, for brains that want a number
    const R = this.cfg.senses.terrorRadius, L = this.cfg.senses.terrorLayers;
    return +(R - ((layer - 0.5) * R) / L).toFixed(2);
  }

  step() {
    if (this.over) return;
    const cfg = this.cfg, dt = this.dt, S = this.survivors, H = this.hunter;
    this.t = this.tick * dt;
    this._perceive();
    this._updateTerror();
    this._updateChase();
    if (this.tick % cfg.decisionEvery === 0) {
      for (const s of S) {
        if (s.st >= S_HOOKED) { s.lastAction = IDLE; continue; }
        s.lastAction = s.brain.decide(this._obsSurvivor(s), s.api) || IDLE;
      }
      H.lastAction = H.brain.decide(this._obsHunter(), H.api) || IDLE;
    }
    for (let k = 0; k < 4; k++) {
      const s = S[(this.tick + k) & 3];
      this._survivorAct(s, s.lastAction);
    }
    this._finishGens();
    this._hunterAct(H.lastAction);
    if (H.carrying >= 0) { const c = S[H.carrying]; c.x = H.x; c.z = H.z; c.vx = H.vx; c.vz = H.vz; }
    this._worldTimers();
    this.tick++;
    if (this.recordOn && this.tick % cfg.recordEvery === 0) this._record();
    if (this.inGameCount() === 0) this._end('all-out');
    else if (this.tick >= this.maxTicks) this._end('time');
  }

  _end(reason) {
    this.over = true; this.endReason = reason; this.t = this.tick * this.dt;
    for (const s of this.survivors) if (s.st < S_DEAD) { s.outcome = 'timeout'; s.tOut = this.t; }
    this.ev('end', { reason });
    if (this.recordOn) this._record(true);
  }

  // ------------------------------------------------------------------ survivor actions
  _survivorAct(s, A) {
    if (s.st >= S_DEAD) return;
    const cfg = this.cfg, sv = cfg.survivor, dt = this.dt;
    const prevAct = s.curAct, prevTgt = s.curTgt;
    s.curAct = null; s.curTgt = null;
    if (s.st === S_HOOKED) { s.vx = s.vz = 0; s.prog = 0; return; }
    if (s.vault) { this._advanceVault(s); s.curAct = 'vault'; return; }
    if (s.st === S_CARRIED) {
      s.vx = s.vz = 0;
      if (A.act === 'wiggle') {
        s.curAct = 'wiggle'; s.wiggle += dt;
        if (s.wiggle >= sv.wiggleS - EPS) this._wiggleFree(s);
      } else s.prog = 0;
      return;
    }
    const crawl = s.st === S_DOWNED;
    // genre: once the hunter has started picking a downed survivor up, they're locked in place (can't crawl out of reach)
    if (crawl && this.hunter.curAct === 'pickup' && this.hunter.curTgt === s.id) { s.vx = s.vz = 0; s.prog = 0; s.curAct = null; return; }
    let speed = crawl ? sv.crawlSpeed : (A.walk ? sv.walkSpeed : sv.runSpeed);
    if (!crawl) {
      const haste = s.protT > 0 ? 1 + cfg.unhook.haste : 1;
      speed *= s.boostT > 0 ? Math.max(sv.boostMult, haste) : haste;   // on-hit burst takes precedence
    }
    const moving = this._steer(s, A, speed);
    let moved = false;
    if (moving) {
      const px = s.x, pz = s.z, step = this._sstep;
      this._applyMove(s, this._sdx, this._sdz, step, false);
      // fast-vault run-up: continuous running distance with a steady heading (reset on walk / stop / blocked / turn)
      if (!s.vault) {
        const mx = s.x - px, mz = s.z - pz, ml = Math.sqrt(mx * mx + mz * mz);
        if (crawl || A.walk || ml < 0.6 * step) s.runD = 0;
        else {
          const ux = mx / ml, uz = mz / ml;
          if (s.runD > 0 && ux * s.runDx + uz * s.runDz >= Math.cos(sv.fastVaultAngleDeg * DEG)) s.runD += ml;
          else { s.runD = ml; s.runDx = ux; s.runDz = uz; }
        }
      }
      if (!A.face) s.face = Math.atan2(this._sdz, this._sdx);
      moved = true;
      if (!crawl && !A.walk && !s.vault && s.protT <= 0) {   // elusive: no scratch marks
        s.scratchT -= dt;
        if (s.scratchT <= 0) { this.marks.push({ x: s.x, z: s.z, t: this.t, dx: this._sdx, dz: this._sdz }); s.scratchT = cfg.senses.scratchEveryS; }
      }
    } else { s.vx = s.vz = 0; s.runD = 0; }
    if (s.vault) { s.curAct = 'vault'; return; }
    if (A.face) s.face = Math.atan2(A.face.z - s.z, A.face.x - s.x);
    if (crawl) { s.prog = 0; return; }
    if (!moved && A.act) {
      const same = (act, tgt) => { if (CONSPICUOUS[act]) this._endProtection(s); s.curAct = act; s.curTgt = tgt; if (prevAct === act && prevTgt === tgt) s.prog += dt; else s.prog = dt; return s.prog; };
      switch (A.act) {
        case 'repair': {
          if (this.gatesPowered) break;                 // remaining generators are blocked once the exit gates are powered
          let g = A.target !== undefined && A.target !== null ? this.genById.get(A.target) : null;
          if (!g) { let bd = Infinity; for (const c of this.gens) { if (c.done) continue; const d = rectDist(s.x, s.z, c.x0, c.z0, c.x1, c.z1); if (d < bd) { bd = d; g = c; } } }
          if (!g || g.done || rectDist(s.x, s.z, g.x0, g.z0, g.x1, g.z1) > cfg.reach.repair) break;
          this._endProtection(s);
          s.curAct = 'repair'; s.curTgt = g.id; s.prog = 0;
          if (g.nWork < 4) g.wIds[g.nWork] = s.id;
          g.nWork++;
          break;
        }
        case 'heal': {
          const t = typeof A.target === 'number' ? this.survivors[A.target] : null;
          if (!t || t === s || (t.st !== S_INJURED && t.st !== S_DOWNED) || t.dwT >= 0) break;   // Deep Wound: must mend first
          const dx = t.x - s.x, dz = t.z - s.z;
          if (dx * dx + dz * dz > cfg.reach.heal * cfg.reach.heal) break;
          same('heal', t.id);
          t.heal += dt;
          if (t.heal >= sv.healS - EPS) {
            t.heal = 0;
            if (t.st === S_DOWNED) { t.st = S_INJURED; t.bleedT = 0; } else t.st = S_HEALTHY;
            this.stats.heals++;
            this.ev('heal', { by: s.id, who: t.id, state: S_NAME[t.st] });
          }
          break;
        }
        case 'rescue': {
          let t = typeof A.target === 'number' ? this.survivors[A.target] : null;
          if (!t) { let bd = Infinity; for (const o of this.survivors) if (o.st === S_HOOKED) { const hk = this.hooks[o.hookIdx]; const d = hyp(hk.x - s.x, hk.z - s.z); if (d < bd) { bd = d; t = o; } } }
          if (!t || t.st !== S_HOOKED) break;
          const hk = this.hooks[t.hookIdx];
          if (hyp(hk.x - s.x, hk.z - s.z) > cfg.reach.rescue) break;
          if (same('rescue', t.id) >= sv.rescueS - EPS) {
            this._unhook(t, s.id);
            this.stats.rescues++;
            this.ev('rescue', { by: s.id, who: t.id });
            s.prog = 0; s.curAct = null;
          }
          break;
        }
        case 'mend': {
          if (s.dwT < 0) break;
          same('mend', s.id);
          s.mendP += dt;
          if (s.mendP >= cfg.unhook.mendS - EPS) { s.dwT = -1; s.mendP = 0; this.ev('mend', { who: s.id }); s.prog = 0; s.curAct = null; }
          break;
        }
        case 'dropPallet': {
          let p = A.target !== undefined && A.target !== null ? this.palletById.get(A.target) : null;
          if (!p) { let bd = Infinity; for (const c of this.md.pallets) { if (this.ps[c.index] !== 0) continue; const d = rectDist(s.x, s.z, c.x0, c.z0, c.x1, c.z1); if (d < bd) { bd = d; p = c; } } }
          if (!p || this.ps[p.index] !== 0 || rectDist(s.x, s.z, p.x0, p.z0, p.x1, p.z1) > cfg.reach.pallet) break;
          if (same('dropPallet', p.id) >= sv.palletDropS - EPS) { this._dropPallet(p, s); s.prog = 0; s.curAct = null; }
          break;
        }
        case 'openGate': {
          if (!this.gatesPowered) break;
          let g = A.target !== undefined && A.target !== null ? this.gates.find(x => x.id === A.target) : null;
          if (!g) { let bd = Infinity; for (const c of this.gates) { if (c.open) continue; const d = hyp(c.lx - s.x, c.lz - s.z); if (d < bd) { bd = d; g = c; } } }
          if (!g || g.open || hyp(g.lx - s.x, g.lz - s.z) > cfg.reach.lever) break;
          // one survivor per lever: occupied if someone else worked it this tick or the previous one
          if (g.user !== s.id && g.user >= 0 && g.userTick >= this.tick - 1) break;
          g.user = s.id; g.userTick = this.tick;
          same('openGate', g.id);
          g.prog += dt; s.leverS += dt;                  // lever progress persists on the gate when the opener lets go
          if (g.prog >= cfg.gates.leverS - EPS) this._openGate(g, s);
          break;
        }
        default: break;
      }
    }
    if (s.curAct === null) s.prog = 0;
    this._checkExit(s);
  }

  _openGate(g, s) {
    g.open = true; g.prog = this.cfg.gates.leverS; g.user = -1;
    this.ev('gateOpen', { gate: g.id, by: s.id });
    if (this.endgameT < 0) {                         // endgame collapse starts when the FIRST gate is opened
      this.endgameT = this.cfg.gates.endgameS;
      this.ev('endgame', { gate: g.id });
    }
    const n = { type: 'gateOpen', gate: g.id, t: this.t };
    this._notify(this.hunter, { ...n });
    this._notifyAllSurvivors(n);
  }

  // shared unhook result (rescue or self-unhook): injured + unhook protections; anti-camp state reset.
  // by = rescuer id | 'self'; teammates get an `unhooked` HUD notification.
  _unhook(s, by) {
    const hk = this.hooks[s.hookIdx];
    if (hk) hk.occ = -1;
    s.hookIdx = -1; s.st = S_INJURED; s.hookTimer = 0;
    s.resolve = 0; s.campT = 0; s.outT = 0; s.graceT = 0; s.selfT = -1;
    this._grantProtection(s);
    this._notifyMates(s, { type: 'unhooked', who: s.id, by, t: this.t });
  }

  // Anti-camp "Resolve" meter for a hooked survivor (see config.antiCamp). Returns true if the hook timer is paused.
  _antiCamp(s) {
    const ac = this.cfg.antiCamp, dt = this.dt, H = this.hunter;
    if (!ac || !ac.enabled) return false;
    if (s.selfT >= 0) {                                   // full meter: guaranteed self-unhook attempt
      s.selfT += dt;
      if (s.selfT >= ac.selfUnhookS - EPS) { this.ev('selfUnhook', { who: s.id }); this._unhook(s, 'self'); }
      return true;
    }
    if (this.gatesPowered) return false;
    const hk = this.hooks[s.hookIdx];
    const d = hyp(H.x - hk.x, H.z - hk.z);
    const prox = d <= ac.nearM ? 1 : d <= ac.radius ? 1 - (1 - ac.farFactor) * (d - ac.nearM) / (ac.radius - ac.nearM) : 0;
    if (prox > 0) { s.campT += dt; s.outT = 0; } else { s.outT += dt; if (s.outT >= ac.campResetS - EPS) s.campT = 0; }
    if (s.graceT > 0) { s.graceT = Math.max(0, s.graceT - dt); return false; }
    if (prox <= 0 || H.carrying >= 0) return false;
    const cr2 = ac.chaseRadius * ac.chaseRadius, mr2 = ac.mateRadius * ac.mateRadius;
    for (const o of this.survivors) {
      if (o === s || o.st >= S_HOOKED) continue;
      if ((o.x - hk.x) ** 2 + (o.z - hk.z) ** 2 <= mr2) return false;                          // teammate near the hook
      if (o.st <= S_INJURED && H.seen[o.id] && (o.x - H.x) ** 2 + (o.z - H.z) ** 2 <= cr2) return false;   // hunter in chase
    }
    let tm = 1;
    for (const [lim, mult] of ac.timeMult) if (s.campT < lim) { tm = mult; break; }
    const fr = Math.min(1, Math.max(0, 1 - s.hookTimer / this.cfg.hooks.stageS));
    s.resolve += dt / ac.baseFullS * prox * tm * (1 + ac.stageCurve * fr * fr);
    if (s.resolve >= 1 - EPS) { s.resolve = 1; s.selfT = 0; this.ev('resolveFull', { who: s.id }); }
    return false;
  }

  _grantProtection(s) {
    s.protT = this.cfg.unhook.protectS; s.endure = true;
    this.ev('protect', { who: s.id, s: s.protT });
  }

  _endProtection(s) {
    s.protT = 0; s.endure = false;
  }

  _downSurvivor(s) {
    const sv = this.cfg.survivor;
    s.st = S_DOWNED; s.bleedT = sv.bleedOutS; s.heal = 0; s.dwT = -1; s.mendP = 0; this.stats.downs++;
    this._endProtection(s);
  }

  _checkExit(s) {
    if (!this.gatesPowered || s.vault || s.st > S_INJURED) return;
    const reach = this.cfg.gates.exitReach;
    for (const g of this.gates) {
      if (g.open && hyp(g.ex - s.x, g.ez - s.z) <= reach) { this._escape(s, g); return; }
    }
  }

  _escape(s, gate) {
    s.st = S_ESCAPED; s.outcome = 'escaped'; s.tOut = this.t; s.vx = s.vz = 0;
    this.ev('escape', { who: s.id, gate: gate.id });
    this._afterOut();
  }

  _kill(s, cause) {
    if (s.st >= S_DEAD) return;
    if (s.st === S_CARRIED) this.hunter.carrying = -1;
    if (s.st === S_HOOKED && s.hookIdx >= 0) { this.hooks[s.hookIdx].occ = -1; s.hookIdx = -1; }
    s.st = S_DEAD; s.outcome = 'dead'; s.cause = cause; s.tOut = this.t; s.vx = s.vz = 0; s.vault = null;
    this.ev('death', { who: s.id, cause });
    this._notifyMates(s, { type: 'died', who: s.id, t: this.t });
    this._afterOut();
  }

  _afterOut() {
    if (!this.gatesPowered && this.inGameCount() === 1) this._powerGates('last-survivor');
  }

  _powerGates(reason) {
    if (this.gatesPowered) return;
    this.gatesPowered = true;                        // endgame timer starts later, on the first gate opening (_openGate)
    this.ev('gatesPowered', { reason });
    const n = { type: 'gatesPowered', t: this.t };
    this._notify(this.hunter, { ...n });
    this._notifyAllSurvivors(n);
  }

  _wiggleFree(s) {
    const H = this.hunter;
    H.carrying = -1; s.st = S_DOWNED; s.wiggle = 0; s.prog = 0;
    s.bleedT = Math.max(s.bleedT, 1);
    H.stunT = this.cfg.hunter.wiggleStunS; H.prog = 0; H.windT = 0;
    this.stats.wiggles++; this.stats.stuns++;
    this.ev('wiggle', { who: s.id });
  }

  _dropPallet(p, s) {
    const hc = this.cfg.hunter, W = this.W;
    this.ps[p.index] = 1; this.palVersion++; this.droppedCount++;
    for (const c of p.cells) this.coll[c] = 1;
    this.stats.palletsDropped++;
    const axisX = p.axis === 'x';
    const H = this.hunter;
    // stun test uses the hunter position at drop time (before any push-out)
    const al = hc.palletStunAlongM;
    const stun = axisX ? (H.x >= p.x0 - al && H.x <= p.x1 + al && H.z >= p.z0 && H.z <= p.z1)
                       : (H.z >= p.z0 - al && H.z <= p.z1 + al && H.x >= p.x0 && H.x <= p.x1);
    // push actors standing in the (now solid) footprint out to the nearest approach side
    for (const a of [H, ...this.survivors]) {
      if ((a.st !== undefined && a.st >= S_DEAD) || a.vault) continue;
      if (a.x >= p.x0 && a.x < p.x1 && a.z >= p.z0 && a.z < p.z1) {
        if (axisX) a.x = a.x < p.cx ? p.x0 - 0.5 : p.x1 + 0.5; else a.z = a.z < p.cz ? p.z0 - 0.5 : p.z1 + 0.5;
      }
    }
    if (stun) this._stunHunter(hc.palletStunS);
    this.ev('palletDrop', { pallet: p.id, by: s.id, stun });
  }

  _stunHunter(sec) {
    const H = this.hunter;
    H.stunT = Math.max(H.stunT, sec); H.windT = 0; H.prog = 0; H.vx = H.vz = 0;
    this.stats.stuns++;
    if (H.carrying >= 0) {
      const c = this.survivors[H.carrying];
      H.carrying = -1; c.st = S_DOWNED; c.wiggle = 0;
      this.ev('dropped', { who: c.id });
    }
  }

  _finishGens() {
    const cfg = this.cfg.gens, dt = this.dt;
    for (const g of this.gens) {
      g.lastN = g.nWork < 4 ? g.nWork : 4;
      if (this.gatesPowered) { g.nWork = 0; g.lastN = 0; continue; }
      if (g.nWork === 0) {
        if (g.regress) {
          g.p -= cfg.regressRate * dt;
          if (g.p <= EPS) { g.p = 0; g.regress = false; this.ev('genRegressStop', { gen: g.id, reason: 'empty' }); }
        }
        continue;
      }
      if (g.regress) { g.regress = false; this.ev('genRegressStop', { gen: g.id, reason: 'repair' }); }
      const n = g.nWork;
      const eff = cfg.efficiency[Math.min(n, cfg.efficiency.length) - 1];
      g.p += n * eff * dt;
      for (let k = 0; k < g.lastN; k++) { const w = this.survivors[g.wIds[k]]; w.repairS += dt; w.repairC += (eff * dt) / this.need; }
      const pf = cfg.fumbleChancePerS * dt;
      for (let k = 0; k < n; k++) {
        if (this.world.next() < pf) {
          g.p = Math.max(0, g.p - cfg.fumbleLoss * this.need);
          this.stats.fumbles++;
          this.ev('fumble', { gen: g.id, who: g.wIds[k < 4 ? k : 0] });
          this._notify(this.hunter, { type: 'fumble', gen: g.id, x: g.x, z: g.z, t: this.t });
        }
      }
      g.nWork = 0;
      if (g.p >= this.need - EPS && !g.done) {
        g.done = true; g.p = this.need; this.gensDone++;
        this.ev('genDone', { gen: g.id, done: this.gensDone });
        const n2 = { type: 'genDone', gen: g.id, x: g.x, z: g.z, t: this.t, gensDone: this.gensDone };
        this._notify(this.hunter, { ...n2 });
        for (const s of this.survivors) if (s.st < S_DEAD) { s.inbox.push({ ...n2 }); const me = s.mem.gens[g.idx]; me.done = true; me.progress = 1; me.workers = null; }
        if (this.gensDone >= this.gensNeeded) this._powerGates('gens');
      }
    }
  }

  // ------------------------------------------------------------------ hunter actions
  _hurt(s) {
    const sv = this.cfg.survivor;
    this.stats.hits++;
    if (s.st === S_HEALTHY) { s.st = S_INJURED; s.boostT = sv.hitBoostS; s.gruntT = 0; this.ev('hit', { who: s.id, state: 'injured' }); }
    else if (s.st === S_INJURED && s.endure && s.protT > 0) {   // Endurance: survive the downing hit with Deep Wound
      s.endure = false; s.boostT = sv.hitBoostS; s.dwT = this.cfg.unhook.deepWoundS; s.mendP = 0; s.gruntT = 0;
      this.ev('hit', { who: s.id, state: 'injured', endurance: true });
    }
    else if (s.st === S_INJURED) {
      this._downSurvivor(s);
      this.ev('hit', { who: s.id, state: 'downed' });
      this._scream(s, 'down');
    }
  }

  _scream(s, kind) {
    const r = this.cfg.senses.screamRadius;
    if (r <= 0) return;
    for (const o of this.survivors) {
      if (o === s || o.st >= S_DEAD) continue;
      if (hyp(o.x - s.x, o.z - s.z) <= r) o.inbox.push({ type: 'scream', kind, x: s.x, z: s.z, t: this.t });
    }
  }

  _hunterAct(A) {
    const H = this.hunter, hc = this.cfg.hunter, dt = this.dt, cfg = this.cfg;
    const prevAct = H.curAct, prevTgt = H.curTgt;
    H.curAct = null; H.curTgt = null;
    if (H.cdT > 0) H.cdT = Math.max(0, H.cdT - dt);
    if (H.stunT > 0) { H.stunT = Math.max(0, H.stunT - dt); H.curAct = 'stunned'; H.vx = H.vz = 0; return; }
    if (H.vault) { this._advanceVault(H); H.curAct = 'vault'; return; }
    const carrying = H.carrying >= 0;
    if (A.act === 'attack' && H.windT <= 0 && H.cdT <= 0 && !carrying) {
      H.windT = hc.windupS; H.prog = 0;
      if (A.face) H.face = Math.atan2(A.face.z - H.z, A.face.x - H.x);
      else if (typeof A.target === 'number') { const t = this.survivors[A.target]; if (t && t.st < S_DEAD) H.face = Math.atan2(t.z - H.z, t.x - H.x); }
    }
    if (H.windT > 0) {
      // lunge forward along the facing, but plant once a valid target is already inside range + arc (no overshoot)
      if (!this._targetInReach()) this._applyMove(H, Math.cos(H.face), Math.sin(H.face), hc.speed * hc.lungeSpeedMult * dt, true);
      else { H.vx = H.vz = 0; }
      H.curAct = 'attack';
      H.windT -= dt;
      if (H.windT <= EPS) { H.windT = 0; this._resolveAttack(); }
      return;
    }
    const speed = carrying ? hc.carrySpeed : (H.cdT > 0 ? H.cdSpeed : hc.speed);
    const moving = this._steer(H, A, speed);
    if (moving) {
      this._applyMove(H, this._sdx, this._sdz, this._sstep, true);
      if (!A.face) H.face = Math.atan2(this._sdz, this._sdx);
    } else { H.vx = H.vz = 0; }
    if (A.face) H.face = Math.atan2(A.face.z - H.z, A.face.x - H.x);
    if (H.vault) { H.curAct = 'vault'; return; }
    if (!moving && A.act && H.cdT <= 0) {
      const same = (act, tgt) => { H.curAct = act; H.curTgt = tgt; if (prevAct === act && prevTgt === tgt) H.prog += dt; else H.prog = dt; return H.prog; };
      switch (A.act) {
        case 'pickup': {
          if (carrying) break;
          let t = typeof A.target === 'number' ? this.survivors[A.target] : null;
          if (!t) { let bd = Infinity; for (const o of this.survivors) if (o.st === S_DOWNED) { const d = hyp(o.x - H.x, o.z - H.z); if (d < bd) { bd = d; t = o; } } }
          if (!t || t.st !== S_DOWNED || t.vault || hyp(t.x - H.x, t.z - H.z) > cfg.reach.pickup) break;
          if (same('pickup', t.id) >= hc.pickupS - EPS) {
            t.st = S_CARRIED; t.wiggle = 0; t.prog = 0; H.carrying = t.id; H.prog = 0; H.curAct = null;
            this.stats.pickups++;
            this.ev('pickup', { who: t.id });
          }
          break;
        }
        case 'hook': {
          if (!carrying) break;
          let hk = A.target !== undefined && A.target !== null ? this.hooks.find(x => x.id === A.target) : null;
          if (!hk) { let bd = Infinity; for (const c of this.hooks) { if (c.occ >= 0) continue; const d = hyp(c.x - H.x, c.z - H.z); if (d < bd) { bd = d; hk = c; } } }
          if (!hk || hk.occ >= 0 || hyp(hk.x - H.x, hk.z - H.z) > cfg.reach.hook) break;
          if (same('hook', hk.id) >= hc.hookS - EPS) { this._hookSurvivor(this.survivors[H.carrying], hk); H.prog = 0; H.curAct = null; }
          break;
        }
        case 'kickGen': {
          if (carrying || this.gatesPowered) break;
          const kickable = c => !c.done && !c.regress && c.p > EPS;
          let g = A.target !== undefined && A.target !== null ? this.genById.get(A.target) : null;
          if (!g) { let bd = Infinity; for (const c of this.gens) { if (!kickable(c)) continue; const d = rectDist(H.x, H.z, c.x0, c.z0, c.x1, c.z1); if (d < bd) { bd = d; g = c; } } }
          if (!g || !kickable(g) || rectDist(H.x, H.z, g.x0, g.z0, g.x1, g.z1) > cfg.reach.kickGen) break;
          if (same('kickGen', g.id) >= hc.kickS - EPS) {
            g.p = Math.max(0, g.p - cfg.gens.kickLoss * this.need);
            g.regress = g.p > EPS;
            this.ev('genKick', { gen: g.id, progress: g.p / this.need });
            H.prog = 0; H.curAct = null;
          }
          break;
        }
        case 'breakPallet': {
          let p = A.target !== undefined && A.target !== null ? this.palletById.get(A.target) : null;
          if (!p) { let bd = Infinity; for (const c of this.md.pallets) { if (this.ps[c.index] !== 1) continue; const d = rectDist(H.x, H.z, c.x0, c.z0, c.x1, c.z1); if (d < bd) { bd = d; p = c; } } }
          if (!p || this.ps[p.index] !== 1 || rectDist(H.x, H.z, p.x0, p.z0, p.x1, p.z1) > cfg.reach.breakPallet) break;
          if (same('breakPallet', p.id) >= hc.breakPalletS - EPS) {
            this.ps[p.index] = 2; this.palVersion++; this.droppedCount--;
            for (const c of p.cells) this.coll[c] = 0;   // (sight grid is shared across matches: broken pallets stay semi-transparent)
            this.stats.palletsBroken++;
            this.ev('palletBreak', { pallet: p.id });
            H.prog = 0; H.curAct = null;
          }
          break;
        }
        default: break;
      }
    }
    if (H.curAct === null) H.prog = 0;
  }

  _targetInReach() {
    const H = this.hunter, hc = this.cfg.hunter;
    const fx = Math.cos(H.face), fz = Math.sin(H.face), cosArc = Math.cos(hc.attackHalfArcDeg * DEG);
    for (const s of this.survivors) {
      if (s.st !== S_HEALTHY && s.st !== S_INJURED) continue;
      const dx = s.x - H.x, dz = s.z - H.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d <= hc.attackRange * 0.9 && (d < 0.05 || (dx * fx + dz * fz) >= d * cosArc) && this._hitPathClear(H, s)) return true;
    }
    return false;
  }

  // A swing connects only if no solid cell (wall, low wall, generator, outside) lies between hunter and target.
  // Window and pallet cells (up or dropped) can be hit across, as in the genre.
  _hitPathClear(a, b) {
    const kind = this.md.kind, W = this.md.w;
    const dx = b.x - a.x, dz = b.z - a.z, n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 0.2));
    for (let k = 1; k < n; k++) {
      const x = a.x + (dx * k) / n, z = a.z + (dz * k) / n;
      if (kind[Math.floor(z) * W + Math.floor(x)] === K_SOLID) return false;
    }
    return true;
  }

  _resolveAttack() {
    const H = this.hunter, hc = this.cfg.hunter, sc = this.cfg.sight;
    const fx = Math.cos(H.face), fz = Math.sin(H.face), cosArc = Math.cos(hc.attackHalfArcDeg * DEG);
    let best = null, bd = Infinity;
    for (const s of this.survivors) {
      if (s.st !== S_HEALTHY && s.st !== S_INJURED) continue;
      const dx = s.x - H.x, dz = s.z - H.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d > hc.attackRange || d >= bd) continue;
      if (d > 0.05 && (dx * fx + dz * fz) < d * cosArc) continue;
      if (rayVis(this.md, H.x, H.z, s.x, s.z, sc.semiTransparency, sc.visThreshold) < sc.visThreshold) continue;
      if (!this._hitPathClear(H, s)) continue;
      best = s; bd = d;
    }
    if (best) { this._hurt(best); H.cdT = hc.hitCooldownS; H.cdSpeed = hc.hitCooldownSpeed; }
    else { this.stats.missed++; H.cdT = hc.missCooldownS; H.cdSpeed = hc.missCooldownSpeed; this.ev('miss'); }
  }

  _hookSurvivor(s, hk) {
    const H = this.hunter, hcfg = this.cfg.hooks;
    H.carrying = -1;
    s.hookCount++; this.stats.hooks++;
    s.wiggle = 0; s.vault = null;
    this._notifyMates(s, { type: 'hooked', who: s.id, hookId: hk.id, x: hk.x, z: hk.z, t: this.t });   // HUD: when/where
    if (s.hookCount >= hcfg.maxHooks) {
      this.ev('hook', { who: s.id, hook: hk.id, count: s.hookCount, stage: 3 });
      s.st = S_DOWNED; // so _kill doesn't think it is carried
      this._kill(s, 'hook3');
      return;
    }
    hk.occ = s.id; s.hookIdx = hk.idx; s.st = S_HOOKED;
    s.hookStage = s.hookCount === 1 ? 1 : 2; s.hookTimer = hcfg.stageS;
    s.x = hk.x; s.z = hk.z; s.vx = s.vz = 0;
    s.resolve = 0; s.campT = 0; s.outT = 0; s.selfT = -1;
    const gs = this.cfg.antiCamp ? this.cfg.antiCamp.graceS : 0;
    for (const o of this.survivors) if (o.st === S_HOOKED) o.graceT = gs;   // every hook event: grace for ALL hooked survivors
    this.ev('hook', { who: s.id, hook: hk.id, count: s.hookCount, stage: s.hookStage });
    this._scream(s, 'hook');
  }

  // ------------------------------------------------------------------ world timers
  _worldTimers() {
    const cfg = this.cfg, dt = this.dt, H = this.hunter, sn = cfg.senses;
    for (const s of this.survivors) {
      if (s.st >= S_DEAD) continue;
      if (s.boostT > 0) s.boostT = Math.max(0, s.boostT - dt);
      if (s.protT > 0) { s.protT = Math.max(0, s.protT - dt); if (s.protT <= EPS) { s.protT = 0; this._endProtection(s); } }
      if (s.dwT >= 0 && s.st === S_INJURED && s.curAct !== 'mend') {
        s.dwT -= dt;
        if (s.dwT <= EPS) { this._downSurvivor(s); this.ev('deepWoundDown', { who: s.id }); this._scream(s, 'down'); continue; }
      }
      if (s.st === S_DOWNED) {
        s.bleedT -= dt;
        if (s.bleedT <= EPS) this._kill(s, 'bleedout');
      } else if (s.st === S_HOOKED) {
        if (this._antiCamp(s) || s.st !== S_HOOKED) continue;   // self-unhook attempt pauses the hook timer
        s.hookTimer -= dt;
        if (s.hookTimer <= EPS) {
          if (s.hookStage === 1) { s.hookStage = 2; s.hookTimer = cfg.hooks.stageS; this.ev('hookStage', { who: s.id, stage: 2 }); }
          else this._kill(s, 'hookDeath');
        }
      } else if (s.st === S_INJURED && s.protT <= 0) {   // elusive: no grunts of pain
        s.gruntT -= dt;
        if (s.gruntT <= 0) {
          const dx = s.x - H.x, dz = s.z - H.z;
          if (dx * dx + dz * dz <= sn.gruntRadius * sn.gruntRadius) {
            H.grunts.push({ x: s.x + this.world.range(-sn.gruntNoise, sn.gruntNoise), z: s.z + this.world.range(-sn.gruntNoise, sn.gruntNoise), t: this.t });
            s.gruntT = sn.gruntIntervalS;
          }
        }
      }
    }
    if (this.endgameT >= 0) {
      this.endgameT -= dt;
      if (this.endgameT <= EPS) {
        this.endgameT = 0;
        for (const s of this.survivors) if (s.st < S_DEAD) this._kill(s, 'endgame');
      }
    }
  }

  // ------------------------------------------------------------------ recording / results
  _record(final) {
    const H = this.hunter;
    const hs = H.vault ? 4 : H.stunT > 0 ? 3 : H.windT > 0 ? 1 : H.cdT > 0 ? 2 : (H.curAct ? 5 : 0);
    let p = this._prevP;
    if (!p || this._prevPV !== this.palVersion) { p = Array.from(this.ps); this._prevP = p; this._prevPV = this.palVersion; }
    this.frames.push({
      t: r2(this.tick * this.dt),
      h: [r2(H.x), r2(H.z), r2(H.face), H.carrying, hs],
      s: this.survivors.map(s => [r2(s.x), r2(s.z), r2(s.face), s.st, s.vault ? 7 : (ACT_CODE[s.curAct] || 0), s.boostT > 0 ? 1 : 0]),
      g: this.gens.map(g => Math.round(g.p / this.need * 1000) / 1000),
      p,
      ...(final ? { final: true } : {}),
    });
  }

  result() {
    let kills = 0, escapes = 0, timeouts = 0;
    for (const s of this.survivors) { if (s.outcome === 'dead') kills++; else if (s.outcome === 'escaped') escapes++; else if (s.outcome === 'timeout') timeouts++; }
    const res = {
      seed: this.seed, mapId: this.md.info.id, over: this.over, endReason: this.endReason || null,
      winner: kills > escapes ? 'hunter' : escapes > kills ? 'survivors' : 'draw',
      kills, escapes, timeouts, gensDone: this.gensDone, hooks: this.stats.hooks,
      durationS: Math.round(this.tick * this.dt * 100) / 100, ticks: this.tick,
      survivors: this.survivors.map(s => ({ id: s.id, outcome: s.outcome, cause: s.cause, tOut: s.tOut < 0 ? null : r2(s.tOut), hooks: s.hookCount, repairS: r2(s.repairS), repairC: +s.repairC.toFixed(4), leverS: r2(s.leverS) })),
      stats: { ...this.stats },
      gens: this.gens.map(g => g.id),
      events: this.events,
    };
    if (this.recordOn) res.record = { meta: this.recordMeta(), frames: this.frames };
    return res;
  }

  recordMeta() {
    return {
      mapId: this.md.info.id, seed: this.seed, tickHz: this.cfg.tickHz, recordEvery: this.cfg.recordEvery,
      gens: this.gens.map(g => g.id), pallets: this.md.pallets.map(p => p.id),
      legend: {
        h: '[x, z, facing(rad), carryingSurvivorId|-1, status 0 normal|1 windup|2 cooldown|3 stunned|4 vaulting|5 interacting]',
        s: '[x, z, facing, state 0 healthy|1 injured|2 downed|3 carried|4 hooked|5 dead|6 escaped, act 0 none|1 repair|2 heal|3 rescue|4 dropPallet|5 openGate|6 wiggle|7 vault|8 mend, boost 0|1]',
        g: 'generator progress 0..1 in meta.gens order', p: 'pallet state per meta.pallets order: 0 up|1 dropped|2 broken',
      },
    };
  }
}

export function createMatch(opts) { return new Match(opts); }

export function runMatch(opts) {
  const m = new Match(opts);
  while (!m.over) m.step();
  return m.result();
}
