// worker_threads worker: plays batches of matches and returns compact results.
import { parentPort, workerData } from 'node:worker_threads';
import { loadMapPool } from './maps.js';
import { createMatch } from '../sim/index.js';
import { getBrains } from '../brains/index.js';
import { scoreBloodpoints } from './bloodpoints.js';

const maps = loadMapPool(workerData.mapPath);
const brains = getBrains(workerData.hunterBrain, workerData.survivorBrain);

parentPort.on('message', ({ id, jobs }) => {
  const results = jobs.map((j) => playOne(j));
  parentPort.postMessage({ id, results });
});

export function playOne({ seed, hunterParams, survivorParams, config }) {
  // each seed plays on one variant of the pool (tile spawns differ per match, like the real game)
  const map = maps[seed % maps.length];
  const m = createMatch({
    map,
    seed,
    config,
    hunter: brains.hunter.make(hunterParams),
    survivors: [0, 1, 2, 3].map(() => brains.survivor.make(survivorParams)),
  });
  while (!m.over) m.step();
  const res = m.result();
  // generator progress in gen-equivalents: finished gens count 1, unfinished ones their current fraction
  // (so every repair-second counts, net of the multi-repairer efficiency penalty, kicks/regression and fumbles)
  let genProgress = 0;
  for (const g of m.gens) genProgress += g.done ? 1 : Math.min(1, g.p / m.need);
  const bp = scoreBloodpoints(res);
  return {
    seed,
    survivorBP: bp.survivorBP, hunterBP: bp.hunterBP, survivorFit: bp.survivorFit, hunterFit: bp.hunterFit,
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
}
