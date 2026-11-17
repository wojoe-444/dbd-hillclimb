#!/usr/bin/env node
// Per-knob sensitivity of one param set against a FIXED opponent on FIXED held-out seeds: every knob is moved
// +-sigma x range (clamped) on its own and the paired per-seed fitness difference to the unperturbed set is reported.
// Finds knobs that matter, knobs that look inert at this point (|t| < 1 both ways), and knobs pinned at a range edge
// that still want to move past it.
//
// Usage: node scripts/knob-sensitivity.js --set runs/evo-v15 --side survivor [--vs default] [--n 32] [--sigma 0.15]
//          [--knobs a,b,c] [--map maps/gas-heaven] [--threads N] [--seed-base 2147483648] [--json out.json]
//          [--mod genSeconds=80]   (game modifiers, src/sim/modifiers.js)
// Set specs: see src/hillclimb/evalplan.js resolveParamSet. Fitness is the side's evolution fitness (worker/play.js):
// survivor = 0.5 x normalised BP + 0.5 x time-weighted survival; hunter = outcome table / 100.
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getBrains } from '../src/brains/index.js';
import { createPool } from '../src/hillclimb/pool.js';
import { resolveParamSet, heldOutSeeds, HELDOUT_BASE, gitInfo, modMismatches } from '../src/hillclimb/evalplan.js';
import { modsFromArgv, modsRecord, describeMods } from '../src/sim/modifiers.js';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const side = args.side ?? 'survivor';
if (side !== 'survivor' && side !== 'hunter') throw new Error('--side survivor|hunter');
const other = side === 'survivor' ? 'hunter' : 'survivor';
const B = getBrains(args.hunter ?? 'param', args.survivor ?? 'param');
const spaces = { hunter: B.hunter.space, survivor: B.survivor.space };
const space = spaces[side];
const set = resolveParamSet(args.set ?? 'default', spaces);
const vs = resolveParamSet(args.vs ?? 'default', spaces);
const mods = modsFromArgv(argv);
if (Object.keys(mods).length) console.log(`GAME MODIFIERS: ${describeMods(mods)} (non-standard rules)`);
for (const w of new Set(modMismatches([set, vs], mods))) console.warn(w);
const seeds = heldOutSeeds(+(args.n ?? 32), +(args['seed-base'] ?? HELDOUT_BASE));
const sigma = +(args.sigma ?? 0.15);
const threads = +(args.threads ?? Math.max(1, cpus().length - 1));
const knobs = args.knobs ? String(args.knobs).split(',') : Object.keys(space);
const fitKey = side === 'survivor' ? 'survivorFit' : 'hunterFit';
const base = set[side];
if (set.stale[side]) console.log(`note: ${set.name} ${side}: ${set.stale[side].missing.length} knobs missing (today's default used), ${set.stale[side].dropped.length} dropped`);

// variants: base + each knob up / down (skipped when clamping leaves the value unchanged, i.e. at that edge)
const variants = [{ key: 'base', knob: null, dir: 0, params: base }];
for (const k of knobs) {
  const [lo, hi] = space[k];
  for (const dir of [-1, 1]) {
    const v = Math.min(hi, Math.max(lo, base[k] + dir * sigma * (hi - lo)));
    if (Math.abs(v - base[k]) > 1e-9) variants.push({ key: `${k}${dir > 0 ? '+' : '-'}`, knob: k, dir, value: v, params: { ...base, [k]: v } });
  }
}
const jobs = [];
variants.forEach((v, vi) => { for (const seed of seeds) jobs.push({ seed, hunterParams: side === 'hunter' ? v.params : vs.hunter, survivorParams: side === 'survivor' ? v.params : vs.survivor, tag: { vi } }); });
console.log(`knob sensitivity: ${set.name} ${side} vs ${vs.name} ${other}; ${knobs.length} knobs, ${variants.length} variants x ${seeds.length} held-out seeds = ${jobs.length} matches, sigma ${sigma} of range`);
const t0 = Date.now();
const pool = createPool({ threads, mapPath: resolve(args.map ?? 'maps/gas-heaven'), hunterBrain: args.hunter ?? 'param', survivorBrain: args.survivor ?? 'param', mods });
const results = await pool.run(jobs);
pool.close();

const bySeed = variants.map(() => new Map());
for (const r of results) bySeed[r.vi].set(r.seed, r);
const baseRes = bySeed[0];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const paired = (vi, key) => {
  const d = seeds.map((s) => bySeed[vi].get(s)[key] - baseRes.get(s)[key]);
  const m = mean(d), sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
  const se = sd / Math.sqrt(d.length);
  return { d: m, se, t: se > 0 ? m / se : (m === 0 ? 0 : 99 * Math.sign(m)), same: d.filter((x) => x === 0).length };
};
const outcomeKeys = side === 'survivor' ? ['escapes', 'gensDone'] : ['kills', 'hookStages'];
const baseFit = mean(seeds.map((s) => baseRes.get(s)[fitKey]));
const baseOut = Object.fromEntries(outcomeKeys.map((k) => [k, mean(seeds.map((s) => baseRes.get(s)[k]))]));

const rows = knobs.map((k) => {
  const [lo, hi] = space[k];
  const pos = (base[k] - lo) / (hi - lo);
  const row = { knob: k, value: base[k], lo, hi, pos: +pos.toFixed(3), edge: pos <= 0.05 ? 'lo' : pos >= 0.95 ? 'hi' : '' };
  for (const dir of [-1, 1]) {
    const vi = variants.findIndex((v) => v.knob === k && v.dir === dir);
    const tag = dir > 0 ? 'up' : 'down';
    if (vi < 0) { row[tag] = null; continue; }
    const f = paired(vi, fitKey);
    row[tag] = { value: +variants[vi].value.toFixed(4), dFit: +f.d.toFixed(4), se: +f.se.toFixed(4), t: +f.t.toFixed(2), identical: f.same, ...Object.fromEntries(outcomeKeys.map((o) => [`d_${o}`, +paired(vi, o).d.toFixed(3)])) };
  }
  const ts = [row.down, row.up].filter(Boolean).map((x) => Math.abs(x.t));
  row.maxT = ts.length ? Math.max(...ts) : 0;
  // "wants": the move that improves fitness with |t| >= 2 (both ways => this is a local minimum or noise; say so)
  const better = [row.down, row.up].map((x, i) => (x && x.t >= 2 ? (i ? 'up' : 'down') : null)).filter(Boolean);
  row.wants = better.join('+');
  // identical: every seed replayed the exact same fitness (typically a threshold knob whose switch was not crossed)
  const moves = [row.down, row.up].filter(Boolean);
  const allSame = moves.length && moves.every((x) => x.identical === seeds.length);
  row.verdict = row.maxT >= 2 ? 'matters' : allSame ? 'no effect (identical games)' : row.maxT < 1 ? 'inert here' : 'weak';
  // pinned: sits at an edge and the only available move (away from the edge) hurts => it wants past the bound
  if (row.edge === 'hi' && row.down && row.down.t <= -2) row.verdict += ', pinned hi (range may bind)';
  if (row.edge === 'lo' && row.up && row.up.t <= -2) row.verdict += ', pinned lo (range may bind)';
  return row;
}).sort((a, b) => b.maxT - a.maxT);

const fx = (x) => (x ? `${x.dFit >= 0 ? '+' : ''}${x.dFit.toFixed(3)} (t ${x.t.toFixed(1)})` : '   at edge   ');
const kw = Math.max(...rows.map((r) => r.knob.length)) + 2;
console.log(`\nbase ${side} fitness ${baseFit.toFixed(4)}  ${outcomeKeys.map((k) => `${k} ${baseOut[k].toFixed(2)}`).join('  ')}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`${'knob'.padEnd(kw)}${'value'.padEnd(10)}${'pos'.padEnd(6)}${'down: dFit (t)'.padEnd(20)}${'up: dFit (t)'.padEnd(20)}verdict`);
for (const r of rows) console.log(`${r.knob.padEnd(kw)}${String(+r.value.toFixed(3)).padEnd(10)}${r.pos.toFixed(2).padEnd(6)}${fx(r.down).padEnd(20)}${fx(r.up).padEnd(20)}${r.verdict}${r.wants ? `; better ${r.wants}` : ''}`);
const n = (f) => rows.filter(f).length;
console.log(`\n${n((r) => r.verdict.startsWith('matters'))} matter (|t| >= 2), ${n((r) => r.verdict.startsWith('weak'))} weak, ${n((r) => r.verdict.startsWith('inert'))} inert here, ${n((r) => r.verdict.startsWith('no effect'))} with no effect at all (identical games); ${n((r) => r.edge)} at a range edge (${n((r) => r.verdict.includes('pinned'))} pinned against it)`);
// Chaos baseline: any game-changing perturbation re-rolls the (chaotic) matches, so if the base happened to do well on
// these seeds, nearly every variant shows a negative dFit (regression to the mean). Read dFit relative to this median.
const moved = rows.flatMap((r) => [r.down, r.up]).filter((x) => x && x.identical < seeds.length).map((x) => x.dFit).sort((a, b) => a - b);
const chaosMedian = moved.length ? moved[moved.length >> 1] : 0;
console.log(`chaos baseline: median dFit of the ${moved.length} game-changing variants ${chaosMedian >= 0 ? '+' : ''}${chaosMedian.toFixed(3)} ` +
  `(${moved.filter((x) => x < 0).length} negative). If clearly below 0 the base was lucky on these seeds: treat dFit near it as noise, use more --n.`);

if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ git: gitInfo(), ...modsRecord(mods), set: { name: set.name, source: set.source, stale: set.stale }, side, vs: vs.name, sigma, seeds: { first: seeds[0], n: seeds.length }, baseFit, baseOut, chaosMedian, rows }, null, 2));
