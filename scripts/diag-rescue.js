// Rescue decisions: per rescue opportunity (a teammate hooked, not killed on the hook), who went for the save and
// whether they were actually the closest, how long into the stage the unhook came, how often 2+ survivors go at once,
// trades (rescuer or rescued downed within 10 s of the unhook), and hook deaths (rescues that never happened).
// Read-only: observes the match (positions, actions, events); never changes a decision.
//
// "Going" = the survivor's action is a move to (within 1 m of) that hook or a rescue of that teammate, for >= 1 s total.
// "Closest" = the shortest walkable path to the hook among standing (healthy/injured) survivors, measured when the
// survivor first goes (and at hook time + 3 s for the "who should have gone" baseline); the chased survivor is not
// counted as a candidate (it can't go).
//
// Usage: node scripts/diag-rescue.js [--n 48] [--map maps/gas-heaven] [--champ runs/<run>/champions.json] [--seed 1000]
//        [--set rescueThreshold=0.5,rescueCampFear=1]   (survivor knob overrides)
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
if (a.set) for (const kv of a.set.split(',')) { const [k, v] = kv.split('='); if (!(k in B.survivor.space)) throw new Error('unknown survivor knob ' + k); sp = { ...sp, [k]: +v }; }
const n = +(a.n ?? 48), seed0 = +(a.seed ?? 1000);
const STAND = (st) => st === 0 || st === 1;

const R = {
  opps: 0, rescued: 0, selfUnhook: 0, hookDeath: 0, otherEnd: 0, nobodyWent: 0,
  goers: 0, multi: 0, maxConc: [0, 0, 0, 0], closestWent: 0, firstWasClosest: 0, firstOpps: 0,
  goerWasClosest: 0, rescuerWasClosest: 0, rescuerOpps: 0, trades: 0, rescuerDown: 0, rescuedDown: 0,
  stageInto: [], sinceHook: [], firstGoDelay: [], extraDist: [], stage2: { opps: 0, rescued: 0, deaths: 0 },
};
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const seed = seed0 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const S = m.survivors, dt = m.dt ?? 0.1;
  const open = new Map();     // victim id -> opportunity
  const recent = [];          // finished rescues awaiting the 10 s trade window
  let evRead = 0;
  const pathD = (s, hk) => s.nav.dist({ x: s.x, z: s.z }, { x: hk.x, z: hk.z });
  const standingDists = (hk, victim) => S.filter((s) => s.id !== victim && STAND(s.st) && m.chaseTgt !== s.id).map((s) => ({ id: s.id, d: pathD(s, hk) }));
  while (!m.over) {
    m.step();
    for (; evRead < m.events.length; evRead++) {
      const e = m.events[evRead];
      if (e.type === 'hook' && S[e.who].st === 4) {
        const hk = m.hooks.find((h) => h.id === e.hook);
        open.set(e.who, { who: e.who, hk, t: m.t, stage: e.stage, go: new Map(), first: null, conc: 0, base: null });
        R.opps++; if (e.stage >= 2) R.stage2.opps++;
      } else if (e.type === 'rescue' || e.type === 'selfUnhook' || (e.type === 'death' && open.has(e.who))) {
        const o = open.get(e.who); if (!o) continue;
        open.delete(e.who);
        const goers = [...o.go.entries()].filter(([, g]) => g.s >= 1);
        R.goers += goers.length; if (goers.length >= 2) R.multi++; if (!goers.length) R.nobodyWent++;
        R.maxConc[Math.min(3, o.conc)]++;
        if (o.base && o.base.length) {
          const cl = o.base.reduce((x, y) => (y.d < x.d ? y : x));
          if (goers.some(([id]) => id === cl.id)) R.closestWent++;
        }
        for (const [, g] of goers) if (g.closest) R.goerWasClosest++;
        if (o.first !== null) { R.firstOpps++; if (o.go.get(o.first).closest) R.firstWasClosest++; R.firstGoDelay.push(o.go.get(o.first).t - o.t); }
        if (e.type === 'rescue') {
          R.rescued++; if (o.stage >= 2) R.stage2.rescued++;
          R.stageInto.push(o.into); R.sinceHook.push(m.t - o.t);
          const g = o.go.get(e.by);
          if (g) { R.rescuerOpps++; if (g.closest) R.rescuerWasClosest++; if (isFinite(g.extra)) R.extraDist.push(g.extra); }
          recent.push({ by: e.by, who: e.who, t: m.t, done: false });
        } else if (e.type === 'selfUnhook') R.selfUnhook++;
        else if (e.cause === 'hookDeath') { R.hookDeath++; if (o.stage >= 2) R.stage2.deaths++; }
        else R.otherEnd++;
      } else if (e.type === 'hit' && e.state === 'downed') {
        for (const r of recent) {
          if (r.done || m.t - r.t > 10) continue;
          if (e.who === r.by || e.who === r.who) { r.done = true; R.trades++; if (e.who === r.by) R.rescuerDown++; else R.rescuedDown++; }
        }
      }
    }
    for (const o of open.values()) {
      const v = S[o.who];
      if (v.st === 4) o.into = 70 - v.hookTimer;
      if (!o.base && m.t - o.t >= 3) o.base = standingDists(o.hk, o.who);
      let conc = 0;
      for (const s of S) {
        if (s.id === o.who || !STAND(s.st)) continue;
        const A = s.lastAction || {};
        const going = (A.act === 'rescue' && (A.target === o.who || A.target === undefined) && Math.hypot(s.x - o.hk.x, s.z - o.hk.z) < 2.5)
          || (A.moveTo && Math.hypot(A.moveTo.x - o.hk.x, A.moveTo.z - o.hk.z) < 1);
        if (!going) continue;
        conc++;
        let g = o.go.get(s.id);
        if (!g) {
          const ds = standingDists(o.hk, o.who).concat(m.chaseTgt === s.id ? [{ id: s.id, d: pathD(s, o.hk) }] : []), mine = ds.find((x) => x.id === s.id).d, best = Math.min(...ds.map((x) => x.d));
          g = { t: m.t, s: 0, closest: mine <= best + 0.01, extra: mine - best };
          o.go.set(s.id, g);
        }
        g.s += dt;
        if (o.first === null && g.s >= 1) o.first = s.id;
      }
      o.conc = Math.max(o.conc, conc);
    }
  }
  for (const o of open.values()) { R.otherEnd++; void o; }
}
const pct = (x, y) => (y ? (100 * x / y).toFixed(0) + '%' : '-');
const med = (v) => { if (!v.length) return '-'; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(1); };
const mean = (v) => (v.length ? (v.reduce((x, y) => x + y, 0) / v.length).toFixed(1) : '-');
const hist = (v, edges) => edges.map((e, k) => `${k ? edges[k - 1] : 0}-${e}:${v.filter((x) => x >= (k ? edges[k - 1] : 0) && x < e).length}`).join(' ');
console.log(`${n} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${R.opps} rescue opportunities (${(R.opps / n).toFixed(2)}/match; stage-2 hooks ${R.stage2.opps})`);
console.log(`outcome: rescued ${R.rescued} (${pct(R.rescued, R.opps)})  self-unhook ${R.selfUnhook}  hook deaths ${R.hookDeath} (${pct(R.hookDeath, R.opps)})  other end (match over / allDown) ${R.otherEnd}`);
console.log(`stage-2 hooks: rescued ${R.stage2.rescued}/${R.stage2.opps}, hook deaths ${R.stage2.deaths}`);
console.log(`goers/opportunity ${(R.goers / Math.max(1, R.opps)).toFixed(2)}  nobody went ${R.nobodyWent} (${pct(R.nobodyWent, R.opps)})  2+ went ${R.multi} (${pct(R.multi, R.opps)})  max concurrent 0/1/2/3+: ${R.maxConc.join('/')}`);
console.log(`closest (at hook+3 s) went: ${pct(R.closestWent, R.opps)}  first goer was closest (when going): ${pct(R.firstWasClosest, R.firstOpps)}  any goer closest: ${pct(R.goerWasClosest, R.goers)}  rescuer closest: ${pct(R.rescuerWasClosest, R.rescuerOpps)}`);
console.log(`rescuer's extra path vs the closest when it went: median ${med(R.extraDist)} m, mean ${mean(R.extraDist)} m`);
console.log(`first go after hook: median ${med(R.firstGoDelay)} s   unhook after hook: median ${med(R.sinceHook)} s   time into the stage at unhook: median ${med(R.stageInto)} s  [${hist(R.stageInto, [10, 20, 30, 40, 50, 60, 71])}]`);
console.log(`trades (rescuer/rescued downed within 10 s): ${R.trades}/${R.rescued} (${pct(R.trades, R.rescued)})  rescuer ${R.rescuerDown}  rescued ${R.rescuedDown}`);
