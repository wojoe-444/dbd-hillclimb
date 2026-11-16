// Worker pool for playing batches of matches in parallel (worker.js does the playing).
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function createPool({ threads, mapPath, hunterBrain = 'param', survivorBrain = 'param', metrics = [] }) {
  const workers = [], idle = [], queue = [], pending = new Map();
  let nextId = 0;
  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const { id, jobs, done } = queue.shift();
      pending.set(id, done);
      w.postMessage({ id, jobs });
    }
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(join(here, 'worker.js'), { workerData: { mapPath, hunterBrain, survivorBrain, metrics } });
    w.on('message', ({ id, results }) => { pending.get(id)(results); pending.delete(id); idle.push(w); pump(); });
    w.on('error', (e) => { console.error(e); process.exit(1); });
    workers.push(w); idle.push(w);
  }
  return {
    // jobs: [{ seed, hunterParams, survivorParams, ...extra }] -> results in the same order (extra fields echoed back)
    run(jobs) {
      const chunk = Math.max(1, Math.ceil(jobs.length / (threads * 3)));
      const parts = [];
      for (let i = 0; i < jobs.length; i += chunk) {
        const slice = jobs.slice(i, i + chunk);
        parts.push(new Promise((done) => { queue.push({ id: nextId++, jobs: slice, done }); }).then((res) => res.map((r, k) => ({ ...slice[k].tag, ...r }))));
      }
      pump();
      return Promise.all(parts).then((r) => r.flat());
    },
    close() { for (const w of workers) w.terminate(); },
  };
}
