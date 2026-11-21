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
// Noise-robust selection (selection.js, cmaes.js; see docs/research/selection-fix.md):
//   --panel [spec]           evaluate each side against a fixed opponent PANEL instead of random co-evolution pairings.
//                            spec = comma list of kind:n, kinds cur (top n of the opposite side's last ranking), hof
//                            (n hall-of-fame champions spread over the archive), default, mean (opposite pop / CMA mean).
//                            Default spec cur:4,hof:3,default:1. Every individual of a side plays the same SLOTS
//                            (opponent, seed) = common random numbers; a match counts for the evaluated side only.
//   --panel-fixed a,b        extra fixed panel opponents (resolveParamSet specs, e.g. v16=runs/evo-v16)
//   --slots N                slots per individual per generation with --panel (default = --rounds)
//   --hof-every k            every k gens archive each side's champion (GA: rank 1; CMA-ES: the mean) (default 5)
//   --hof-size N             hall-of-fame cap per side, thinned evenly over the run (default 20)
//   --race                   racing (needs --panel): after the --slots stage, individuals whose paired difference to
//   --race-step s              the selection cut is significant (|z| >= --race-z, default 1.5) are decided; the rest
//   --race-max M               play s more slots (default max(4, slots/2)) per stage, up to M slots (default 3 x slots)
//   --opt cmaes              sep-CMA-ES per side over the normalised knob vector instead of the GA (lambda = --pop,
//   --cma-sigma s              mu = lambda/2). s = initial step in [0,1] units (default 0.15); --cma-mirror = antithetic
//   --cma-mirror               pairs; --cma-min-sigma floor (default 0.01). evo.jsonl gains `cma` (mean, sigma, per-knob
//   --cma-min-sigma f          sd); rankings/knobs describe the sampled population; champions.json = the CMA mean.
// Every generation also logs (additive fields): `perf` (matches/s, worker utilisation, ms per game-second) and
// `selection` (per side: reliability of the fitness means, split-half, rank persistence of survivors, racing stats).
// Every start writes runs/<name>/config.json: git HEAD + dirty flag, map pool fingerprint, argv and the full config.
// Game modifiers (src/sim/modifiers.js): --mod genSeconds=80 (repeatable / comma list) plays every match under the
// modified rules. Recorded as config.json { modifiers, standard }, on every evo.jsonl line of a modified run
// (`modifiers`) and in champions.json (modified runs only; absent = standard). --resume refuses a different modifier set than the run was started with.

import { cpus } from 'node:os';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getBrains } from '../brains/index.js';
import { defaults, mutate, rng, round, clampParams } from './params.js';
import { createPool } from './pool.js';
import { roundJobs, reevalJobs, benchJobs, groupBench, heldOutSeeds, edgeReport, resolveParamSet, gitInfo, mapPoolInfo, averageMetrics, modMismatches } from './evalplan.js';
import { parsePanelSpec, buildPanel, hofAdd, makeSlots, slotJobs, raceStep, reliability, persistence, mean, variance, spearman } from './selection.js';
import { cmaInit, cmaAsk, cmaTell, cmaSummary, fromNorm } from './cmaes.js';
import { modsFromArgv, modsRecord, describeMods, modsKey, modsOf } from '../sim/modifiers.js';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const mods = modsFromArgv(argv);   // {} = the standard game
const modRec = modsRecord(mods);
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
// noise-robust selection options: only added to the config when used, so a default run's config is unchanged
const opt = args.opt ?? 'ga';
if (!['ga', 'cmaes'].includes(opt)) throw new Error(`--opt ${opt}: expected ga | cmaes`);
if (args.race && !args.panel) args.panel = true;
if (opt !== 'ga') opts.opt = opt;
if (args.panel) {
  opts.panel = parsePanelSpec(args.panel);
  opts.panelFixed = args['panel-fixed'] ? String(args['panel-fixed']).split(',').filter(Boolean) : [];
  opts.slots = +(args.slots ?? opts.rounds);
  opts.hofEvery = +(args['hof-every'] ?? 5);
  opts.hofSize = +(args['hof-size'] ?? 20);
  if (opts.reevalTop > 0) throw new Error('--reeval-top is for co-evolution pairings; with --panel use --race');
}
if (args.race) {
  opts.race = { step: +(args['race-step'] ?? Math.max(4, Math.round(opts.slots / 2))), max: +(args['race-max'] ?? 3 * opts.slots), z: +(args['race-z'] ?? 1.5) };
}
if (opt === 'cmaes') {
  opts.cma = { sigma0: +(args['cma-sigma'] ?? 0.15), mirror: !!args['cma-mirror'], minSigma: +(args['cma-min-sigma'] ?? 0.01) };
  if (opts.carry) throw new Error('--carry has no meaning with --opt cmaes (no individual survives a generation)');
  if (!Number.isFinite(opts.cma.sigma0) || opts.cma.sigma0 <= 0) throw new RangeError('--cma-sigma must be positive and finite');
  if (!Number.isFinite(opts.cma.minSigma) || opts.cma.minSigma < 0) throw new RangeError('--cma-min-sigma must be non-negative and finite');
} else if (!Number.isFinite(opts.elite) || opts.elite < 0 || opts.elite > 1) {
  throw new RangeError('--elite must be between 0 and 1');
}

function requireInt(flag, value, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`--${flag} must be an integer >= ${min} (got ${value})`);
}
requireInt('gens', opts.gens, 0);
requireInt('pop', opts.pop, opt === 'cmaes' ? 4 : 1);
if (opts.panel) requireInt('slots', opts.slots, 1);
else requireInt('rounds', opts.rounds, 1);
if (opts.race) {
  requireInt('race-step', opts.race.step, 1);
  requireInt('race-max', opts.race.max, opts.slots);
  if (!Number.isFinite(opts.race.z) || opts.race.z < 0) throw new RangeError('--race-z must be non-negative and finite');
}

const outDir = resolve(args.out ?? `runs/evo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const logFile = join(outDir, 'evo.jsonl');
const popFile = join(outDir, 'population.json');
const champFile = join(outDir, 'champions.json');
let saved = null;
if (args.resume) {
  if (!existsSync(popFile)) throw new Error('--resume requires a population.json checkpoint');
  saved = JSON.parse(readFileSync(popFile, 'utf8'));
  if (!!saved.cma !== (opt === 'cmaes')) throw new Error('--resume requires the same --opt as the checkpoint');
  const sizes = saved.cma ? ['hunter', 'survivor'].map((side) => saved.cma[side].lambda) : [saved.hunters.length, saved.survivors.length];
  if (sizes.some((n) => n !== opts.pop)) throw new Error('--resume requires the same --pop as the checkpoint');
  if (existsSync(logFile)) {
    const log = readFileSync(logFile, 'utf8').trimEnd();
    const last = log.slice(log.lastIndexOf('\n') + 1);
    if (!last || JSON.parse(last).gen !== saved.gen) throw new Error('--resume: evo.jsonl and population.json end at different generations');
  }
  if (saved.rng && args.seed === undefined) opts.seed = saved.rng.seed;
} else if ([logFile, popFile, champFile].some((file) => existsSync(file))) {
  throw new Error(`--out already contains evolution results (${outDir}); use --resume or another directory`);
}

const brains = getBrains(opts.hunterBrain, opts.survivorBrain);
const spaces = { hunter: brains.hunter.space, survivor: brains.survivor.space };
// Legacy checkpoints without RNG state start the next leg from its supplied seed.
const R = rng(saved?.rng?.seed === opts.seed ? saved.rng.state : opts.seed);

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

const keepCount = () => Math.max(1, Math.round(opts.pop * opts.elite));
function nextPopulation(side, ranked, gen) {
  const space = spaces[side];
  const keep = keepCount();
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

const agg = (n) => Array.from({ length: n }, () => ({ fit: 0, bp: 0, n: 0, kills: 0, escapes: 0, gens: 0, F: [] }));
const TOT_KEYS = ['survivalTime', 'kills', 'escapes', 'gensDone', 'genProgress', 'hunterScore100', 'hookStages', 'hunterBP', 'survivorBP', 'durationS', 'hooks'];
function outcomeOf(results) {
  const tot = Object.fromEntries(TOT_KEYS.map((k) => [k, 0]));
  for (const r of results) for (const k of TOT_KEYS) tot[k] += r[k] ?? 0;
  for (const k of TOT_KEYS) tot[k] = +(tot[k] / results.length).toFixed(3);
  const mets = averageMetrics(results, 3);
  if (mets) tot.metrics = mets;
  return tot;
}
// fitness sample per individual: this generation's games (+ its earlier generations' games with --carry)
const sample = (x, a) => (opts.carry && x.hist ? { fit: a.fit + x.hist.fit, n: a.n + x.hist.n } : { fit: a.fit, n: a.n });
const scored = (popn, A) => popn.map((x, i) => {
  const s = sample(x, A[i]);
  return { ...x, idx: i, fit: s.fit / s.n, games: s.n, fitSd: Math.sqrt(variance(A[i].F)), ...(opts.carry ? { hist: s } : {}),
    bp: A[i].bp / A[i].n, kills: A[i].kills / A[i].n, escapes: A[i].escapes / A[i].n, gensDone: A[i].gens / A[i].n };
});
const rank = (popn, A) => scored(popn, A).sort((a, b) => b.fit - a.fit);
const addHunter = (a, r) => { a.fit += r.hunterFit; a.bp += r.hunterBP; a.kills += r.kills; a.n++; a.F.push(r.hunterFit); };
const addSurvivor = (a, r) => { a.fit += r.survivorFit; a.bp += r.survivorBP; a.escapes += r.escapes; a.gens += r.gensDone; a.n++; a.F.push(r.survivorFit); };

// ---------- co-evolution evaluation (the historical path; R consumption unchanged) ----------
async function evalCoevo() {
  // pairings: each round is a random permutation, so every individual plays exactly `rounds` matches
  // (--paired: one shared seed per round, so every individual of a side sees the same seed/map set)
  const jobs = roundJobs({ hunters, survivors, rounds: opts.rounds, R, paired: opts.paired });
  const results = await pool.run(jobs);
  const H = agg(hunters.length), S = agg(survivors.length);
  for (const r of results) { addHunter(H[r.h], r); addSurvivor(S[r.s], r); }
  const tot = outcomeOf(results);
  // reliability from the main rounds (raw: co-evolution opponents and seeds differ per individual unless --paired)
  const sel = { hunter: { rel: reliability(H.map((a) => a.F.slice())) }, survivor: { rel: reliability(S.map((a) => a.F.slice())) } };
  let rh = rank(hunters, H), rs = rank(survivors, S);

  // --reeval-top: extra games for the current top K of each side, then re-rank (the population outcome line
  // stays main-round only, so it remains comparable with runs without re-evaluation)
  let reeval = null;
  if (opts.reevalTop > 0 && opts.reevalRounds > 0) {
    const K = Math.min(opts.reevalTop, rh.length, rs.length);
    const before = { hunter: rh.slice(0, K).map((x) => [x.id, x.fit]), survivor: rs.slice(0, K).map((x) => [x.id, x.fit]) };
    const extra = await pool.run(reevalJobs({ hunters, survivors, topH: rh.slice(0, K).map((x) => x.idx), topS: rs.slice(0, K).map((x) => x.idx), rounds: opts.reevalRounds, R }));
    const xH = agg(hunters.length), xS = agg(survivors.length);
    for (const r of extra) {
      if (r.only === 'hunter') { addHunter(H[r.h], r); addHunter(xH[r.h], r); }
      else { addSurvivor(S[r.s], r); addSurvivor(xS[r.s], r); }
    }
    rh = rank(hunters, H); rs = rank(survivors, S);
    const moved = (rk, b) => b.map(([id, f]) => { const i = rk.findIndex((x) => x.id === id); return { id, before: +f.toFixed(4), after: +rk[i].fit.toFixed(4), rank: i + 1 }; });
    reeval = { matches: extra.length, hunter: moved(rh, before.hunter), survivor: moved(rs, before.survivor) };
    // test-retest reliability of the top K: main-round mean vs the independent re-evaluation mean
    const retest = (b, X, rk) => {
      const pairs = b.map(([id, f]) => { const i = rk.find((x) => x.id === id).idx; return X[i].n ? [f, X[i].fit / X[i].n] : null; }).filter(Boolean);
      return pairs.length >= 3 ? { n: pairs.length, rho: +(spearmanOf(pairs)).toFixed(3) } : null;
    };
    sel.hunter.retest = retest(before.hunter, xH, rh); sel.survivor.retest = retest(before.survivor, xS, rs);
  }
  return { rh, rs, tot, matches: results.length, extra: { ...(opts.paired ? { seeds: [...new Set(jobs.map((j) => j.seed))] } : {}), ...(reeval ? { reeval } : {}) }, sel };
}
const spearmanOf = (pairs) => spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) ?? NaN;

// ---------- panel evaluation (+ racing) ----------
const fixedOpp = { hunter: [], survivor: [] };   // fixed external opponents FOR each side
let hof = { hunter: [], survivor: [] };          // hall of fame OF each side
let prevRanked = { hunter: null, survivor: null };
let cma = null;                                  // { hunter: state, survivor: state }

async function evalPanel(gen) {
  const panels = {
    hunter: buildPanel(opts.panel, { space: spaces.survivor, ranked: prevRanked.survivor, pop: survivors, mean: cma && fromNorm(spaces.survivor, cma.survivor.mean), hof: hof.survivor, fixed: fixedOpp.hunter }),
    survivor: buildPanel(opts.panel, { space: spaces.hunter, ranked: prevRanked.hunter, pop: hunters, mean: cma && fromNorm(spaces.hunter, cma.hunter.mean), hof: hof.hunter, fixed: fixedOpp.survivor }),
  };
  const pops = { hunter: hunters, survivor: survivors };
  const A = { hunter: agg(hunters.length), survivor: agg(survivors.length) };
  const slotsDone = { hunter: 0, survivor: 0 };
  const all = [];
  const seedsUsed = { hunter: [], survivor: [] };
  const play = async (plan) => {
    // plan: { side: idx[] } with `n` new slots each -> one pool batch for both sides (no idle tail between them)
    const jobs = [];
    for (const side of ['hunter', 'survivor']) {
      if (!plan[side] || !plan[side].idx.length) continue;
      const sl = makeSlots(panels[side], plan[side].n, R, slotsDone[side]);
      slotsDone[side] += plan[side].n;
      seedsUsed[side].push(...sl.map((s) => s.seed));
      jobs.push(...slotJobs({ side, pop: pops[side], panel: panels[side], idx: plan[side].idx, slots: sl }));
    }
    const res = await pool.run(jobs);
    // results come back in job order = slot-major, so each individual's F stays in slot order
    for (const r of res) (r.side === 'hunter' ? addHunter : addSurvivor)(A[r.side][r.i], r);
    all.push(...res);
  };
  const idxAll = (side) => pops[side].map((_, i) => i);
  await play({ hunter: { idx: idxAll('hunter'), n: opts.slots }, survivor: { idx: idxAll('survivor'), n: opts.slots } });
  const sel = {};
  for (const side of ['hunter', 'survivor']) sel[side] = { rel: reliability(A[side].map((a) => a.F.slice(0, opts.slots)), { centred: true }) };

  let race = null;
  const keep = cma ? cma.hunter.mu : keepCount();   // the selection cut: GA elites / CMA-ES parents (mu)
  const order = {};
  if (opts.race) {
    const st = {}, F = {};
    for (const side of ['hunter', 'survivor']) { F[side] = A[side].map((a) => a.F); st[side] = raceStep(F[side], { inSet: [], outSet: [], alive: idxAll(side) }, keep, opts.race.z); }
    const stages = { hunter: [st.hunter.alive.length], survivor: [st.survivor.alive.length] };
    while (true) {
      const plan = {};
      for (const side of ['hunter', 'survivor']) {
        const room = opts.race.max - slotsDone[side];
        if (st[side].alive.length && room > 0) plan[side] = { idx: st[side].alive.slice().sort((a, b) => a - b), n: Math.min(opts.race.step, room) };
      }
      if (!plan.hunter && !plan.survivor) break;
      await play(plan);
      for (const side of ['hunter', 'survivor']) if (plan[side]) {
        st[side] = raceStep(F[side], st[side], keep, opts.race.z);
        stages[side].push(st[side].alive.length);
      }
    }
    race = {};
    for (const side of ['hunter', 'survivor']) {
      const fitOf = (i) => mean(F[side][i]);
      const by = (list) => list.slice().sort((a, b) => fitOf(b) - fitOf(a) || a - b);
      order[side] = [...by(st[side].inSet), ...by(st[side].alive), ...by(st[side].outSet)];
      race[side] = { slots: slotsDone[side], contenders: stages[side], undecided: st[side].alive.length, matches: A[side].reduce((a, x) => a + x.n, 0) };
    }
  }
  const ranked = {};
  for (const side of ['hunter', 'survivor']) {
    const sc = scored(pops[side], A[side]);
    ranked[side] = order[side] ? order[side].map((i) => sc[i]) : sc.sort((a, b) => b.fit - a.fit);
    if (race) sel[side].race = race[side];
  }
  return {
    rh: ranked.hunter, rs: ranked.survivor, tot: outcomeOf(all), matches: all.length, sel,
    extra: { panel: { hunter: panels.hunter.map((p) => p.name), survivor: panels.survivor.map((p) => p.name), slots: opts.slots } },
  };
}

// ---------- main loop ----------
let hunters, survivors, startGen = 1;
if (saved) {
  ({ hunters, survivors } = saved); startGen = saved.gen + 1; nextId = saved.nextId;
  if (saved.hof) hof = saved.hof;
  if (saved.prev) prevRanked = saved.prev;
  if (saved.cma) cma = saved.cma;
} else if (opt === 'cmaes') {
  // start at the hand-tuned defaults (the GA keeps them as individual 0 for the same reason)
  cma = {
    hunter: cmaInit(spaces.hunter, defaults(spaces.hunter), { lambda: opts.pop, sigma0: opts.cma.sigma0, mirror: opts.cma.mirror, minSigma: opts.cma.minSigma }),
    survivor: cmaInit(spaces.survivor, defaults(spaces.survivor), { lambda: opts.pop, sigma0: opts.cma.sigma0, mirror: opts.cma.mirror, minSigma: opts.cma.minSigma }),
  };
} else {
  hunters = initPop('hunter'); survivors = initPop('survivor');
}
if (opts.panel) for (const s of opts.panelFixed) {
  const p = resolveParamSet(s, spaces);
  if (p.survivor) fixedOpp.hunter.push({ name: p.name, params: p.survivor, modifiers: p.modifiers });
  if (p.hunter) fixedOpp.survivor.push({ name: p.name, params: p.hunter, modifiers: p.modifiers });
}
// provenance: source snapshot (git HEAD + dirty flag), map pool fingerprint, the exact command and the full config
const cfgFile = join(outDir, 'config.json');
const prevCfg = args.resume && existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : null;
if (prevCfg && modsKey(modsOf(prevCfg)) !== modsKey(mods)) {
  throw new Error(`--resume: this run was started with game modifiers ${describeMods(modsOf(prevCfg)) || 'standard'}, not ${describeMods(mods) || 'standard'} (pass the same --mod flags)`);
}
const benchSet = opts.benchEvery > 0 ? {
  seeds: heldOutSeeds(opts.benchSeeds),
  opponents: [resolveParamSet('default', spaces), ...opts.benchOpponents.map((s) => resolveParamSet(s, spaces))],
} : null;
const config = {
  kind: 'evolve', ...modRec, ...opts, spaces,
  git: gitInfo(), mapPool: mapPoolInfo(opts.map), argv: process.argv.slice(2), node: process.version, startedAt: new Date().toISOString(), startGen,
  bench: benchSet && { seeds: { first: benchSet.seeds[0], n: benchSet.seeds.length }, opponents: benchSet.opponents.map((o) => ({ name: o.name, source: o.source, stale: o.stale, modifiers: o.modifiers, hunter: o.hunter, survivor: o.survivor })) },
  // a resumed run keeps the provenance of its earlier legs
  ...(prevCfg ? { previous: [...(prevCfg.previous ?? []), { ...prevCfg, previous: undefined, spaces: undefined }] } : {}),
};
const pool = createPool({ threads: opts.threads, mapPath: opts.map, hunterBrain: opts.hunterBrain, survivorBrain: opts.survivorBrain, metrics: opts.metrics, mods });
mkdirSync(outDir, { recursive: true });
writeFileSync(cfgFile, JSON.stringify(config, null, 2));
if (!modRec.standard) console.log(`GAME MODIFIERS: ${describeMods(mods)} (non-standard rules)`);
for (const w of new Set(modMismatches([...(benchSet?.opponents ?? []), ...fixedOpp.hunter, ...fixedOpp.survivor], mods))) console.warn(w);
console.log(`evolving on ${opts.map}: pop ${opts.pop}+${opts.pop}, ${opts.panel ? `panel ${opts.slots} slots${opts.race ? ` (race to ${opts.race.max})` : ''}` : `${opts.rounds} rounds/gen`}${opt === 'cmaes' ? ', sep-CMA-ES' : ''}, ${opts.threads} threads -> ${outDir}`);

pool.takeStats();
for (let gen = startGen; gen < startGen + opts.gens; gen++) {
  const t0 = Date.now();
  let cand = null;
  if (cma) {
    // sample this generation's populations from each side's search distribution
    cand = { hunter: cmaAsk(spaces.hunter, cma.hunter, R), survivor: cmaAsk(spaces.survivor, cma.survivor, R) };
    hunters = cand.hunter.map((c) => individual('hunter', c.params, null, gen));
    survivors = cand.survivor.map((c) => individual('survivor', c.params, null, gen));
  }
  const ev = opts.panel ? await evalPanel(gen) : await evalCoevo();
  const { rh, rs, tot } = ev;
  const sel = ev.sel;
  if (!cma) { sel.hunter.persist = persistence(prevRanked.hunter, rh); sel.survivor.persist = persistence(prevRanked.survivor, rs); }

  let cmaLog = null;
  if (cma) {
    cma = { hunter: cmaTell(cma.hunter, rh.map((x) => cand.hunter[x.idx].x)), survivor: cmaTell(cma.survivor, rs.map((x) => cand.survivor[x.idx].x)) };
    cmaLog = { hunter: cmaSummary(spaces.hunter, cma.hunter), survivor: cmaSummary(spaces.survivor, cma.survivor) };
  }
  // the side's best estimate of a champion: GA = rank 1; CMA-ES = the (updated) distribution mean
  const champ = cma
    ? { hunter: fromNorm(spaces.hunter, cma.hunter.mean), survivor: fromNorm(spaces.survivor, cma.survivor.mean), hunterId: `mean@${gen}`, survivorId: `mean@${gen}` }
    : { hunter: rh[0].params, survivor: rs[0].params, hunterId: rh[0].id, survivorId: rs[0].id };
  if (opts.panel && opts.hofEvery > 0 && gen % opts.hofEvery === 0) {
    hof = { hunter: hofAdd(hof.hunter, { gen, id: champ.hunterId, params: champ.hunter }, opts.hofSize), survivor: hofAdd(hof.survivor, { gen, id: champ.survivorId, params: champ.survivor }, opts.hofSize) };
  }

  // fixed-opponent benchmark on held-out seeds: comparable across generations and across runs
  let bench = null;
  if (benchSet && (gen % opts.benchEvery === 0 || gen === startGen + opts.gens - 1)) {
    const br = await pool.run(benchJobs({ champ: { hunter: champ.hunter, survivor: champ.survivor }, opponents: benchSet.opponents, seeds: benchSet.seeds }));
    bench = { seeds: { first: benchSet.seeds[0], n: benchSet.seeds.length }, champ: { hunter: champ.hunterId, survivor: champ.survivorId }, vs: groupBench(br) };
  }

  const showFit = opts.carry || opts.reevalTop > 0 || !!opts.panel || !!cma;
  const brief = (x) => ({ id: x.id, born: x.born, parents: x.parents, ...(showFit ? { fit: +x.fit.toFixed(4), games: x.games } : {}), bp: Math.round(x.bp), kills: x.kills !== undefined ? +x.kills.toFixed(2) : undefined, escapes: +(x.escapes ?? 0).toFixed(2), gensDone: +(x.gensDone ?? 0).toFixed(2), params: round(x.params), fitSd: +x.fitSd.toFixed(4) });
  const perf = pool.takeStats();
  const r3 = (v) => (v === null || v === undefined ? null : v);
  appendFileSync(logFile, JSON.stringify({
    gen, ...(modRec.standard ? {} : { modifiers: modRec.modifiers }), seconds: (Date.now() - t0) / 1000, matches: ev.matches, outcome: tot,
    ...ev.extra, ...(bench ? { bench } : {}), ...(cmaLog ? { cma: cmaLog } : {}),
    // edges: knobs with >= 25 % of the population within 5 % of a range bound (share at lo / hi)
    hunters: { ranking: rh.map(brief), knobs: knobStats('hunter', hunters), edges: edgeReport(spaces.hunter, hunters) },
    survivors: { ranking: rs.map(brief), knobs: knobStats('survivor', survivors), edges: edgeReport(spaces.survivor, survivors) },
    selection: sel, perf,
  }) + '\n');

  const keepPrev = (rk) => rk.slice(0, 16).map((x) => ({ id: x.id, fit: x.fit, params: x.params }));
  prevRanked = { hunter: keepPrev(rh), survivor: keepPrev(rs) };
  if (!cma) {
    hunters = nextPopulation('hunter', rh, gen);
    survivors = nextPopulation('survivor', rs, gen);
  }
  writeFileSync(popFile, JSON.stringify({
    gen, nextId, hunters, survivors, best: { hunter: champ.hunter, survivor: champ.survivor },
    prev: prevRanked, rng: { seed: opts.seed, state: R.state() }, ...(opts.panel || cma ? { hof } : {}), ...(cma ? { cma } : {}),
  }, null, 2));
  // champions.json in the climb format, so the viewer/matchup can play the current best pair
  writeFileSync(champFile, JSON.stringify({ gen, ...(modRec.standard ? {} : modRec), champ: { hunter: round(champ.hunter), survivor: round(champ.survivor) }, ...(cma ? { bestSample: { hunter: round(rh[0].params), survivor: round(rs[0].params) } } : {}) }, null, 2));
  if (opts.panel) writeFileSync(join(outDir, 'hof.json'), JSON.stringify(hof, null, 2));

  const tk = knobStats('hunter', rh).tunnel;
  const relTxt = (s) => (s.rel ? `rel ${s.rel.rel ?? '-'}${s.persist ? ` persist ${s.persist.rho ?? '-'}` : ''}` : 'rel -');
  console.log(`gen ${String(gen).padStart(3)}  kills ${tot.kills.toFixed(2)} esc ${tot.escapes.toFixed(2)} gens ${tot.gensDone.toFixed(2)}  ` +
    `H score ${tot.hunterScore100.toFixed(1)} (stages ${tot.hookStages.toFixed(1)})  S BP ${Math.round(tot.survivorBP)}  best H ${(100 * rh[0].fit).toFixed(1)} S ${Math.round(rs[0].bp)}  ` +
    (tk ? `tunnel med ${tk.med.toFixed(2)} [${tk.q25.toFixed(2)}..${tk.q75.toFixed(2)}]  ` : '') + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`        selection H ${relTxt(sel.hunter)} | S ${relTxt(sel.survivor)}  ${cmaLog ? `sigma H ${cmaLog.hunter.sigma} S ${cmaLog.survivor.sigma}  ` : ''}` +
    `${perf.matches} matches ${perf.matchesPerS}/s util ${perf.util} ${r3(perf.msPerGameS)} ms/game-s`);
  if (bench) for (const [name, v] of Object.entries(bench.vs)) {
    console.log(`        bench vs ${name}: champ H ${v.hunter ? `kills ${v.hunter.kills.toFixed(2)} score ${v.hunter.hunterScore100.toFixed(1)}` : '-'}  |  ` +
      `champ S ${v.survivor ? `esc ${v.survivor.escapes.toFixed(2)} gens ${v.survivor.gensDone.toFixed(2)} fit ${v.survivor.survivorFit.toFixed(3)}` : '-'}`);
  }
}
await pool.close();
