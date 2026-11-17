// Killer-profile experiment: survivors with profile adaptation off vs on against hunters with extreme habits.
// Paired seeds (same map / seed per hunter variant in every survivor arm). Worker threads.
//
// node scripts/exp-killer-profile.js [--n 32] [--threads 12] [--variants respect,runner,...] [--arms off,on]
//   [--map maps/gas-heaven] [--adapt 1]  (on = every *Adapt knob at --adapt; arms "pallet", "camp", ... = one knob only)
//
// Per cell: kills, escapes, gens, hooks, hook stages consumed, survivor time out, hunter stuns, pallets dropped, hits,
// hits within 2.5 m of a pallet, and what the survivors learned (mean end-of-match estimate + observations per survivor).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const VARIANTS = {
  default:   {},
  respect:   { palletRespectM: 4, palletRespectS: 8 },
  runner:    { palletRespectM: 0 },
  camper:    { campS: 45, campRadius: 6, postHookGenW: 0, postHookRoamW: 0, followScratch: 0, noiseFollow: 0 },   // leads (scratches) would pull it off the hook
  leaver:    { campS: 0 },
  tunnel1:   { tunnel: 1 },
  tunnel0:   { tunnel: 0 },
  campTun1:  { tunnel: 1, campS: 20, campRadius: 8, postHookGenW: 0, postHookRoamW: 0 },   // tunnelling needs the hunter near the hook
  campTun0:  { tunnel: 0, campS: 20, campRadius: 8, postHookGenW: 0, postHookRoamW: 0 },
  mind:      { reverseChance: 0.7, standOffChance: 0.6, standOffMaxS: 2 },
  slugger:   { slugDist: 20 },
  quitter:   { chaseAbandonS: 8 },
  committed: { chaseAbandonS: 90 },
};
const KNOBS = ['palletRespectAdapt', 'chaseAbandonAdapt', 'reverseAdapt', 'tunnelAdapt', 'campAdapt', 'slugAdapt'];
const ARM_KNOB = { pallet: 'palletRespectAdapt', abandon: 'chaseAbandonAdapt', reverse: 'reverseAdapt', tunnel: 'tunnelAdapt', camp: 'campAdapt', slug: 'slugAdapt' };
const TRAITS = ['respect', 'mind', 'follow', 'abandon', 'tunnel', 'camp', 'slug'];

if (isMainThread) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const n = +(a.n ?? 32), threads = +(a.threads ?? Math.max(1, cpus().length - 2));
  const variants = (a.variants ?? 'respect,runner,camper,leaver,tunnel1,tunnel0,mind,quitter,committed').split(',');
  const arms = (a.arms ?? 'off,on').split(',');
  const adapt = +(a.adapt ?? 1);
  const jobs = [];
  for (const v of variants) for (const arm of arms) for (let i = 0; i < n; i++) jobs.push({ v, arm, i });
  const out = new Map();
  let next = 0, done = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    const W = Math.min(threads, jobs.length);
    let alive = W;
    for (let w = 0; w < W; w++) {
      const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { map: a.map ?? 'maps/gas-heaven', adapt } });
      const feed = () => { if (next < jobs.length) wk.postMessage(jobs[next++]); else { wk.postMessage(null); } };
      wk.on('message', (r) => {
        const k = r.v + '|' + r.arm; if (!out.has(k)) out.set(k, []); out.get(k).push(r);
        if (++done % 20 === 0) process.stderr.write(`${done}/${jobs.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
        feed();
      });
      wk.on('exit', () => { if (--alive === 0) resolve(); });
      wk.on('error', (e) => { console.error(e); });
      feed();
    }
  });
  const M = (rs, f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  const se = (rs, f) => { const m = M(rs, f); return Math.sqrt(rs.reduce((s, r) => s + (f(r) - m) ** 2, 0) / Math.max(1, rs.length - 1) / rs.length); };
  const cols = [['kills', (r) => r.kills], ['esc', (r) => r.escapes], ['gens', (r) => r.gens], ['hooks', (r) => r.hooks], ['stages', (r) => r.stages],
    ['tOut', (r) => r.tOut], ['stuns', (r) => r.stuns], ['drops', (r) => r.drops], ['hits', (r) => r.hits], ['hitPal', (r) => r.hitPal]];
  console.log(`${jobs.length} matches in ${((Date.now() - t0) / 1000).toFixed(0)}s (n=${n} per cell, adapt=${adapt})`);
  console.log('variant    arm      ' + cols.map(([c]) => c.padStart(7)).join('') + '   learned p (obs/survivor)');
  for (const v of variants) {
    for (const arm of arms) {
      const rs = out.get(v + '|' + arm) || [];
      if (!rs.length) continue;
      const learned = TRAITS.map((k) => `${k} ${M(rs, (r) => r.est[k].p).toFixed(2)}(${M(rs, (r) => r.est[k].conf).toFixed(1)})`).join(' ');
      console.log(v.padEnd(11) + arm.padEnd(9) + cols.map(([, f]) => M(rs, f).toFixed(2).padStart(7)).join('') + '   ' + learned);
    }
    // paired difference on vs off (same seeds)
    const off = out.get(v + '|off');
    if (off) for (const arm of arms) {
      if (arm === 'off') continue;
      const on = out.get(v + '|' + arm); if (!on) continue;
      const pairs = on.map((r) => [r, off.find((x) => x.i === r.i)]).filter((p) => p[1]);
      const d = (f) => pairs.map(([x, y]) => ({ v: f(x) - f(y) }));
      console.log(''.padEnd(11) + ('d ' + arm).padEnd(9) + cols.map(([, f]) => { const dd = d(f); return (M(dd, (x) => x.v) >= 0 ? '+' : '') + M(dd, (x) => x.v).toFixed(2); }).map((s) => s.padStart(7)).join('') +
        '   (+-1se: ' + cols.map(([c, f]) => `${c} ${se(d(f), (x) => x.v).toFixed(2)}`).join(' ') + ')');
    }
  }
} else {
  const { loadMapPool } = await import('../src/hillclimb/maps.js');
  const { createMatch } = await import('../src/sim/index.js');
  const { getBrains } = await import('../src/brains/index.js');
  const { defaults } = await import('../src/hillclimb/params.js');
  const maps = loadMapPool(workerData.map);
  const B = getBrains();
  parentPort.on('message', (job) => {
    if (!job) { process.exit(0); }
    const { v, arm, i } = job;
    const hp = { ...defaults(B.hunter.space), ...VARIANTS[v] };
    const sp = defaults(B.survivor.space);
    if (arm === 'on') for (const k of KNOBS) sp[k] = workerData.adapt;
    else if (ARM_KNOB[arm]) sp[ARM_KNOB[arm]] = workerData.adapt;
    const sf = B.survivor.make(sp), brains = [];
    let cmap = null;
    const seed = 1000 + i;
    const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: (c) => { cmap = c.map; const b = sf(c); brains.push(b); return b; } });
    let ne = 0, hitPal = 0;
    while (!m.over) {
      m.step();
      for (; ne < m.events.length; ne++) {
        const e = m.events[ne];
        if (e.type !== 'hit') continue;
        const s = m.survivors[e.who];
        if (cmap.pallets.some((p) => Math.hypot(Math.max(p.x0 - s.x, 0, s.x - p.x1), Math.max(p.z0 - s.z, 0, s.z - p.z1)) <= 2.5)) hitPal++;
      }
    }
    const r = m.result();
    const est = {};
    for (const k of TRAITS) est[k] = { p: 0, conf: 0 };
    for (const b of brains) { const e = b.profile.est(); for (const k of TRAITS) { est[k].p += e[k].p / brains.length; est[k].conf += e[k].conf / brains.length; } }
    parentPort.postMessage({ v, arm, i, kills: r.kills, escapes: r.escapes, gens: r.gensDone, hooks: r.hooks,
      stages: r.survivors.reduce((s, x) => s + x.hookStages, 0), tOut: r.survivors.reduce((s, x) => s + (x.tOut ?? r.durationS), 0) / 4,
      stuns: r.stats.stuns, drops: r.stats.palletsDropped, hits: r.stats.hits, hitPal, est });
  });
}
