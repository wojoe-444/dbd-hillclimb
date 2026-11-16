// Population evolution: a population of hunters and a population of survivor teams (each team = one parameter set
// playing all four survivors). Every generation each hunter plays `--rounds` matches against randomly paired survivor
// teams (and vice versa); fitness = mean own bloodpoints (bloodpoints.js, normalised to [0,1]). The top `--elite`
// fraction of each population survives unchanged; the rest is refilled with children of tournament-selected parents
// (uniform crossover + gaussian mutation). Every generation logs the whole population's knob distributions, so a
// knob like `tunnel` can be watched drifting, narrowing, or splitting into sub-populations.
//
// Usage: node src/hillclimb/evolve.js [--map maps/gas-heaven] [--gens 200] [--pop 24] [--rounds 16]
//        [--elite 0.5] [--sigma 0.12] [--pmut 0.3] [--init-sigma 0.35] [--seed 1] [--out runs/<name>] [--resume]

import { cpus } from 'node:os';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getBrains } from '../brains/index.js';
import { defaults, mutate, rng, round, clampParams } from './params.js';
import { createPool } from './pool.js';

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
};
const outDir = resolve(args.out ?? `runs/evo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const brains = getBrains(opts.hunterBrain, opts.survivorBrain);
const spaces = { hunter: brains.hunter.space, survivor: brains.survivor.space };
const R = rng(opts.seed);
const pool = createPool({ threads: opts.threads, mapPath: opts.map, hunterBrain: opts.hunterBrain, survivorBrain: opts.survivorBrain });

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
  const elites = ranked.slice(0, keep).map((x) => ({ id: x.id, params: x.params, parents: x.parents, born: x.born }));
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
writeFileSync(join(outDir, 'config.json'), JSON.stringify({ kind: 'evolve', ...opts, spaces }, null, 2));
console.log(`evolving on ${opts.map}: pop ${opts.pop}+${opts.pop}, ${opts.rounds} rounds/gen, ${opts.threads} threads -> ${outDir}`);

for (let gen = startGen; gen < startGen + opts.gens; gen++) {
  const t0 = Date.now();
  // pairings: each round is a random permutation, so every individual plays exactly `rounds` matches
  const jobs = [];
  for (let r = 0; r < opts.rounds; r++) {
    const perm = survivors.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let h = 0; h < hunters.length; h++) {
      const s = perm[h % perm.length];
      jobs.push({ seed: Math.floor(R() * 2 ** 31), hunterParams: hunters[h].params, survivorParams: survivors[s].params, tag: { h, s } });
    }
  }
  const results = await pool.run(jobs);

  const agg = (n) => Array.from({ length: n }, () => ({ fit: 0, bp: 0, n: 0, kills: 0, escapes: 0, gens: 0 }));
  const H = agg(hunters.length), S = agg(survivors.length);
  const tot = { kills: 0, escapes: 0, gensDone: 0, genProgress: 0, hunterBP: 0, survivorBP: 0, durationS: 0, hooks: 0 };
  for (const r of results) {
    const h = H[r.h], s = S[r.s];
    h.fit += r.hunterFit; h.bp += r.hunterBP; h.n++; h.kills += r.kills;
    s.fit += r.survivorFit; s.bp += r.survivorBP; s.n++; s.escapes += r.escapes; s.gens += r.gensDone;
    for (const k of Object.keys(tot)) tot[k] += r[k] ?? 0;
  }
  for (const k of Object.keys(tot)) tot[k] = +(tot[k] / results.length).toFixed(3);
  const rank = (popn, A) => popn.map((x, i) => ({ ...x, fit: A[i].fit / A[i].n, bp: A[i].bp / A[i].n, kills: A[i].kills / A[i].n, escapes: A[i].escapes / A[i].n, gensDone: A[i].gens / A[i].n }))
    .sort((a, b) => b.fit - a.fit);
  const rh = rank(hunters, H), rs = rank(survivors, S);

  const brief = (x) => ({ id: x.id, born: x.born, parents: x.parents, bp: Math.round(x.bp), kills: x.kills !== undefined ? +x.kills.toFixed(2) : undefined, escapes: +(x.escapes ?? 0).toFixed(2), gensDone: +(x.gensDone ?? 0).toFixed(2), params: round(x.params) });
  appendFileSync(join(outDir, 'evo.jsonl'), JSON.stringify({
    gen, seconds: (Date.now() - t0) / 1000, matches: results.length, outcome: tot,
    hunters: { ranking: rh.map(brief), knobs: knobStats('hunter', hunters) },
    survivors: { ranking: rs.map(brief), knobs: knobStats('survivor', survivors) },
  }) + '\n');

  hunters = nextPopulation('hunter', rh, gen);
  survivors = nextPopulation('survivor', rs, gen);
  writeFileSync(popFile, JSON.stringify({ gen, nextId, hunters, survivors, best: { hunter: rh[0].params, survivor: rs[0].params } }, null, 2));
  // champions.json in the climb format, so the viewer/matchup can play the current best pair
  writeFileSync(join(outDir, 'champions.json'), JSON.stringify({ gen, champ: { hunter: round(rh[0].params), survivor: round(rs[0].params) } }, null, 2));

  const tk = knobStats('hunter', rh).tunnel;
  console.log(`gen ${String(gen).padStart(3)}  kills ${tot.kills.toFixed(2)} esc ${tot.escapes.toFixed(2)} gens ${tot.gensDone.toFixed(2)}  ` +
    `BP H ${Math.round(tot.hunterBP)} S ${Math.round(tot.survivorBP)}  best H ${Math.round(rh[0].bp)} S ${Math.round(rs[0].bp)}  ` +
    (tk ? `tunnel med ${tk.med.toFixed(2)} [${tk.q25.toFixed(2)}..${tk.q75.toFixed(2)}]  ` : '') + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
pool.close();
