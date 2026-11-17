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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { createPool } from '../src/hillclimb/pool.js';
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';

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
const pool = createPool({ threads: +(args.threads ?? Math.max(1, cpus().length - 1)), mapPath: resolve(args.map ?? 'maps/gas-heaven'), hunterBrain: hb, survivorBrain: sb });
const seeds = Array.from({ length: K }, (_, k) => 900001 + 7919 * k);

function analyse(name, F) {           // F[i][k]: fitness of individual i on seed k
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
  return { icc, sw2, sb2 };
}

const t0 = Date.now();
if (side !== 'hunter') {
  const jobs = [];
  S.forEach((sp, i) => seeds.forEach((seed, k) => jobs.push({ seed, hunterParams: H[k % H.length], survivorParams: sp, tag: { i, k } })));
  const res = await pool.run(jobs);
  const F = S.map(() => new Array(K));
  for (const r of res) F[r.i][r.k] = r.survivorFit;
  analyse('survivor teams (survivorFit)', F);
}
if (side !== 'survivor') {
  const jobs = [];
  H.forEach((hp, i) => seeds.forEach((seed, k) => jobs.push({ seed, hunterParams: hp, survivorParams: S[k % S.length], tag: { i, k } })));
  const res = await pool.run(jobs);
  const F = H.map(() => new Array(K));
  for (const r of res) F[r.i][r.k] = r.hunterFit;
  analyse('hunters (hunterFit)', F);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`);
pool.close();
