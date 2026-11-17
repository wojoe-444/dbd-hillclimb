// Worker pool for playing batches of matches in parallel (worker.js does the playing).
// Jobs are handed out in small chunks from one shared queue (dynamic load balancing: a match lasts 100-900 game-s,
// so static splits leave cores idle at the end of a batch). Several run() calls may be in flight at once; they share
// the queue. Results never depend on which worker played a job or in what order (matches are pure functions of the job).
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function createPool({ threads, mapPath, hunterBrain = 'param', survivorBrain = 'param', metrics = [], mods = null, chunk = 1 }) {
  // mods: game modifier set (src/sim/modifiers.js), sent to every worker and applied to every match
  const workers = [], idle = [], queue = [], pending = new Map();
  let nextId = 0;
  const stats = { jobs: 0, busyMs: 0, gameS: 0, since: Date.now() };
  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const { id, jobs, done } = queue.shift();
      pending.set(id, done);
      w.postMessage({ id, jobs });
    }
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(join(here, 'worker.js'), { workerData: { mapPath, hunterBrain, survivorBrain, metrics, mods } });
    w.on('message', ({ id, results, ms }) => {
      stats.jobs += results.length; stats.busyMs += ms ?? 0;
      for (const r of results) stats.gameS += r.durationS ?? 0;
      pending.get(id)(results); pending.delete(id); idle.push(w); pump();
    });
    w.on('error', (e) => { console.error(e); process.exit(1); });
    workers.push(w); idle.push(w);
  }
  return {
    threads,
    // jobs: [{ seed, hunterParams, survivorParams, ...extra }] -> results in the same order (tag fields echoed back)
    run(jobs) {
      const parts = [];
      for (let i = 0; i < jobs.length; i += chunk) {
        const slice = jobs.slice(i, i + chunk);
        parts.push(new Promise((done) => { queue.push({ id: nextId++, jobs: slice, done }); }).then((res) => res.map((r, k) => ({ ...slice[k].tag, ...r }))));
      }
      pump();
      return Promise.all(parts).then((r) => r.flat());
    },
    // throughput since the last reset: matches/s (wall), game-seconds/s, worker utilisation, ms per game-second
    // per match per busy core (the compute cost, independent of how many cores were free)
    takeStats() {
      const wall = (Date.now() - stats.since) / 1000;
      const out = {
        matches: stats.jobs, wallS: +wall.toFixed(1),
        matchesPerS: wall > 0 ? +(stats.jobs / wall).toFixed(3) : 0,
        gameSPerS: wall > 0 ? +(stats.gameS / wall).toFixed(1) : 0,
        util: wall > 0 ? +(stats.busyMs / 1000 / wall / threads).toFixed(3) : 0,
        msPerGameS: stats.gameS > 0 ? +(stats.busyMs / stats.gameS).toFixed(3) : null,
      };
      stats.jobs = 0; stats.busyMs = 0; stats.gameS = 0; stats.since = Date.now();
      return out;
    },
    close() { for (const w of workers) w.terminate(); },
  };
}
