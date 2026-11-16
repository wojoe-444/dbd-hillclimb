// A/B for the survivor hiding features (belief about an unseen hunter + cover), same seeds: off = hiding and
// belief-driven gen choice switched off (= the pre-hiding brain); def = default knobs; hide = defaults + hideThreat 0.6.
// Reports outcomes, wall ms per game-second, and hide diagnostics
// (share of survivor decisions spent hiding, hides per match, chases on a survivor that began within 5 s of hiding).
//
// Usage: node scripts/ab-hide.js [--n 48] [--map maps/gas-heaven] [--champ runs/<run>/champions.json] [--set '{...}' (all configs)] [--hide '{...}' (extra knobs for the hide config)] [--reps 3]
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { runMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
sp = { ...defaults(B.survivor.space), ...sp, ...(a.set ? JSON.parse(a.set) : {}) };
const OFF = { hideThreat: 1.05, hideOnLayer: 0, hideOnClosing: 0, genThreatW: 0, genCoverW: 0 };
const n = +(a.n ?? 48);

const HIDE = { hideThreat: 0.6, ...(a.hide ? JSON.parse(a.hide) : {}) };
const reps = +(a.reps ?? 1);

function run(params, label, quiet) {
  const tot = { decideMs: 0, kills: 0, escapes: 0, gens: 0, hooks: 0, dur: 0, decides: 0, hideTicks: 0, hides: 0, found: 0, chases: 0 };
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i, brains = [];
    const mk = B.survivor.make(params);
    const r = runMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: (ctx) => {
      const t1 = performance.now(), b = mk(ctx); tot.decideMs += performance.now() - t1;   // construction counts too
      const d = b.decide; b.decide = (o, api) => { const t2 = performance.now(), r = d.call(b, o, api); tot.decideMs += performance.now() - t2; return r; };
      brains.push(b); return b;
    } });
    tot.kills += r.kills; tot.escapes += r.escapes; tot.gens += r.gensDone; tot.hooks += r.hooks; tot.dur += r.durationS;
    for (const b of brains) if (b.stats) for (const k of ['decides', 'hideTicks', 'hides', 'found', 'chases']) tot[k] += b.stats[k];
  }
  const ms = performance.now() - t0, f = (v) => (v / n).toFixed(2);
  if (!quiet) console.log(`${label.padEnd(4)} kills ${f(tot.kills)}  escapes ${f(tot.escapes)}  gens ${f(tot.gens)}  hooks ${f(tot.hooks)}  dur ${f(tot.dur)}s  | ` +
    `hiding ${(100 * tot.hideTicks / Math.max(1, tot.decides)).toFixed(1)}% of decisions, ${f(tot.hides)} hides/match, ` +
    `found ${tot.found}/${tot.hides} (${(100 * tot.found / Math.max(1, tot.hides)).toFixed(0)}%), chases on survivors ${f(tot.chases)}/match`);
  return { perS: ms / tot.dur, usPerDecide: 1000 * tot.decideMs / Math.max(1, tot.decides), share: tot.decideMs / ms };
}
const cfgs = [['off', { ...sp, ...OFF }], ['def', sp], ['hide', { ...sp, ...HIDE }]];
const cost = cfgs.map(() => []);
for (let r = 0; r < reps; r++) cfgs.forEach(([l, c], k) => cost[k].push(run(c, l, r > 0)));   // interleaved repeats for timing
const med = (v) => v.slice().sort((x, y) => x - y)[v.length >> 1];
const M = cfgs.map((_, k) => ({ perS: med(cost[k].map((c) => c.perS)), us: med(cost[k].map((c) => c.usPerDecide)), share: med(cost[k].map((c) => c.share)) }));
console.log('wall ms per game-second (median of ' + reps + '; confounded by how many survivors are alive): ' + cfgs.map(([l], k) => `${l} ${M[k].perS.toFixed(3)}`).join('  '));
console.log('survivor brain cost per decision (incl. construction): ' + cfgs.map(([l], k) => `${l} ${M[k].us.toFixed(1)} us (${(100 * M[k].share).toFixed(1)}% of match time)`).join('  '));
for (const k of [1, 2]) console.log(`  ${cfgs[k][0]}: extra survivor-brain time vs off ~ ${(100 * M[k].share * (1 - M[0].us / M[k].us)).toFixed(1)}% of match time`);
