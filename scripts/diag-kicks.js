// Kicked-generator episodes: what the survivors who were working a gen do when the hunter comes and kicks it, and how
// that turns out. Engine ground truth (the diag may read hidden state; brains never do).
//
// Episode = a genKick event. Participants = survivors who repaired that gen within the last 15 s before the kick.
// Per participant, from the kick until the episode ends (regression stopped / emptied / 90 s):
//   hidNear  : spent >= 60% of the time until the hunter left within 16 m of the gen (not chased)
//   left     : otherwise
//   found    : got chased or hit while within 16 m of the gen during the episode
// Hunter left = first time after the kick the hunter is > 16 m (path-agnostic) from the gen.
// Regression: stopped by repair (delay after the hunter left), emptied, or still running at the end.
//
// Usage: node scripts/diag-kicks.js [--n 48] [--map maps/gas-heaven] [--champ runs/x/champions.json]
//        [--hunter '{"kickMinProgress":0.25}'] [--kicker 0.2] [--s '{"kickHideW":2}'] [--compare]
//   hunter: the param hunter (defaults / --champ / --hunter overrides) wrapped by a probe "kicker": whenever it sees no
//   survivor, carries nobody and stands within reach of a perceived gen with progress >= --kicker (default 0.2; 0 = no
//   wrapper) that isn't regressing, it kicks it. The param hunter alone kicks ~0.2 times a match (default never), too
//   rare to measure the survivors' choice; it walks to gens it hears being repaired, so the wrapper kicks those.
//   --compare: runs leave-always (kickHideW -3, kickHideProgW 0), default and hide-always (kickHideW 3) on the same seeds
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...defaults(B.hunter.space), ...c.hunter }; sp = { ...sp, ...c.survivor }; }
if (a.hunter) hp = { ...hp, ...JSON.parse(a.hunter) };
if (a.s) sp = { ...sp, ...JSON.parse(a.s) };
const n = +(a.n ?? 48);
const NEAR = 16;
const KICK_P = +(a.kicker ?? 0.2);
// probe wrapper (diag only): kick a perceived gen in reach when no survivor is in view
const kicker = (inner) => (ctx) => {
  const b = inner(ctx), skip = new Map();
  let tryG = -1, tryT = -1;
  const rd = (x, z, g) => { const x0 = Math.floor(g.x), z0 = Math.floor(g.z), dx = x < x0 ? x0 - x : (x > x0 + 1 ? x - x0 - 1 : 0), dz = z < z0 ? z0 - z : (z > z0 + 1 ? z - z0 - 1 : 0); return Math.hypot(dx, dz); };
  return { ...b, decide(obs, api) {
    const me = obs.self;
    if (KICK_P > 0 && !obs.survivors.length && me.carrying === null && !obs.gatesPowered) {
      if (me.act === 'kickGen') return { act: 'kickGen', target: obs.gens[tryG]?.id };
      for (let i = 0; i < obs.gens.length; i++) {
        const g = obs.gens[i], st = ctx.map.generators[i];
        if (!g.visible || g.done || g.regressing || g.progress < KICK_P || (g.kicksLeft ?? 1) <= 0 || (skip.get(i) ?? -1) > obs.t) continue;
        if (!st || rd(me.x, me.z, st) > ctx.config.reach.kickGen - 0.05) continue;
        if (tryG !== i) { tryG = i; tryT = obs.t; }
        else if (obs.t - tryT > 0.5) { skip.set(i, obs.t + 10); tryG = -1; continue; }   // not starting: give up on it
        return { act: 'kickGen', target: g.id };
      }
    }
    return b.decide(obs, api);
  } };
};

function run(sp, label) {
  const T = { matches: 0, kicks: 0, eps: 0, part: 0, hid: 0, left: 0, found: 0, foundHid: 0, hits: 0, stopRepair: 0, stopEmpty: 0, open: 0,
    delay: [], lostP: 0, gens: 0, escapes: 0, kills: 0, kickHides: 0, kickReturns: 0, kickLeaves: 0, kickGiveUps: 0 };
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i, sv = [];
    const mk = B.survivor.make(sp);
    const m = createMatch({ map: maps[(1000 + i) % maps.length], seed, hunter: kicker(B.hunter.make(hp)), survivors: (ctx) => { const b = mk(ctx); sv.push(b); return b; } });
    const lastOn = [null, null, null, null];      // { g, t } last gen repaired
    const eps = [];
    let evN = 0;
    while (!m.over) {
      m.step();
      const t = m.t, H = m.hunter;
      for (let k = 0; k < 4; k++) {
        const s = m.survivors[k];
        if (s.curAct === 'repair') { const g = m.gens.find((x) => x.wIds.slice(0, x.lastN).includes(k)); if (g) lastOn[k] = { g, t }; }
      }
      for (; evN < m.events.length; evN++) {
        const e = m.events[evN];
        if (e.type === 'genKick') {
          T.kicks++;
          const g = m.genById.get(e.gen);
          const part = [];
          for (let k = 0; k < 4; k++) if (lastOn[k] && lastOn[k].g === g && t - lastOn[k].t < 15) part.push({ k, nearS: 0, totS: 0, found: false, hit: false });
          eps.push({ g, t0: t, leftT: -1, end: null, endT: -1, p0: g.p, part });
        } else if (e.type === 'genRegressStop') {
          const ep = eps.find((x) => !x.end && x.g.id === e.gen);
          if (ep) { ep.end = e.reason; ep.endT = t; }
        } else if (e.type === 'hit') {
          for (const ep of eps) if (!ep.end) for (const p of ep.part) if (p.k === e.who && Math.hypot(m.survivors[p.k].x - ep.g.x, m.survivors[p.k].z - ep.g.z) < NEAR) p.hit = true;
        }
      }
      for (const ep of eps) {
        if (ep.end) continue;
        if (t - ep.t0 > 90) { ep.end = 'open'; ep.endT = t; continue; }
        const dH = Math.hypot(H.x - ep.g.x, H.z - ep.g.z);
        if (ep.leftT < 0 && dH > NEAR) ep.leftT = t;
        for (const p of ep.part) {
          const s = m.survivors[p.k];
          if (s.st > 1) continue;
          const dS = Math.hypot(s.x - ep.g.x, s.z - ep.g.z);
          if (ep.leftT < 0) { p.totS += m.dt; if (dS < NEAR && m.chaseTgt !== p.k) p.nearS += m.dt; }
          if (dS < NEAR && m.chaseTgt === p.k) p.found = true;
        }
      }
    }
    const r = m.result();
    T.matches++; T.gens += r.gensDone; T.escapes += r.escapes; T.kills += r.kills;
    for (const b of sv) for (const k of ['kickHides', 'kickReturns', 'kickLeaves', 'kickGiveUps']) T[k] += b.stats[k] ?? 0;
    for (const ep of eps) {
      if (!ep.end) ep.end = 'open';
      if (!ep.part.length) continue;
      T.eps++;
      if (ep.end === 'repair') { T.stopRepair++; if (ep.leftT >= 0) T.delay.push(Math.max(0, ep.endT - ep.leftT)); }
      else if (ep.end === 'empty') T.stopEmpty++;
      else T.open++;
      for (const p of ep.part) {
        T.part++;
        const hid = p.totS > 0.5 && p.nearS / p.totS >= 0.6;
        if (hid) T.hid++; else T.left++;
        if (p.found || p.hit) { T.found++; if (hid) T.foundHid++; }
        if (p.hit) T.hits++;
      }
    }
  }
  const f = (v, d = 2) => (v / T.matches).toFixed(d);
  const med = (xs) => { if (!xs.length) return '-'; const s = xs.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(1); };
  const mean = (xs) => (xs.length ? (xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(1) : '-');
  console.log(`\n== ${label} (${T.matches} matches)`);
  console.log(`  gens ${f(T.gens)}  escapes ${f(T.escapes)}  kills ${f(T.kills)}  kicks/match ${f(T.kicks)}  episodes with a participant ${T.eps}`);
  console.log(`  participants ${T.part}: hid near ${T.hid}  left ${T.left}  found/hit near gen ${T.found} (of them hiding ${T.foundHid}, hits ${T.hits})`);
  console.log(`  regression: stopped by repair ${T.stopRepair} (delay after hunter left: median ${med(T.delay)} s, mean ${mean(T.delay)} s)  emptied ${T.stopEmpty}  still running at 90 s / match end ${T.open}`);
  console.log(`  brain stats: kickHides ${T.kickHides}  kickReturns ${T.kickReturns}  kickLeaves ${T.kickLeaves}  kickGiveUps ${T.kickGiveUps}`);
  return T;
}

if (a.compare) {
  run({ ...sp, kickHideW: -3, kickHideProgW: 0 }, 'leave always (kickHideW -3, kickHideProgW 0)');
  run(sp, 'as given');
  run({ ...sp, kickHideW: 3 }, 'hide near always (kickHideW 3)');
} else run(sp, 'as given');
