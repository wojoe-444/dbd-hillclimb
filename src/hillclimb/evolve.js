// Population evolution: a population of hunters and a population of survivor teams (each team = one parameter set
// playing all four survivors). Every generation each hunter plays `--rounds` matches against randomly paired survivor
// teams (and vice versa); fitness: survivors = 0.5 x normalised bloodpoints (bloodpoints.js) + 0.5 x time-weighted survival (hunterscore.js),
// hunter = mean of the user's outcome table (hunterscore.js, /100). The top `--elite`
// fraction of each population survives unchanged; the rest is refilled with children of tournament-selected parents
// (uniform crossover + gaussian mutation). Every generation logs the whole population's knob distributions, so a
// knob like `tunnel` can be watched drifting, narrowing, or splitting into sub-populations.
//
// Usage: node src/hillclimb/evolve.js [--map maps/gas-heaven] [--gens 200] [--pop 24] [--rounds 16]
//        [--elite 0.5] [--sigma 0.12] [--pmut 0.3] [--init-sigma 0.35] [--seed 1] [--out runs/<name>] [--resume]
// Evaluation options (all off by default, so a plain command reproduces the historical behaviour):
//   --paired                 one shared seed per round: every individual of a side plays the same seed/map set
//   --reeval-top K           after ranking, the top K of each side play --reeval-rounds extra matches (shared seed
//   --reeval-rounds M          per round, random opponents) and are re-ranked on all their games (default M = rounds)
//   --carry                  fitness = running mean over every generation an individual has lived (elites keep history)
//   --bench-every k          every k gens (and the last gen) play the rank-1 hunter/survivor against FIXED reference
//   --bench-seeds N            opponents (default params + --bench-opponents) on N held-out seeds (default 32);
//   --bench-opponents a,b      logged as `bench` in that generation's evo.jsonl line (spec forms: evalplan.js
//                              resolveParamSet, e.g. runs/evo-v15, runs/evo-v14@gen20, v15=runs/evo-v15)
//   --metrics f.js,g.js      optional per-match metric modules (play.js); their means land in outcome.metrics
// Every start writes runs/<name>/config.json: git HEAD + dirty flag, map pool fingerprint, argv and the full config.

import { cpus } from 'node:os';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getBrains } from '../brains/index.js';
import { defaults, mutate, rng, round, clampParams } from './params.js';
import { createPool } from './pool.js';
import { roundJobs, reevalJobs, benchJobs, groupBench, heldOutSeeds, edgeReport, resolveParamSet, gitInfo, mapPoolInfo, averageMetrics } from './evalplan.js';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const opts = {
  map: resolve(args.map ?? 'maps/gas-heaven'),
  gens: +(args.gens ?? 200),
  pop: +(args.pop ?? 24),
  rounds: +(args.rounds ?? 16),
  elite: +(args.elite ?? 0.5),
  sigma: +(args.sigma ?? 0.12),
  pmut: +(args.pmut ?? 0.3),
  initSigma: +(args['init-sigma'] ?? 0.35),
  seed: +(args.seed ?? 1),
  threads: +(args.threads ?? Math.max(1, cpus().length - 1)),
  hunterBrain: args.hunter ?? 'param',
  survivorBrain: args.survivor ?? 'param',
  paired: !!args.paired,
  reevalTop: +(args['reeval-top'] ?? 0),
  reevalRounds: +(args['reeval-rounds'] ?? args.rounds ?? 16),
  carry: !!args.carry,
  benchEvery: +(args['bench-every'] ?? 0),
  benchSeeds: +(args['bench-seeds'] ?? 32),
  benchOpponents: args['bench-opponents'] ? String(args['bench-opponents']).split(',').filter(Boolean) : [],
  metrics: args.metrics ? String(args.metrics).split(',').filter(Boolean).map((p) => resolve(p)) : [],
};
const outDir = resolve(args.out ?? `runs/evo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const brains = getBrains(opts.hunterBrain, opts.survivorBrain);
const spaces = { hunter: brains.hunter.space, survivor: brains.survivor.space };
const R = rng(opts.seed);
const pool = createPool({ threads: opts.threads, mapPath: opts.map, hunterBrain: opts.hunterBrain, survivorBrain: opts.survivorBrain, metrics: opts.metrics });

// ---------- population helpers ----------
let nextId = 0;
const individual = (side, params, parents = null, born = 0) => ({ id: `${side[0]}${nextId++}`, params, parents, born });

function initPop(side) {
  const space = spaces[side], d = defaults(space);
  const pop = [individual(side, d)];                                   // keep the hand-tuned defaults in the mix
  while (pop.length < opts.pop) pop.push(individual(side, mutate(space, d, R, opts.initSigma, 0.8)));
  return pop;
}

function crossover(space, a, b) {
  const c = {};
  for (const k of Object.keys(space)) c[k] = R() < 0.5 ? a[k] : b[k];
  return clampParams(space, c);
}

function tournament(ranked, k = 3) {
  let best = null;
  for (let i = 0; i < k; i++) { const c = ranked[Math.floor(R() * ranked.length)]; if (!best || c.fit > best.fit) best = c; }
  return best;
}

function nextPopulation(side, ranked, gen) {
  const space = spaces[side];
  const keep = Math.max(1, Math.round(opts.pop * opts.elite));
  const elites = ranked.slice(0, keep).map((x) => ({ id: x.id, params: x.params, parents: x.parents, born: x.born, ...(opts.carry ? { hist: x.hist } : {}) }));
  const children = [];
  while (elites.length + children.length < opts.pop) {
    const a = tournament(ranked.slice(0, keep)), b = tournament(ranked.slice(0, keep));
    const child = mutate(space, crossover(space, a.params, b.params), R, opts.sigma, opts.pmut);
    children.push(individual(side, child, [a.id, b.id], gen));
  }
  return [...elites, ...children];
}

// distribution summary of each knob across a population
function knobStats(side, pop) {
  const out = {};
  for (const k of Object.keys(spaces[side])) {
    const v = pop.map((x) => x.params[k]).sort((a, b) => a - b);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    out[k] = { mean: +mean.toFixed(4), sd: +sd.toFixed(4), min: +v[0].toFixed(4), q25: +q(0.25).toFixed(4), med: +q(0.5).toFixed(4), q75: +q(0.75).toFixed(4), max: +v[v.length - 1].toFixed(4), values: v.map((x) => +x.toFixed(3)) };
  }
  return out;
}

// ---------- main loop ----------
let hunters, survivors, startGen = 1;
const popFile = join(outDir, 'population.json');
if (args.resume && existsSync(popFile)) {
  const saved = JSON.parse(readFileSync(popFile, 'utf8'));
  ({ hunters, survivors } = saved); startGen = saved.gen + 1; nextId = saved.nextId;
} else {
  hunters = initPop('hunter'); survivors = initPop('survivor');
}
// provenance: source snapshot (git HEAD + dirty flag), map pool fingerprint, the exact command and the full config
const cfgFile = join(outDir, 'config.json');
const prevCfg = args.resume && existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : null;
const benchSet = opts.benchEvery > 0 ? {
  seeds: heldOutSeeds(opts.benchSeeds),
  opponents: [resolveParamSet('default', spaces), ...opts.benchOpponents.map((s) => resolveParamSet(s, spaces))],
} : null;
writeFileSync(cfgFile, JSON.stringify({
  kind: 'evolve', ...opts, spaces,
  git: gitInfo(), mapPool: mapPoolInfo(opts.map), argv: process.argv.slice(2), node: process.version, startedAt: new Date().toISOString(), startGen,
  bench: benchSet && { seeds: { first: benchSet.seeds[0], n: benchSet.seeds.length }, opponents: benchSet.opponents.map((o) => ({ name: o.name, source: o.source, stale: o.stale, hunter: o.hunter, survivor: o.survivor })) },
  // a resumed run keeps the provenance of its earlier legs
  ...(prevCfg ? { previous: [...(prevCfg.previous ?? []), { ...prevCfg, previous: undefined, spaces: undefined }] } : {}),
}, null, 2));
console.log(`evolving on ${opts.map}: pop ${opts.pop}+${opts.pop}, ${opts.rounds} rounds/gen, ${opts.threads} threads -> ${outDir}`);

for (let gen = startGen; gen < startGen + opts.gens; gen++) {
  const t0 = Date.now();
  // pairings: each round is a random permutation, so every individual plays exactly `rounds` matches
  // (--paired: one shared seed per round, so every individual of a side sees the same seed/map set)
  const jobs = roundJobs({ hunters, survivors, rounds: opts.rounds, R, paired: opts.paired });
  const results = await pool.run(jobs);

  const agg = (n) => Array.from({ length: n }, () => ({ fit: 0, bp: 0, n: 0, kills: 0, escapes: 0, gens: 0 }));
  const H = agg(hunters.length), S = agg(survivors.length);
  const tot = { survivalTime: 0, kills: 0, escapes: 0, gensDone: 0, genProgress: 0, hunterScore100: 0, hookStages: 0, hunterBP: 0, survivorBP: 0, durationS: 0, hooks: 0 };
  for (const r of results) {
    const h = H[r.h], s = S[r.s];
    h.fit += r.hunterFit; h.bp += r.hunterBP; h.n++; h.kills += r.kills;
    s.fit += r.survivorFit; s.bp += r.survivorBP; s.n++; s.escapes += r.escapes; s.gens += r.gensDone;
    for (const k of Object.keys(tot)) tot[k] += r[k] ?? 0;
  }
  for (const k of Object.keys(tot)) tot[k] = +(tot[k] / results.length).toFixed(3);
  const mets = averageMetrics(results, 3);
  if (mets) tot.metrics = mets;
  // fitness sample per individual: this generation's games (+ its earlier generations' games with --carry)
  const sample = (x, a) => (opts.carry && x.hist ? { fit: a.fit + x.hist.fit, n: a.n + x.hist.n } : { fit: a.fit, n: a.n });
  const rank = (popn, A) => popn.map((x, i) => {
    const s = sample(x, A[i]);
    return { ...x, idx: i, fit: s.fit / s.n, games: s.n, ...(opts.carry ? { hist: s } : {}),
      bp: A[i].bp / A[i].n, kills: A[i].kills / A[i].n, escapes: A[i].escapes / A[i].n, gensDone: A[i].gens / A[i].n };
  }).sort((a, b) => b.fit - a.fit);
  let rh = rank(hunters, H), rs = rank(survivors, S);

  // --reeval-top: extra games for the current top K of each side, then re-rank (the population outcome line
  // stays main-round only, so it remains comparable with runs without re-evaluation)
  let reeval = null;
  if (opts.reevalTop > 0 && opts.reevalRounds > 0) {
    const K = Math.min(opts.reevalTop, rh.length, rs.length);
    const before = { hunter: rh.slice(0, K).map((x) => [x.id, x.fit]), survivor: rs.slice(0, K).map((x) => [x.id, x.fit]) };
    const extra = await pool.run(reevalJobs({ hunters, survivors, topH: rh.slice(0, K).map((x) => x.idx), topS: rs.slice(0, K).map((x) => x.idx), rounds: opts.reevalRounds, R }));
    for (const r of extra) {
      if (r.only === 'hunter') { const a = H[r.h]; a.fit += r.hunterFit; a.bp += r.hunterBP; a.kills += r.kills; a.n++; }
      else { const a = S[r.s]; a.fit += r.survivorFit; a.bp += r.survivorBP; a.escapes += r.escapes; a.gens += r.gensDone; a.n++; }
    }
    rh = rank(hunters, H); rs = rank(survivors, S);
    const moved = (rk, b) => b.map(([id, f]) => { const i = rk.findIndex((x) => x.id === id); return { id, before: +f.toFixed(4), after: +rk[i].fit.toFixed(4), rank: i + 1 }; });
    reeval = { matches: extra.length, hunter: moved(rh, before.hunter), survivor: moved(rs, before.survivor) };
  }

  // fixed-opponent benchmark on held-out seeds: comparable across generations and across runs
  let bench = null;
  if (benchSet && (gen % opts.benchEvery === 0 || gen === startGen + opts.gens - 1)) {
    const br = await pool.run(benchJobs({ champ: { hunter: rh[0].params, survivor: rs[0].params }, opponents: benchSet.opponents, seeds: benchSet.seeds }));
    bench = { seeds: { first: benchSet.seeds[0], n: benchSet.seeds.length }, champ: { hunter: rh[0].id, survivor: rs[0].id }, vs: groupBench(br) };
  }

  const brief = (x) => ({ id: x.id, born: x.born, parents: x.parents, ...(opts.carry || opts.reevalTop > 0 ? { fit: +x.fit.toFixed(4), games: x.games } : {}), bp: Math.round(x.bp), kills: x.kills !== undefined ? +x.kills.toFixed(2) : undefined, escapes: +(x.escapes ?? 0).toFixed(2), gensDone: +(x.gensDone ?? 0).toFixed(2), params: round(x.params) });
  appendFileSync(join(outDir, 'evo.jsonl'), JSON.stringify({
    gen, seconds: (Date.now() - t0) / 1000, matches: results.length, outcome: tot,
    ...(opts.paired ? { seeds: [...new Set(jobs.map((j) => j.seed))] } : {}),
    ...(reeval ? { reeval } : {}), ...(bench ? { bench } : {}),
    // edges: knobs with >= 25 % of the population within 5 % of a range bound (share at lo / hi)
    hunters: { ranking: rh.map(brief), knobs: knobStats('hunter', hunters), edges: edgeReport(spaces.hunter, hunters) },
    survivors: { ranking: rs.map(brief), knobs: knobStats('survivor', survivors), edges: edgeReport(spaces.survivor, survivors) },
  }) + '\n');

  hunters = nextPopulation('hunter', rh, gen);
  survivors = nextPopulation('survivor', rs, gen);
  writeFileSync(popFile, JSON.stringify({ gen, nextId, hunters, survivors, best: { hunter: rh[0].params, survivor: rs[0].params } }, null, 2));
  // champions.json in the climb format, so the viewer/matchup can play the current best pair
  writeFileSync(join(outDir, 'champions.json'), JSON.stringify({ gen, champ: { hunter: round(rh[0].params), survivor: round(rs[0].params) } }, null, 2));

  const tk = knobStats('hunter', rh).tunnel;
  console.log(`gen ${String(gen).padStart(3)}  kills ${tot.kills.toFixed(2)} esc ${tot.escapes.toFixed(2)} gens ${tot.gensDone.toFixed(2)}  ` +
    `H score ${tot.hunterScore100.toFixed(1)} (stages ${tot.hookStages.toFixed(1)})  S BP ${Math.round(tot.survivorBP)}  best H ${(100 * rh[0].fit).toFixed(1)} S ${Math.round(rs[0].bp)}  ` +
    (tk ? `tunnel med ${tk.med.toFixed(2)} [${tk.q25.toFixed(2)}..${tk.q75.toFixed(2)}]  ` : '') + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (bench) for (const [name, v] of Object.entries(bench.vs)) {
    console.log(`        bench vs ${name}: champ H ${v.hunter ? `kills ${v.hunter.kills.toFixed(2)} score ${v.hunter.hunterScore100.toFixed(1)}` : '-'}  |  ` +
      `champ S ${v.survivor ? `esc ${v.survivor.escapes.toFixed(2)} gens ${v.survivor.gensDone.toFixed(2)} fit ${v.survivor.survivorFit.toFixed(3)}` : '-'}`);
  }
}
pool.close();
