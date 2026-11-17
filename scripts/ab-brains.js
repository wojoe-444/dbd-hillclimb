#!/usr/bin/env node
// Paired A/B of survivor BRAINS + parameter sets on common seeds (same seeds as ab-ctx.js) vs one hunter.
// Each arm: <brain>:<params>, params = 'default' or a champions.json / population.json path (its best survivor).
//
//   node scripts/ab-brains.js --a param:default --b goal:default [--c goal:runs/smoke-goal/champions.json] [--n 128]
//        [--hunter <champions.json>] [--threads N] [--map maps/gas-heaven]
// Prints per-arm fitness / kills / escapes / gens / BP and the paired difference vs arm a (+- paired standard error).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { createPool } from '../src/hillclimb/pool.js';
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const n = +(args.n ?? 128), threads = +(args.threads ?? Math.max(1, cpus().length - 1));
const load = (spec, space, side) => {
  if (!spec || spec === 'default') return defaults(space);
  const j = JSON.parse(readFileSync(resolve(spec), 'utf8'));
  const p = j.champ ? j.champ[side] : j.best[side];
  return clampParams(space, { ...defaults(space), ...p });
};
const arms = ['a', 'b', 'c', 'd', 'e'].filter((k) => args[k]).map((k) => {
  const s = String(args[k]), i = s.indexOf(':'), brain = i > 0 ? s.slice(0, i) : 'param', spec = i > 0 ? s.slice(i + 1) : s;
  const B = getBrains('param', brain);
  return { name: `${brain}:${spec}`, brain, p: load(spec, B.survivor.space, 'survivor') };
});
const hp = load(args.hunter, getBrains().hunter.space, 'hunter');
const seeds = Array.from({ length: n }, (_, k) => 500001 + 104729 * k);
const F = arms.map(() => []), O = arms.map(() => ({ kills: 0, escapes: 0, gens: 0, bp: 0 }));
const t0 = Date.now();
for (const brain of [...new Set(arms.map((a) => a.brain))]) {
  const pool = createPool({ threads, mapPath: resolve(args.map ?? 'maps/gas-heaven'), hunterBrain: 'param', survivorBrain: brain });
  const jobs = [];
  arms.forEach((a, i) => { if (a.brain === brain) seeds.forEach((seed, k) => jobs.push({ seed, hunterParams: hp, survivorParams: a.p, tag: { i, k } })); });
  for (const r of await pool.run(jobs)) { F[r.i][r.k] = r.survivorFit; const o = O[r.i]; o.kills += r.kills / n; o.escapes += r.escapes / n; o.gens += r.gensDone / n; o.bp += r.survivorBP / n; }
  pool.close();
}
const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
console.log(`${arms.length} arms x ${n} seeds in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
arms.forEach((a, i) => {
  const o = O[i];
  let line = `${a.name.padEnd(40)} fit ${mean(F[i]).toFixed(4)}  kills ${o.kills.toFixed(2)} esc ${o.escapes.toFixed(2)} gens ${o.gens.toFixed(2)} BP ${Math.round(o.bp)}`;
  if (i > 0) {
    const d = F[i].map((x, k) => x - F[0][k]), md = mean(d), se = Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / (n - 1) / n);
    line += `   vs ${arms[0].name}: ${md >= 0 ? '+' : ''}${md.toFixed(4)} +- ${se.toFixed(4)}`;
  }
  console.log(line);
});
