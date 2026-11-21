// Evaluation plumbing shared by evolve.js, scripts/crossplay.js and scripts/knob-sensitivity.js:
// pairing/seed plans, fixed-opponent benchmarks on held-out seeds, result summaries, range-edge reports,
// param-set resolution ("default", run dirs, run@genN, champions/population files) and run provenance.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, clampParams, evolutionChampion } from './params.js';
import { loadMapPool } from './maps.js';
import { modsOf, modsKey, describeMods } from '../sim/modifiers.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Training seeds are drawn from [0, 2^31); held-out seeds live at 2^31 + i, so they can never be trained on.
// Consecutive seeds walk the map pool (variant = seed % pool size), so n = pool size covers every variant once.
export const HELDOUT_BASE = 2 ** 31;
export const heldOutSeeds = (n, base = HELDOUT_BASE) => Array.from({ length: n }, (_, i) => base + i);

// One generation's matches. Every round is a random permutation of survivor teams against hunters, so every
// individual plays exactly `rounds` matches (when the populations are the same size).
//   paired = false: a fresh random seed per match (the historical behaviour; RNG consumption is unchanged).
//   paired = true:  one seed per round shared by every match of that round, so within a generation every
//                   individual of a side sees the same seed/map set and differences are not seed luck.
export function roundJobs({ hunters, survivors, rounds, R, paired = false, roundOffset = 0 }) {
  const jobs = [];
  for (let r = 0; r < rounds; r++) {
    const roundSeed = paired ? Math.floor(R() * 2 ** 31) : null;
    const perm = survivors.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let h = 0; h < hunters.length; h++) {
      const s = perm[h % perm.length];
      const seed = paired ? roundSeed : Math.floor(R() * 2 ** 31);
      jobs.push({ seed, hunterParams: hunters[h].params, survivorParams: survivors[s].params, tag: { h, s, round: r + roundOffset } });
    }
  }
  return jobs;
}

// Extra matches for the top-k of each side (re-evaluation, so a lucky individual does not stick as elite).
// Each extra round has one shared seed; the candidates face randomly drawn opponents from the other population.
// tag.only says whose fitness the match counts for (the opponent's sample would be unpaired, so it is dropped).
export function reevalJobs({ hunters, survivors, topH, topS, rounds, R }) {
  const jobs = [];
  for (let r = 0; r < rounds; r++) {
    const seed = Math.floor(R() * 2 ** 31);
    for (const h of topH) {
      const s = Math.floor(R() * survivors.length);
      jobs.push({ seed, hunterParams: hunters[h].params, survivorParams: survivors[s].params, tag: { h, s, only: 'hunter', reeval: r } });
    }
    for (const s of topS) {
      const h = Math.floor(R() * hunters.length);
      jobs.push({ seed, hunterParams: hunters[h].params, survivorParams: survivors[s].params, tag: { h, s, only: 'survivor', reeval: r } });
    }
  }
  return jobs;
}

// Fixed-opponent benchmark: the champion hunter against each reference survivor team and each reference hunter
// against the champion survivor team, all on the same held-out seeds. Fully determined by (params, seeds).
export function benchJobs({ champ, opponents, seeds }) {
  const jobs = [];
  for (const o of opponents) {
    for (const seed of seeds) {
      if (champ.hunter && o.survivor) jobs.push({ seed, hunterParams: champ.hunter, survivorParams: o.survivor, tag: { bench: o.name, side: 'hunter' } });
      if (champ.survivor && o.hunter) jobs.push({ seed, hunterParams: o.hunter, survivorParams: champ.survivor, tag: { bench: o.name, side: 'survivor' } });
    }
  }
  return jobs;
}

export function groupBench(results) {
  const out = {};
  for (const r of results) ((out[r.bench] ??= {})[r.side] ??= []).push(r);
  for (const name of Object.keys(out)) for (const side of Object.keys(out[name])) out[name][side] = summarize(out[name][side]);
  return out;
}

// Mean outcome of a list of match results (+ the mean of every optional metric, under `metrics`).
export const SUMMARY_KEYS = ['kills', 'escapes', 'gensDone', 'genProgress', 'hooks', 'hookStages', 'hunterScore100', 'hunterFit', 'survivorFit', 'survivalTime', 'survivorBP', 'hunterBP', 'durationS'];
export function summarize(results, keys = SUMMARY_KEYS, digits = 4) {
  const n = results.length, out = { n };
  for (const k of keys) out[k] = n ? +(results.reduce((a, r) => a + (r[k] ?? 0), 0) / n).toFixed(digits) : 0;
  const m = averageMetrics(results, digits);
  if (m) out.metrics = m;
  return out;
}

export function averageMetrics(results, digits = 4) {
  const sum = {}, cnt = {};
  for (const r of results) if (r.metrics) for (const [k, v] of Object.entries(r.metrics)) if (Number.isFinite(v)) { sum[k] = (sum[k] ?? 0) + v; cnt[k] = (cnt[k] ?? 0) + 1; }
  const keys = Object.keys(sum);
  if (!keys.length) return null;
  return Object.fromEntries(keys.map((k) => [k, +(sum[k] / cnt[k]).toFixed(digits)]));
}

// Which knobs sit at their range edges: share of the population within `tol` (fraction of range) of each bound.
// Only knobs with at least `min` share at one bound are listed.
export function edgeReport(space, pop, tol = 0.05, min = 0.25) {
  const out = {};
  const params = pop.map((x) => x.params ?? x);
  for (const [k, [lo, hi]] of Object.entries(space)) {
    const w = (hi - lo) * tol;
    let nlo = 0, nhi = 0;
    for (const p of params) { const v = p[k]; if (v <= lo + w) nlo++; if (v >= hi - w) nhi++; }
    const slo = nlo / params.length, shi = nhi / params.length;
    if (slo >= min || shi >= min) out[k] = { lo: +slo.toFixed(2), hi: +shi.toFixed(2) };
  }
  return out;
}

// ---------- param sets ----------
// spec forms: "default" | run dir (champions.json) | "<run dir>@gen12" (the champion of that generation in evo.jsonl)
//   | path to champions.json / population.json / { hunter, survivor } JSON | "name=<any of these>" to rename.
// Params are clamped into today's spaces (missing knobs -> today's default, retired knobs dropped); the number of
// filled-in/dropped knobs is reported so stale archives are visible.
export function resolveParamSet(spec, spaces) {
  let name = null, src = spec;
  const eq = spec.indexOf('=');
  if (eq > 0 && !/^[a-zA-Z]:[\\/]/.test(spec)) { name = spec.slice(0, eq); src = spec.slice(eq + 1); }
  let raw, runDir = null, champFile = null;
  if (src === 'default') raw = { hunter: defaults(spaces.hunter), survivor: defaults(spaces.survivor) };
  else {
    const m = src.match(/^(.*)@gen(\d+)$/);
    const path = resolve(m ? m[1] : src);
    if (m) {
      const rows = readFileSync(join(path, 'evo.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
      const row = rows.find((r) => r.gen === +m[2]);
      if (!row) throw new Error(`${src}: generation ${m[2]} not in evo.jsonl`);
      runDir = path;
      raw = evolutionChampion(row);
    } else {
      const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'champions.json') : path;
      const j = JSON.parse(readFileSync(file, 'utf8'));
      raw = j.champ ?? j.best ?? j;
      runDir = dirname(file); champFile = j;
    }
  }
  const out = { name: name ?? (src === 'default' ? 'default' : basename(src.replace(/[\\/]+$/, '').replace(/[\\/]champions\.json$/, ''))), source: src };
  // game modifiers the param set was trained under (champions.json, else the run's config.json; none = standard)
  out.modifiers = src === 'default' ? null : trainedMods(runDir, champFile);
  out.stale = {};
  for (const side of ['hunter', 'survivor']) {
    if (!raw[side]) continue;
    out[side] = clampParams(spaces[side], raw[side]);
    const missing = Object.keys(spaces[side]).filter((k) => !(k in raw[side]));
    const dropped = Object.keys(raw[side]).filter((k) => !(k in spaces[side]));
    if (missing.length || dropped.length) out.stale[side] = { missing, dropped };
  }
  return out;
}

function trainedMods(runDir, champ) {
  if (champ?.modifiers) return modsOf(champ);
  const cf = runDir && join(runDir, 'config.json');
  if (cf && existsSync(cf)) { try { return modsOf(JSON.parse(readFileSync(cf, 'utf8'))); } catch { /* unreadable: treat as standard */ } }
  return {};
}

/** Warnings for param sets (resolveParamSet results) trained under different game modifiers than `mods`. */
export function modMismatches(sets, mods) {
  const want = modsKey(mods), label = (m) => describeMods(m) || 'standard';
  return sets.filter((p) => p && p.modifiers && modsKey(p.modifiers) !== want)
    .map((p) => `WARNING: ${p.name} was trained under ${label(p.modifiers)} but is played here under ${label(mods)}`);
}

// ---------- provenance ----------
export function gitInfo(cwd = REPO_ROOT) {
  const git = (...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); } catch { return null; } };
  const status = git('status', '--porcelain');
  return {
    sha: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: status === null ? null : status.length > 0,
    dirtyFiles: status ? status.split(/\r?\n/).filter(Boolean).slice(0, 200) : [],
  };
}

// Fingerprint of the map pool actually loaded (so a run can be tied to the exact variants it saw).
export function mapPoolInfo(path) {
  const h = createHash('sha1');
  const maps = loadMapPool(path, (bytes) => h.update(bytes));
  return { n: maps.length, sha1: h.digest('hex') };
}
