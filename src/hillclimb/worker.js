// worker_threads worker: plays batches of matches and returns compact results (play.js does the playing).
import { parentPort, workerData } from 'node:worker_threads';
import { loadMapPool } from './maps.js';
import { getBrains } from '../brains/index.js';
import { makePlayer, loadMetrics } from './play.js';

const playOne = makePlayer({
  maps: loadMapPool(workerData.mapPath),
  brains: getBrains(workerData.hunterBrain, workerData.survivorBrain),
  metrics: await loadMetrics(workerData.metrics ?? []),
});

parentPort.on('message', ({ id, jobs }) => {
  const results = jobs.map((j) => playOne(j));
  parentPort.postMessage({ id, results });
});
