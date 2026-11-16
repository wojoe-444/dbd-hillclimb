// A/B: survivor camera vision (config survivor.camera.enabled) on vs off, same seeds and knobs. Reports outcomes,
// peeking (holding out of the hunter's line of sight while the camera watches it; share of survivor decisions, peek
// episodes per match, peeks followed by a chase on that survivor within 5 s = "found"), and wall time.
//
// Usage: node scripts/ab-camera.js [--n 48] [--map maps/gas-heaven] [--champ runs/<run>/champions.json] [--set '{...}']
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { runMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
sp = { ...defaults(B.survivor.space), ...sp, ...(a.set ? JSON.parse(a.set) : {}) };
const n = +(a.n ?? 48);

function run(camera, label) {
  const tot = { kills: 0, escapes: 0, gens: 0, hooks: 0, dur: 0, decides: 0, peekTicks: 0, peeks: 0, peekFound: 0, chases: 0, rescues: 0, heals: 0 };
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i, brains = [];
    const mk = B.survivor.make(sp);
    const r = runMatch({ map: maps[seed % maps.length], seed, config: { survivor: { camera: { enabled: camera } } }, hunter: B.hunter.make(hp), survivors: (ctx) => { const b = mk(ctx); brains.push(b); return b; } });
    tot.kills += r.kills; tot.escapes += r.escapes; tot.gens += r.gensDone; tot.hooks += r.hooks; tot.dur += r.durationS;
    tot.rescues += r.stats.rescues || 0; tot.heals += r.stats.heals || 0;
    for (const b of brains) if (b.stats) for (const k of ['decides', 'peekTicks', 'peeks', 'peekFound', 'chases']) tot[k] += b.stats[k] || 0;
  }
  const ms = performance.now() - t0, f = (v) => (v / n).toFixed(2);
  console.log(`${label.padEnd(10)} kills ${f(tot.kills)}  escapes ${f(tot.escapes)}  gens ${f(tot.gens)}  hooks ${f(tot.hooks)}  rescues ${f(tot.rescues)}  heals ${f(tot.heals)}  dur ${f(tot.dur)}s  | ` +
    `peeking ${(100 * tot.peekTicks / Math.max(1, tot.decides)).toFixed(1)}% of decisions, ${f(tot.peeks)} peeks/match, found ${tot.peekFound}/${tot.peeks} (${(100 * tot.peekFound / Math.max(1, tot.peeks)).toFixed(0)}%)  | ` +
    `${(ms / n).toFixed(0)} ms/match, ${(ms / tot.dur).toFixed(3)} ms/game-s`);
}
run(true, 'camera on');
run(false, 'camera off');
