// Worker pool for playing batches of matches in parallel (worker.js does the playing).
// Jobs are handed out in small chunks from one shared queue (dynamic load balancing: a match lasts 100-900 game-s,
// so static splits leave cores idle at the end of a batch). Several run() calls may be in flight at once; they share
// the queue. Results never depend on which worker played a job or in what order (matches are pure functions of the job).
import { Worker } from 'node:worker_threads';

export function createPool({ threads, mapPath, hunterBrain = 'param', survivorBrain = 'param', metrics = [], mods = null, chunk = 1 }) {
  for (const [name, value] of Object.entries({ threads, chunk })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer (got ${value})`);
  }
  // mods: game modifier set (src/sim/modifiers.js), sent to every worker and applied to every match
  const workers = [], idle = [], queue = [], pending = new Map();
  let nextId = 0;
  let failure, closed;
  const stats = { jobs: 0, busyMs: 0, gameS: 0, since: Date.now() };
  const stop = (error) => {
    if (closed) return closed;
    failure = error;
    for (const part of queue) part.reject(error);
    for (const part of pending.values()) part.reject(error);
    queue.length = 0;
    pending.clear();
    idle.length = 0;
    closed = Promise.allSettled(workers.map((w) => w.terminate())).then(() => {});
    return closed;
  };
  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const part = queue.shift();
      const { id, jobs } = part;
      pending.set(id, part);
      try {
        w.postMessage({ id, jobs });
      } catch (error) {
        stop(error);
      }
    }
  };
  try {
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: { mapPath, hunterBrain, survivorBrain, metrics, mods } });
      workers.push(w); idle.push(w);
      w.on('message', ({ id, results, ms }) => {
        if (closed) return;
        stats.jobs += results.length; stats.busyMs += ms ?? 0;
        for (const r of results) stats.gameS += r.durationS ?? 0;
        pending.get(id).resolve(results); pending.delete(id); idle.push(w); pump();
      });
      w.on('error', stop);
      w.on('messageerror', stop);
      w.on('exit', (code) => {
        if (!closed) stop(new Error(`Match worker exited unexpectedly (code ${code})`));
      });
    }
  } catch (error) {
    stop(error);
    throw error;
  }
  return {
    threads,
    // jobs: [{ seed, hunterParams, survivorParams, ...extra }] -> results in the same order (tag fields echoed back)
    run(jobs) {
      if (closed) return Promise.reject(failure);
      const parts = [];
      for (let i = 0; i < jobs.length; i += chunk) {
        const slice = jobs.slice(i, i + chunk);
        const part = new Promise((resolve, reject) => { queue.push({ id: nextId++, jobs: slice, resolve, reject }); });
        parts.push(part.then((res) => res.map((r, k) => ({ ...slice[k].tag, ...r }))));
      }
      const result = Promise.all(parts).then((r) => r.flat());
      pump();
      return result;
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
    close() { return stop(new Error('Match worker pool is closed')); },
  };
}
