#!/usr/bin/env node
// End-to-end checks for evolve.js (runs tiny evolutions on maps/test-small.json as child processes, ~2-4 min):
//  1. default flags reproduce the pre-selection-fix evolve.js (git ref --base, default 940a8f6) byte-identically:
//     evo.jsonl after dropping the known additive fields (seconds, perf, selection, ranking[].fitSd),
//     population.json after dropping the checkpoint metadata, and champions.json as it is;
//  2. --panel --race (GA) and --opt cmaes (with and without --panel/--race) are deterministic for a fixed seed,
//     independent of the thread count;
//  3. --mod genSeconds=80: recorded in config.json / evo.jsonl / champions.json, deterministic, --resume guard.
//  4. Pool failure/closure, invalid CLI inputs, seeded resume, and indexed map provenance.
//   node scripts/test-evolve.js [--base <git ref>] [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createPool } from '../src/hillclimb/pool.js';
import { mapPoolInfo } from '../src/hillclimb/evalplan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : '940a8f6';
const work = mkdtempSync(join(tmpdir(), 'dbd-test-evolve-'));
let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };

const SMALL = ['--map', 'maps/test-small.json', '--pop', '4', '--gens', '2', '--seed', '5'];
const evolve = 'src/hillclimb/evolve.js';
const runArgs = (script, name, extra, threads) => [script, ...SMALL, '--threads', String(threads), '--out', join(work, name), ...extra];
function run(script, name, extra, threads = 3) {
  execFileSync(process.execPath, runArgs(script, name, extra, threads), { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
  return join(work, name);
}
function refuses(name, extra, message, reason, script = evolve) {
  const result = spawnSync(process.execPath, runArgs(script, name, extra, 1), { cwd: root, encoding: 'utf8', timeout: 5_000 });
  ok(result.status === 1 && message.test(result.stderr), reason);
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
    const a = run(baseScript, `base-${name}`, extra), b = run(evolve, `new-${name}`, extra);
    const la = lines(a), lb = lines(b);
    ok(same(la, lb, strip), 'evo.jsonl identical after dropping additive fields');
    ok(la.every((x) => !('selection' in x)) && lb.every((x) => x.selection && x.perf && x.perf.matches > 0), 'additive fields: selection + perf only in the new log');
    const { rng, prev, ...population } = JSON.parse(file(b, 'population.json'));
    ok(file(a, 'population.json') === JSON.stringify(population, null, 2), 'population.json identical apart from checkpoint metadata');
    ok(file(a, 'champions.json') === file(b, 'champions.json'), 'champions.json identical');
    if (name === 'flags') {
      const leg = [...extra, '--gens', '1'];
      const split = run(evolve, 'split', leg);
      run(evolve, 'split', [...leg, '--resume'], 2);
      ok(same(lb, lines(split), noTiming), 'a seeded resume reproduces the uninterrupted generations');
      ok(file(split, 'population.json') === file(b, 'population.json'), 'resumed population checkpoint is identical');
    } else {
      run(evolve, 'base-plain', ['--rounds', '2', '--gens', '0', '--resume']);
      ok(file(a, 'population.json') === JSON.stringify(population, null, 2), 'legacy resume reads a checkpoint without RNG state');
    }
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
  const a = run(evolve, `${name}-a`, extra, 3), b = run(evolve, `${name}-b`, extra, 2);
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
// 3. game modifiers: recorded everywhere, deterministic across thread counts, resume refuses other rules
{
  console.log('- game modifiers: --mod genSeconds=80');
  const extra = ['--rounds', '2', '--mod', 'genSeconds=80'];
  const a = run(evolve, 'mod-a', extra, 3), b = run(evolve, 'mod-b', extra, 2);
  const la = lines(a), lb = lines(b);
  ok(la.length === 2 && same(la, lb, noTiming), 'evo.jsonl identical (3 vs 2 threads)');
  ok(file(a, 'champions.json') === file(b, 'champions.json'), 'champions.json identical');
  const cfg = JSON.parse(file(a, 'config.json')), ch = JSON.parse(file(a, 'champions.json'));
  ok(cfg.modifiers?.genSeconds === 80 && cfg.standard === false, 'config.json: modifiers { genSeconds: 80 }, standard: false');
  ok(la.every((r) => r.modifiers?.genSeconds === 80), 'every evo.jsonl line carries the modifiers');
  ok(ch.modifiers?.genSeconds === 80 && ch.standard === false, 'champions.json carries the modifiers');
  const std = run(evolve, 'mod-std', ['--rounds', '2'], 3);
  const cs = JSON.parse(file(std, 'config.json'));
  ok(cs.standard === true && Object.keys(cs.modifiers).length === 0 && lines(std).every((r) => !('modifiers' in r)) && !('modifiers' in JSON.parse(file(std, 'champions.json'))), 'standard run: config.json standard: true, nothing extra in evo.jsonl / champions.json');
  ok(!same(la, lines(std), noTiming), 'the modifier changes the evolution');
  refuses('mod-a', ['--rounds', '2', '--resume'], /started with game modifiers/, '--resume without the run\'s --mod is refused');
  ok(lines(a).length === 2, 'modifier mismatch leaves the log untouched');
}
console.log('- invalid evolution requests');
refuses('no-threads', ['--threads', '0'], /threads must be a positive integer/, 'evolution rejects zero workers');
refuses('no-climb-threads', ['--threads', '0'], /threads must be a positive integer/, 'climb rejects zero workers', 'src/hillclimb/climb.js');
refuses('race-step', ['--race', '--slots', '2', '--race-step', '0'], /--race-step must be/, 'a race step must make progress');
refuses('race-max', ['--race', '--slots', '4', '--race-max', '3'], /--race-max must be/, 'race budget covers the initial slots');
refuses('cma-sigma', ['--opt', 'cmaes', '--cma-sigma', '0'], /--cma-sigma must be/, 'CMA rejects zero initial sigma');
refuses('cma-pop', ['--opt', 'cmaes', '--pop', '2'], /--pop must be/, 'CMA rejects sizes it would otherwise silently expand');
const plain = join(work, 'new-plain');
const runFiles = ['config.json', 'evo.jsonl', 'population.json', 'champions.json'];
const plainBefore = runFiles.map((name) => file(plain, name));
refuses('new-plain', ['--rounds', '2'], /already contains evolution results/, 'fresh runs cannot append duplicate generations');
refuses('new-plain', ['--resume', '--opt', 'cmaes'], /same --opt/, 'resuming cannot mislabel the optimizer');
refuses('new-plain', ['--resume', '--pop', '5'], /same --pop/, 'resuming cannot mislabel the population size');
refuses('missing', ['--resume'], /requires a population.json/, 'resume requires a checkpoint');
const split = join(work, 'split');
const savedLog = file(split, 'evo.jsonl');
writeFileSync(join(split, 'evo.jsonl'), savedLog + '{"gen":3}\n');
refuses('split', ['--resume'], /end at different generations/, 'resume rejects a log ahead of its checkpoint');
writeFileSync(join(split, 'evo.jsonl'), savedLog);
ok(runFiles.every((name, i) => file(plain, name) === plainBefore[i]), 'refused commands left all run records untouched');

console.log('- worker pool');
const mapPath = join(root, 'maps', 'test-small.json');
const poolOptions = { mapPath, hunterBrain: 'test', survivorBrain: 'test' };
for (const [key, value] of [['threads', 0], ['threads', 1.5], ['chunk', 0], ['chunk', NaN]]) {
  let failure;
  try { await createPool({ ...poolOptions, threads: 1, [key]: value }).close(); } catch (error) { failure = error; }
  ok(failure instanceof RangeError && failure.message.startsWith(key), `${key}=${value} is rejected`);
}
const jobs = [3, 1, 2].map((seed) => ({ seed, config: { maxMatchS: 1 }, tag: { label: `match-${seed}` } }));
const pool = createPool({ ...poolOptions, threads: 2, chunk: 2 });
try {
  const [a, b] = await Promise.all([pool.run(jobs), pool.run(jobs.slice().reverse())]);
  ok(JSON.stringify(a) === JSON.stringify(b.reverse()) && a.every((r, i) => r.seed === jobs[i].seed && r.label === jobs[i].tag.label), 'concurrent batches preserve seeded results, order and tags');
  ok(pool.takeStats().matches === 6, 'stats include each completed job');
} finally { await pool.close(); }

const exits = join(work, 'exit-worker.mjs');
writeFileSync(exits, 'process.exit(0);\n');
for (const [name, options, message] of [
  ['close', {}, /pool is closed/],
  ['startup error', { metrics: [join(work, 'missing.mjs')] }, /missing\.mjs/],
  ['unexpected exit', { metrics: [exits] }, /exited unexpectedly \(code 0\)/],
]) {
  const broken = createPool({ ...poolOptions, threads: 1, ...options });
  const settled = Promise.allSettled([broken.run(jobs), broken.run(jobs)]);
  const closing = name === 'close' ? broken.close() : null;
  const results = await settled;
  ok(results.every((r) => r.status === 'rejected' && message.test(r.reason.message)), `${name} rejects active and queued batches`);
  ok((await Promise.allSettled([broken.run([])]))[0].status === 'rejected', `${name} rejects later runs`);
  if (closing) ok(broken.close() === closing, 'close is idempotent');
  await broken.close();
}
const dispatchPool = createPool({ ...poolOptions, threads: 1 });
const queued = dispatchPool.run(jobs);
const bad = dispatchPool.run([{ ...jobs[0], cannotClone: () => {} }]);
const dispatch = await Promise.allSettled([queued, bad]);
ok(dispatch[0].status === 'fulfilled' && dispatch[1].status === 'rejected' && dispatch[1].reason.name === 'DataCloneError',
  'dispatch errors reject the batch promise');
await dispatchPool.close();

console.log('- map pool provenance');
const maps = join(work, 'maps');
mkdirSync(maps);
const index = join(maps, 'index.json');
writeFileSync(join(maps, 'a.json'), '{"id":"a"}');
writeFileSync(join(maps, 'b.json'), '{"id":"b"}');
writeFileSync(index, JSON.stringify({ variants: ['a.json', { file: 'b.json' }] }));
const original = mapPoolInfo(index);
ok(original.n === 2 && original.sha1 === mapPoolInfo(maps).sha1, 'directory and index fingerprint the same variants in the same order');
writeFileSync(index, JSON.stringify(['b.json', 'a.json']));
ok(original.sha1 !== mapPoolInfo(index).sha1, 'changing variant order changes the fingerprint');
writeFileSync(index, JSON.stringify(['a.json', 'b.json']));
writeFileSync(join(maps, 'b.json'), '{"id":"updated"}');
ok(original.sha1 !== mapPoolInfo(index).sha1, 'changing an indexed variant changes the fingerprint');
if (!argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
else console.log('runs kept in ' + work);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
