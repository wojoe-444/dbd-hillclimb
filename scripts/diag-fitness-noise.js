#!/usr/bin/env node
// How much of a population's fitness ranking is signal? Takes one generation of an evolve.js run (default: the last line
// of its evo.jsonl), plays every survivor team on the SAME K seeds (common random numbers; the hunter for seed k is
// hunter k mod N, also the same for every team) and splits the variance of the per-match survivor fitness into
//   between-team (real differences between parameter sets)  vs  within-team (map variant, spawns, hunter, chaos).
// Reports the intra-class correlation, the reliability of a K-match mean, the matches per individual needed for a
// given reliability, and how much pairing on common seeds shrinks the variance of a two-team comparison.
// The same is done for the hunters (each hunter on the same K seeds against survivor team k mod N).
//
//   node scripts/diag-fitness-noise.js --from <run>/evo.jsonl [--gen last] [--k 32] [--map maps/gas-heaven]
//                                      [--side both|survivor|hunter] [--threads N] [--brains param,param]
//                                      [--mode common|random|panel|all] [--panel-top 3] [--json out.json]
// Modes (how the opponents/seeds of the K matches are chosen; 'common' is the historical behaviour):
//   common  seed k and opponent k mod N shared by every individual (common random numbers)
//   random  a fresh seed and a random opponent per match (what evolve.js does without --paired / --panel)
//   panel   evolve.js --panel: opponent k mod P from a fixed panel (defaults + the opposite side's top --panel-top),
//           seed k shared by every individual
// Every mode also prints the slot-centred reliability (selection.js: the shared per-seed/opponent effect removed,
// which is what a ranking on common slots actually sees; equal to raw in 'random' mode, where nothing is shared).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { createPool } from '../src/hillclimb/pool.js';
import { modsFromArgv } from '../src/sim/modifiers.js';   // --mod genSeconds=80 (game modifiers)
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams, rng } from '../src/hillclimb/params.js';
import { reliability } from '../src/hillclimb/selection.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
if (!args.from) { console.error('usage: --from <run>/evo.jsonl'); process.exit(1); }
const lines = readFileSync(resolve(args.from), 'utf8').trim().split('\n').map(JSON.parse);
const G = args.gen && args.gen !== 'last' ? lines.find((l) => l.gen === +args.gen) : lines[lines.length - 1];
const K = +(args.k ?? 32), side = args.side ?? 'both';
const [hb, sb] = (args.brains ?? 'param,param').split(',');
// knobs added since the run take their defaults; knobs since removed are dropped
const B = getBrains(hb, sb), fill = (space, p) => clampParams(space, { ...defaults(space), ...p });
const H = G.hunters.ranking.map((x) => fill(B.hunter.space, x.params)), S = G.survivors.ranking.map((x) => fill(B.survivor.space, x.params));
const pool = createPool({ threads: +(args.threads ?? Math.max(1, cpus().length - 1)), mapPath: resolve(args.map ?? 'maps/gas-heaven'), hunterBrain: hb, survivorBrain: sb, mods: modsFromArgv(argv) });
const seeds = Array.from({ length: K }, (_, k) => 900001 + 7919 * k);

const report = { from: args.from, gen: G.gen, k: K, results: [] };
function analyse(name, F, mode = 'common') {           // F[i][k]: fitness of individual i on seed k
  const n = F.length, mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const mi = F.map(mean), grand = mean(mi);
  const sw2 = mean(F.map((r, i) => r.reduce((a, x) => a + (x - mi[i]) ** 2, 0) / (K - 1)));   // within-individual variance
  const sm2 = mi.reduce((a, x) => a + (x - grand) ** 2, 0) / (n - 1);                           // variance of the K-match means
  const sb2 = Math.max(0, sm2 - sw2 / K);                                                        // true between-individual variance
  const icc = sb2 / (sb2 + sw2);
  const rel = (k) => sb2 / (sb2 + sw2 / k);
  const need = (r) => (sb2 > 0 ? Math.ceil((r / (1 - r)) * (sw2 / sb2)) : Infinity);
  // pairing: variance of a per-seed difference vs the unpaired sum of variances
  let vp = 0, vu = 0, np = 0;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const d = F[a].map((x, k) => x - F[b][k]), md = mean(d);
    vp += d.reduce((s, x) => s + (x - md) ** 2, 0) / (K - 1);
    vu += F[a].reduce((s, x) => s + (x - mi[a]) ** 2, 0) / (K - 1) + F[b].reduce((s, x) => s + (x - mi[b]) ** 2, 0) / (K - 1);
    np++;
  }
  const top = mi.map((x, i) => [x, i]).sort((p, q) => q[0] - p[0]).slice(0, 5).map(([x, i]) => `#${i}:${x.toFixed(3)}`).join(' ');
  console.log(`\n${name}: ${n} individuals x ${K} common seeds (gen ${G.gen})`);
  console.log(`  fitness mean ${grand.toFixed(3)}  within-sd ${Math.sqrt(sw2).toFixed(3)}  between-sd ${Math.sqrt(sb2).toFixed(3)}  ICC ${icc.toFixed(3)}`);
  console.log(`  reliability of a mean over 8 / 16 / 64 matches: ${rel(8).toFixed(2)} / ${rel(16).toFixed(2)} / ${rel(64).toFixed(2)}`);
  console.log(`  matches per individual for reliability 0.5 / 0.8 / 0.9: ${need(0.5)} / ${need(0.8)} / ${need(0.9)}`);
  console.log(`  common seeds: a pairwise difference has ${(100 * vp / vu).toFixed(0)}% of the unpaired variance`);
  console.log(`  re-measured ranking top 5 (index = evo.jsonl rank): ${top}`);
  const c = reliability(F, { centred: mode !== 'random' });
  if (mode !== 'random') console.log(`  slot-centred (CRN): ICC ${c.icc}  reliability 8 / 16 / 48 matches: ${[8, 16, 48].map((k) => (c.icc ? (k * c.icc / (1 + (k - 1) * c.icc)).toFixed(2) : '-')).join(' / ')}  matches for 0.8: ${c.need80}  split-half ${c.split}`);
  report.results.push({ name, mode, n, icc: +icc.toFixed(4), rel16: +rel(16).toFixed(3), need80: need(0.8), pairedVarShare: +(vp / vu).toFixed(3), centred: c });
  return { icc, sw2, sb2 };
}

const modes = (args.mode ?? 'common') === 'all' ? ['random', 'common', 'panel'] : [args.mode ?? 'common'];
const ptop = +(args['panel-top'] ?? 3);
const t0 = Date.now();
// opponents for the K matches of individual i: [{ seed, opp }]
function plan(mode, opps, i) {
  if (mode === 'random') { const R = rng(1000003 * (i + 1) + 17); return seeds.map(() => ({ seed: Math.floor(R() * 2 ** 31), opp: opps[Math.floor(R() * opps.length)] })); }
  if (mode === 'panel') return seeds.map((seed, k) => ({ seed, opp: opps[k % opps.length] }));
  return seeds.map((seed, k) => ({ seed, opp: opps[k % opps.length] }));
}
for (const mode of modes) {
  console.log(`
=== mode ${mode} ===`);
  if (side !== 'hunter') {
    const opps = mode === 'panel' ? [defaults(B.hunter.space), ...H.slice(0, ptop)] : H;
    const jobs = [];
    S.forEach((sp, i) => plan(mode, opps, i).forEach(({ seed, opp }, k) => jobs.push({ seed, hunterParams: opp, survivorParams: sp, tag: { i, k } })));
    const res = await pool.run(jobs);
    const F = S.map(() => new Array(K));
    for (const r of res) F[r.i][r.k] = r.survivorFit;
    analyse(`survivor teams (survivorFit) [${mode}]`, F, mode);
  }
  if (side !== 'survivor') {
    const opps = mode === 'panel' ? [defaults(B.survivor.space), ...S.slice(0, ptop)] : S;
    const jobs = [];
    H.forEach((hp, i) => plan(mode, opps, i).forEach(({ seed, opp }, k) => jobs.push({ seed, hunterParams: hp, survivorParams: opp, tag: { i, k } })));
    const res = await pool.run(jobs);
    const F = H.map(() => new Array(K));
    for (const r of res) F[r.i][r.k] = r.hunterFit;
    analyse(`hunters (hunterFit) [${mode}]`, F, mode);
  }
}
console.log(`
${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (args.json) writeFileSync(resolve(args.json), JSON.stringify(report, null, 2));
pool.close();
