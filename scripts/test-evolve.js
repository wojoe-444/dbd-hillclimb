#!/usr/bin/env node
// End-to-end checks for evolve.js (runs tiny evolutions on maps/test-small.json as child processes, ~2-4 min):
//  1. default flags reproduce the pre-selection-fix evolve.js (git ref --base, default 940a8f6) byte-identically:
//     evo.jsonl after dropping the known additive fields (seconds, perf, selection, ranking[].fitSd),
//     population.json and champions.json as they are;
//  2. --panel --race (GA) and --opt cmaes (with and without --panel/--race) are deterministic for a fixed seed,
//     independent of the thread count.
//   node scripts/test-evolve.js [--base <git ref>] [--keep]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : '940a8f6';
const work = join(tmpdir(), `dbd-test-evolve-${process.pid}`);
mkdirSync(work, { recursive: true });
let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };

const SMALL = ['--map', 'maps/test-small.json', '--pop', '4', '--gens', '2', '--seed', '5'];
function run(script, name, extra, threads = 3) {
  const out = join(work, name);
  execFileSync(process.execPath, [script, ...SMALL, '--threads', String(threads), '--out', out, ...extra], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}
const lines = (dir) => readFileSync(join(dir, 'evo.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function strip(row) {
  const r = structuredClone(row);
  delete r.seconds; delete r.perf; delete r.selection;
  for (const side of ['hunters', 'survivors']) for (const x of r[side].ranking) delete x.fitSd;
  return JSON.stringify(r);
}
const noTiming = (row) => { const r = structuredClone(row); delete r.seconds; delete r.perf; return JSON.stringify(r); };
const same = (a, b, f) => a.length === b.length && a.every((x, i) => f(x) === f(b[i]));
const file = (d, f) => readFileSync(join(d, f), 'utf8');

// 1. default-flag identity against the base evolve.js (helpers are only extended, so the base script runs on them)
const baseScript = join(root, 'src', 'hillclimb', `_base_evolve_${process.pid}.js`);
writeFileSync(baseScript, execFileSync('git', ['show', `${base}:src/hillclimb/evolve.js`], { cwd: root, encoding: 'utf8' }));
try {
  for (const [name, extra] of [['plain', ['--rounds', '2']], ['flags', ['--rounds', '2', '--paired', '--reeval-top', '2', '--reeval-rounds', '2', '--carry']]]) {
    console.log(`- default identity vs ${base}: ${name}`);
    const a = run(baseScript, `base-${name}`, extra), b = run('src/hillclimb/evolve.js', `new-${name}`, extra);
    const la = lines(a), lb = lines(b);
    ok(same(la, lb, strip), 'evo.jsonl identical after dropping additive fields');
    ok(la.every((x) => !('selection' in x)) && lb.every((x) => x.selection && x.perf && x.perf.matches > 0), 'additive fields: selection + perf only in the new log');
    ok(file(a, 'population.json') === file(b, 'population.json'), 'population.json identical');
    ok(file(a, 'champions.json') === file(b, 'champions.json'), 'champions.json identical');
  }
} finally { rmSync(baseScript, { force: true }); }

// 2. determinism of the new modes (different thread counts on purpose)
const modes = {
  'panel-race': ['--panel', 'cur:2,hof:2,default:1', '--slots', '4', '--race', '--race-step', '2', '--race-max', '8', '--hof-every', '1'],
  'cmaes': ['--opt', 'cmaes', '--rounds', '2', '--cma-mirror'],
  'cmaes-panel-race': ['--opt', 'cmaes', '--panel', 'cur:1,mean:1,hof:1,default:1', '--slots', '4', '--race', '--race-step', '2', '--race-max', '6', '--hof-every', '1'],
};
for (const [name, extra] of Object.entries(modes)) {
  console.log(`- determinism: ${name}`);
  const a = run('src/hillclimb/evolve.js', `${name}-a`, extra, 3), b = run('src/hillclimb/evolve.js', `${name}-b`, extra, 2);
  const la = lines(a), lb = lines(b);
  ok(la.length === 2 && same(la, lb, noTiming), 'evo.jsonl identical (3 vs 2 threads)');
  ok(file(a, 'champions.json') === file(b, 'champions.json'), 'champions.json identical');
  const g2 = la[1];
  ok(g2.hunters.ranking.length === 4 && Object.keys(g2.hunters.knobs).length > 0, 'rankings + knob distributions logged (viewer format)');
  if (extra.includes('--panel')) {
    // duplicates are dropped (gen 1: pop[0] IS the defaults; the newest hall-of-fame entry is often a 'cur' member)
    ok(g2.panel && g2.panel.hunter.length >= 2 && g2.panel.survivor.length >= 2 && new Set(g2.panel.hunter).size === g2.panel.hunter.length, 'panel built, no duplicate members');
    ok(g2.selection.hunter.rel && g2.selection.survivor.rel, 'reliability reported');
    const hofs = JSON.parse(file(a, 'hof.json'));
    ok(hofs.hunter.length >= 1 && hofs.hunter.length <= 2 && hofs.hunter[0].gen === 1, 'hall of fame archived from gen 1 (--hof-every 1; an unchanged champion is not re-added)');
  }
  if (extra.includes('--race')) ok(g2.selection.hunter.race && g2.selection.hunter.race.slots >= 4 && g2.selection.hunter.race.slots <= +extra[extra.indexOf('--race-max') + 1], 'racing stats within --race-max');
  if (extra.includes('cmaes')) {
    ok(g2.cma && g2.cma.hunter.sigma > 0 && Object.keys(g2.cma.hunter.mean).length === Object.keys(g2.hunters.knobs).length, 'cma mean/sigma logged per side');
    const ch = JSON.parse(file(a, 'champions.json'));
    ok(Object.entries(g2.cma.hunter.mean).every(([k, v]) => Math.abs(ch.champ.hunter[k] - v) < 1e-3 + 1e-3 * Math.abs(v)) && ch.bestSample, 'champions.json = CMA mean (+ bestSample)');
  }
}
if (!argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
else console.log('runs kept in ' + work);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
