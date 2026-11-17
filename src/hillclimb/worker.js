// worker_threads worker: plays batches of matches and returns compact results (play.js does the playing).
// The map pool, brains and metric modules are loaded once per worker (not per job); nav/loop caches stay warm
// across batches and generations. Each reply carries the batch's busy time for the pool's throughput report.
import { parentPort, workerData } from 'node:worker_threads';
import { loadMapPool } from './maps.js';
import { getBrains } from '../brains/index.js';
import { makePlayer, loadMetrics } from './play.js';

const playOne = makePlayer({
  maps: loadMapPool(workerData.mapPath),
  brains: getBrains(workerData.hunterBrain, workerData.survivorBrain),
  metrics: await loadMetrics(workerData.metrics ?? []),
  mods: workerData.mods ?? null,   // game modifiers for every match this pool plays
});

parentPort.on('message', ({ id, jobs }) => {
  const t0 = performance.now();
  const results = jobs.map((j) => playOne(j));
  parentPort.postMessage({ id, results, ms: performance.now() - t0 });
});
