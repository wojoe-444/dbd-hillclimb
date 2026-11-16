// worker_threads worker: plays batches of matches and returns compact results.
import { parentPort, workerData } from 'node:worker_threads';
import { loadMapPool } from './maps.js';
import { runMatch } from '../sim/index.js';
import { getBrains } from '../brains/index.js';

const maps = loadMapPool(workerData.mapPath);
const brains = getBrains(workerData.hunterBrain, workerData.survivorBrain);

parentPort.on('message', ({ id, jobs }) => {
  const results = jobs.map((j) => playOne(j));
  parentPort.postMessage({ id, results });
});

export function playOne({ seed, hunterParams, survivorParams, config }) {
  // each seed plays on one variant of the pool (tile spawns differ per match, like the real game)
  const map = maps[seed % maps.length];
  const res = runMatch({
    map,
    seed,
    config,
    hunter: brains.hunter.make(hunterParams),
    survivors: [0, 1, 2, 3].map(() => brains.survivor.make(survivorParams)),
  });
  return {
    seed,
    mapId: map.id,
    kills: res.kills,
    escapes: res.escapes,
    timeouts: res.timeouts,
    gensDone: res.gensDone,
    hooks: res.hooks,
    durationS: res.durationS,
  };
}
