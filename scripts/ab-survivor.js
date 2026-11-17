// Paired survivor A/B on common seeds (default hunter), parallel over worker threads. Arm A = --base (a checkout dir
// whose src/brains is loaded, default this repo) with --setA overrides; arm B = this repo with --setB overrides.
// Per arm: kills, escapes, gens, duration, hooks, hook stages consumed (sum over survivors at the end, deaths included:
// the hook-stage burden), repair worker-seconds and charges, rescues, heals, endgame (gates powered) share and
// escapes per powered match; paired B - A deltas with ~95% normal intervals.
//
// Usage: node scripts/ab-survivor.js [--n 64] [--map maps/gas-heaven] [--seed 1000] [--needed 5] [--base <dir>]
//        [--setA k=v,...] [--setB k=v,...] [--threads 12]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repo = resolve(here, '../..');

if (isMainThread) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const n = +(a.n ?? 64), seed0 = +(a.seed ?? 1000), threads = Math.min(n, +(a.threads ?? Math.max(1, availableParallelism() - 2)));
  const arms = [{ dir: resolve(a.base ?? repo), set: a.setA ?? '' }, { dir: repo, set: a.setB ?? '' }];
  const jobs = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) jobs.push({ i, k });
  const out = [[], []];
  let next = 0, done = 0;
  const t0 = Date.now();
  await new Promise((res, rej) => {
    for (let w = 0; w < threads; w++) {
      const wk = new Worker(here, { workerData: { arms, map: a.map ?? 'maps/gas-heaven', needed: +(a.needed ?? 5), seed0 } });
      const feed = () => { if (next < jobs.length) wk.postMessage(jobs[next++]); else wk.terminate(); };
      wk.on('message', (r) => { out[r.k][r.i] = r; if (++done === jobs.length) res(); else feed(); });
      wk.on('error', rej);
      feed();
    }
  });
  const keys = ['kills', 'escapes', 'gens', 'dur', 'hooks', 'hookStages', 'hookDeaths', 'repairS', 'repairC', 'rescues', 'heals', 'powered', 'escPowered'];
  const mean = (v) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
  console.log(`ab-survivor: ${n} paired matches, map ${a.map ?? 'maps/gas-heaven'}, gens.needed ${a.needed ?? 5}${(+(a.needed ?? 5)) < 5 ? ' (SHORT-GEN DIAGNOSTIC)' : ''}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`A: ${arms[0].dir === repo ? 'this repo' : arms[0].dir} ${arms[0].set}   B: this repo ${arms[1].set}`);
  console.log('metric'.padEnd(12) + 'A'.padStart(10) + 'B'.padStart(10) + '   B-A [95%]');
  for (const k of keys) {
    const A = out[0].map((r) => r[k]), Bv = out[1].map((r) => r[k]);
    const d = A.map((x, i) => Bv[i] - x), md = mean(d), sd = Math.sqrt(mean(d.map((x) => (x - md) ** 2)) * n / Math.max(1, n - 1)), h = 1.96 * sd / Math.sqrt(n);
    console.log(k.padEnd(12) + mean(A).toFixed(3).padStart(10) + mean(Bv).toFixed(3).padStart(10) + `   ${md >= 0 ? '+' : ''}${md.toFixed(3)} [${(md - h).toFixed(3)}, ${(md + h).toFixed(3)}]`);
  }
  const pA = out[0].reduce((s, r) => s + r.powered, 0), pB = out[1].reduce((s, r) => s + r.powered, 0);
  const eA = out[0].reduce((s, r) => s + r.escPowered, 0), eB = out[1].reduce((s, r) => s + r.escPowered, 0);
  console.log(`escapes per powered match: A ${(eA / Math.max(1, pA)).toFixed(3)} (${pA})   B ${(eB / Math.max(1, pB)).toFixed(3)} (${pB})`);
} else {
  const { arms, map, needed, seed0 } = workerData;
  const { loadMapPool } = await import(pathToFileURL(resolve(repo, 'src/hillclimb/maps.js')).href);
  const maps = loadMapPool(resolve(repo, map));
  const loaded = [];
  for (const arm of arms) {
    const sim = await import(pathToFileURL(resolve(arm.dir, 'src/sim/index.js')).href);
    const { getBrains } = await import(pathToFileURL(resolve(arm.dir, 'src/brains/index.js')).href);
    const { defaults } = await import(pathToFileURL(resolve(arm.dir, 'src/hillclimb/params.js')).href);
    const B = getBrains();
    const sp = defaults(B.survivor.space), hp = defaults(B.hunter.space);
    for (const kv of arm.set.split(',').filter(Boolean)) { const [k, v] = kv.split('='); if (!(k in B.survivor.space)) throw new Error('unknown survivor knob ' + k); sp[k] = +v; }
    loaded.push({ sim, B, sp, hp });
  }
  parentPort.on('message', ({ i, k }) => {
    const { sim, B, sp, hp } = loaded[k], seed = seed0 + i;
    const m = sim.createMatch({ map: maps[seed % maps.length], seed, config: { gens: { needed } }, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
    let powered = 0;
    while (!m.over) { m.step(); if (m.gatesPowered) powered = 1; }
    const r = m.result();
    const sum = (f) => r.survivors.reduce((s, x) => s + f(x), 0);
    parentPort.postMessage({
      i, k, kills: r.kills, escapes: r.escapes, gens: r.gensDone, dur: r.durationS, hooks: r.hooks,
      hookStages: sum((x) => x.hookStages), hookDeaths: sum((x) => (x.cause === 'hookDeath' ? 1 : 0)), repairS: sum((x) => x.repairS), repairC: sum((x) => x.repairC),
      rescues: r.stats.rescues, heals: r.stats.heals, powered, escPowered: powered ? r.escapes : 0,
    });
  });
}
