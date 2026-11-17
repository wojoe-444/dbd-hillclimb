// Plays one match and turns it into the compact result the evolution / evaluation scripts aggregate.
// Shared by worker.js (worker_threads) and by single-threaded callers (tests, scripts).
//
// Optional per-match metrics: a metric is { name, create(match, job) -> { step?(match), finish?(match, res) } }.
// finish() returns a number or an object of numbers; the values land in result.metrics[name] (objects are
// flattened to `name.key`). Metric modules are loaded by path (loadMetrics) so they can cross into worker threads:
// a module may `export default` one metric or an array of them, or `export const metrics = [...]`.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMatch } from '../sim/index.js';
import { deepMerge } from '../sim/config.js';
import { modsConfig, isStandard } from '../sim/modifiers.js';
import { scoreBloodpoints, BP } from './bloodpoints.js';
import { hunterTableScore, hookStagesTotal, survivalTimeScore } from './hunterscore.js';

export async function loadMetrics(paths = []) {
  const out = [];
  for (const p of paths) {
    const mod = await import(pathToFileURL(resolve(p)).href);
    const list = mod.metrics ?? mod.default;
    for (const m of Array.isArray(list) ? list : [list]) {
      if (!m || typeof m.name !== 'string' || typeof m.create !== 'function') throw new Error(`metric module ${p}: expected { name, create(match) }`);
      out.push(m);
    }
  }
  return out;
}

// maps: array of map JSONs (variant = seed % maps.length); brains: getBrains(...) result; metrics: loaded metric defs;
// mods: game modifier set (src/sim/modifiers.js) applied to every match, under any job.config override
export function makePlayer({ maps, brains, metrics = [], mods = null }) {
  const modCfg = mods && !isStandard(mods) ? modsConfig(mods) : null;
  return function playOne(job) {
    const { seed, hunterParams, survivorParams } = job;
    const config = modCfg ? deepMerge(modCfg, job.config ?? {}) : job.config;
    // each seed plays on one variant of the pool (tile spawns differ per match, like the real game)
    const map = maps[seed % maps.length];
    const m = createMatch({
      map,
      seed,
      config,
      hunter: brains.hunter.make(hunterParams),
      survivors: [0, 1, 2, 3].map(() => brains.survivor.make(survivorParams)),
    });
    const probes = metrics.map((d) => ({ d, p: d.create(m, job) || {} }));
    // chase share bookkeeping: objective BP made by the others while survivor k is the chased one
    const objOf = (x) => x.repairC * BP.survivor.repairPerGen + x.leverS * BP.survivor.leverPerSecond;
    const share = [0, 0, 0, 0];
    let prevObj = m.survivors.map(objOf);
    while (!m.over) {
      m.step();
      const now = m.survivors.map(objOf);
      const k = m.chaseTgt;
      if (k >= 0) for (let j = 0; j < 4; j++) if (j !== k) share[k] += now[j] - prevObj[j];
      prevObj = now;
      for (const { p } of probes) if (p.step) p.step(m);
    }
    const res = m.result();
    res.chaseShareObj = share;
    // generator progress in gen-equivalents: finished gens count 1, unfinished ones their current fraction
    // (so every repair-second counts, net of the multi-repairer efficiency penalty, kicks/regression and fumbles)
    let genProgress = 0;
    for (const g of m.gens) genProgress += g.done ? 1 : Math.min(1, g.p / m.need);
    const bp = scoreBloodpoints(res);
    const out = {
      seed,
      survivorBP: bp.survivorBP, hunterBP: bp.hunterBP,
      // survivor fitness [user]: half normalised bloodpoints, half time-weighted survival (hunterscore.js survivalTimeScore)
      survivorFit: 0.5 * bp.survivorFit + 0.5 * survivalTimeScore(res), survivalTime: survivalTimeScore(res),
      // hunter fitness = the user's outcome table (0..100 -> 0..1); hunterBP is kept for reference only
      hunterScore100: hunterTableScore(res), hookStages: hookStagesTotal(res), hunterFit: hunterTableScore(res) / 100,
      survivorCats: bp.survivorCats, hunterCats: bp.hunterCats,
      mapId: map.id,
      kills: res.kills,
      escapes: res.escapes,
      timeouts: res.timeouts,
      // per-survivor time in the match (escaped survivors count as surviving the whole match)
      alive: res.survivors.map((x) => (x.outcome === 'escaped' ? Infinity : (x.tOut ?? res.durationS))),
      gensDone: res.gensDone,
      genProgress,
      hooks: res.hooks,
      durationS: res.durationS,
    };
    if (probes.length) {
      out.metrics = {};
      for (const { d, p } of probes) {
        const v = p.finish ? p.finish(m, res) : undefined;
        if (typeof v === 'number') out.metrics[d.name] = v;
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'number') out.metrics[`${d.name}.${k}`] = x;
      }
    }
    return out;
  };
}
