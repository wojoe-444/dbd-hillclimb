// Alternating hill-climb: each generation one side (hunter or survivor team) tries K mutants
// of its champion against the other side's current champion on a shared set of seeds
// (common random numbers). The best mutant replaces the champion only if it also wins a
// confirmation round on fresh seeds.
//
// Usage: node src/hillclimb/climb.js [--map maps/gas-heaven.json] [--gens 40] [--k 6]
//        [--n 48] [--seed 1] [--out runs/<name>] [--hunter param] [--survivor param] [--resume]

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrains } from '../brains/index.js';
import { defaults, mutate, rng, round } from './params.js';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const opts = {
  map: resolve(args.map ?? 'maps/gas-heaven.json'),
  gens: +(args.gens ?? 40),
  k: +(args.k ?? 6),
  n: +(args.n ?? 48),
  seed: +(args.seed ?? 1),
  margin: +(args.margin ?? 0.01),
  sigma: +(args.sigma ?? 0.15),
  hunterBrain: args.hunter ?? 'param',
  survivorBrain: args.survivor ?? 'param',
  threads: +(args.threads ?? Math.max(1, cpus().length - 1)),
};
const outDir = resolve(args.out ?? `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

// ---------- worker pool ----------
const workers = [];
const idle = [];
const queue = [];
const pending = new Map();
let nextId = 0;
for (let i = 0; i < opts.threads; i++) {
  const w = new Worker(join(here, 'worker.js'), {
    workerData: { mapPath: opts.map, hunterBrain: opts.hunterBrain, survivorBrain: opts.survivorBrain },
  });
  w.on('message', ({ id, results }) => {
    pending.get(id)(results);
    pending.delete(id);
    idle.push(w);
    pump();
  });
  w.on('error', (e) => { console.error(e); process.exit(1); });
  workers.push(w);
  idle.push(w);
}
function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop();
    const { id, jobs, done } = queue.shift();
    pending.set(id, done);
    w.postMessage({ id, jobs });
  }
}
function runJobs(jobs) {
  const chunk = Math.max(1, Math.ceil(jobs.length / (opts.threads * 2)));
  const parts = [];
  for (let i = 0; i < jobs.length; i += chunk) {
    const slice = jobs.slice(i, i + chunk);
    parts.push(new Promise((done) => { queue.push({ id: nextId++, jobs: slice, done }); }));
  }
  pump();
  return Promise.all(parts).then((r) => r.flat());
}

// ---------- scoring ----------
// Zero-sum score in [0,1] from the hunter's perspective.
export function hunterScore(r) {
  return 0.85 * (r.kills / 4) + 0.15 * (1 - Math.min(5, r.gensDone) / 5);
}
function summarize(results) {
  const n = results.length;
  const s = { n, hunterScore: 0, kills: 0, escapes: 0, gensDone: 0, hooks: 0, durationS: 0 };
  for (const r of results) {
    s.hunterScore += hunterScore(r);
    s.kills += r.kills; s.escapes += r.escapes; s.gensDone += r.gensDone;
    s.hooks += r.hooks; s.durationS += r.durationS;
  }
  for (const k of Object.keys(s)) if (k !== 'n') s[k] = +(s[k] / n).toFixed(4);
  return s;
}
async function evaluate(hunterParams, survivorParams, seeds) {
  const res = await runJobs(seeds.map((seed) => ({ seed, hunterParams, survivorParams })));
  return summarize(res);
}

// ---------- main loop ----------
const brains = getBrains(opts.hunterBrain, opts.survivorBrain);
const R = rng(opts.seed);
let champ = { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
let startGen = 1;
const champFile = join(outDir, 'champions.json');
if (args.resume && existsSync(champFile)) {
  const saved = JSON.parse(readFileSync(champFile, 'utf8'));
  champ = saved.champ;
  startGen = saved.gen + 1;
}
writeFileSync(join(outDir, 'config.json'), JSON.stringify({ ...opts, spaces: { hunter: brains.hunter.space, survivor: brains.survivor.space } }, null, 2));

const freshSeeds = (n) => Array.from({ length: n }, () => Math.floor(R() * 2 ** 31));
const log = (rec) => appendFileSync(join(outDir, 'meta.jsonl'), JSON.stringify(rec) + '\n');

console.log(`climbing on ${opts.map} with ${opts.threads} threads -> ${outDir}`);
for (let gen = startGen; gen < startGen + opts.gens; gen++) {
  const t0 = Date.now();
  const side = gen % 2 === 1 ? 'survivor' : 'hunter';
  const space = brains[side].space;
  const sign = side === 'hunter' ? 1 : -1; // maximize sign * hunterScore
  const seeds = freshSeeds(opts.n);

  const base = await evaluate(champ.hunter, champ.survivor, seeds);
  const mutants = Array.from({ length: opts.k }, () => mutate(space, champ[side], R, opts.sigma));
  const scored = await Promise.all(mutants.map(async (m) => {
    const pair = { ...champ, [side]: m };
    return { m, s: await evaluate(pair.hunter, pair.survivor, seeds) };
  }));
  scored.sort((a, b) => sign * (b.s.hunterScore - a.s.hunterScore));
  const best = scored[0];
  let accepted = false;
  let confirm = null;
  if (sign * (best.s.hunterScore - base.hunterScore) > opts.margin) {
    const cSeeds = freshSeeds(opts.n);
    const pair = { ...champ, [side]: best.m };
    const [cBase, cBest] = await Promise.all([
      evaluate(champ.hunter, champ.survivor, cSeeds),
      evaluate(pair.hunter, pair.survivor, cSeeds),
    ]);
    confirm = { base: cBase.hunterScore, best: cBest.hunterScore };
    if (sign * (cBest.hunterScore - cBase.hunterScore) > 0) {
      champ = { ...champ, [side]: best.m };
      accepted = true;
    }
  }
  const after = accepted ? best.s : base;
  log({
    gen, side, accepted, base, best: best.s, confirm, after,
    champ: { hunter: round(champ.hunter), survivor: round(champ.survivor) },
    seconds: (Date.now() - t0) / 1000,
  });
  writeFileSync(champFile, JSON.stringify({ gen, champ }, null, 2));
  console.log(
    `gen ${String(gen).padStart(3)} ${side.padEnd(8)} ${accepted ? 'ACCEPT' : 'keep  '} ` +
    `kills ${after.kills.toFixed(2)} esc ${after.escapes.toFixed(2)} gens ${after.gensDone.toFixed(2)} ` +
    `hScore ${after.hunterScore.toFixed(3)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );
}
for (const w of workers) w.terminate();
