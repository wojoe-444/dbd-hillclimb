#!/usr/bin/env node
// Paired A/B of survivor parameter sets on common seeds, all played through the 'ctx' brain (a superset of 'param':
// with every ctx_* weight at 0 it plays bit-identically to 'param', so param sets are compared on the same footing).
// Each entry: 'default' (param defaults), or a champions.json / population.json path (its best survivor).
//
//   node scripts/ab-ctx.js --a default --b runs/smoke-ctx/champions.json [--c ...] [--n 128] [--hunter <champions.json>]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { createPool } from '../src/hillclimb/pool.js';
import { modsFromArgv } from '../src/sim/modifiers.js';   // --mod genSeconds=80 (game modifiers)
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const B = getBrains('param', 'ctx'), n = +(args.n ?? 128);
const load = (spec, side) => {
  const space = side === 'hunter' ? B.hunter.space : B.survivor.space;
  if (!spec || spec === 'default') return defaults(space);
  const j = JSON.parse(readFileSync(resolve(spec), 'utf8'));
  const p = j.champ ? j.champ[side] : j.best[side];
  return clampParams(space, { ...defaults(space), ...p });
};
const arms = ['a', 'b', 'c', 'd'].filter((k) => args[k]).map((k) => ({ name: args[k], p: load(args[k], 'survivor') }));
const hp = load(args.hunter, 'hunter');
const pool = createPool({ threads: +(args.threads ?? Math.max(1, cpus().length - 1)), mapPath: resolve(args.map ?? 'maps/gas-heaven'), hunterBrain: 'param', survivorBrain: 'ctx', mods: modsFromArgv(argv) });
const seeds = Array.from({ length: n }, (_, k) => 500001 + 104729 * k);
const jobs = [];
arms.forEach((a, i) => seeds.forEach((seed, k) => jobs.push({ seed, hunterParams: hp, survivorParams: a.p, tag: { i, k } })));
const res = await pool.run(jobs);
const F = arms.map(() => []), O = arms.map(() => ({ kills: 0, escapes: 0, gens: 0, bp: 0 }));
for (const r of res) { F[r.i][r.k] = r.survivorFit; const o = O[r.i]; o.kills += r.kills / n; o.escapes += r.escapes / n; o.gens += r.gensDone / n; o.bp += r.survivorBP / n; }
const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
arms.forEach((a, i) => {
  const o = O[i];
  let line = `${a.name.padEnd(36)} fit ${mean(F[i]).toFixed(4)}  kills ${o.kills.toFixed(2)} esc ${o.escapes.toFixed(2)} gens ${o.gens.toFixed(2)} BP ${Math.round(o.bp)}`;
  if (i > 0) {
    const d = F[i].map((x, k) => x - F[0][k]), md = mean(d), se = Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / (n - 1) / n);
    line += `   vs ${arms[0].name}: ${md >= 0 ? '+' : ''}${md.toFixed(4)} +- ${se.toFixed(4)} (paired se, n ${n})`;
  }
  console.log(line);
});
pool.close();
