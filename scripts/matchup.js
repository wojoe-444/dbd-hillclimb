// Quick single-thread matchup: node scripts/matchup.js [--hunter param] [--survivor param] [--n 50]
//   [--map maps/gas-heaven]  (default: the tile variant pool evolution uses; maps/gas-heaven.json = old hand-made map) [--champ runs/x/champions.json]
//   [--mod genSeconds=80]    (game modifiers, src/sim/modifiers.js; repeatable or a comma list)
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { runMatch, modsFromArgv, modsConfig, modsOf, modsKey, describeMods } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains(a.hunter ?? 'param', a.survivor ?? 'param');
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
const mods = modsFromArgv(argv);
const config = modsConfig(mods);
if (Object.keys(mods).length) console.log(`GAME MODIFIERS: ${describeMods(mods)} (non-standard rules)`);
if (a.champ) {
  const cj = JSON.parse(readFileSync(a.champ, 'utf8'));
  ({ hunter: hp, survivor: sp } = cj.champ);
  if (modsKey(modsOf(cj)) !== modsKey(mods)) console.warn(`WARNING: ${a.champ} was trained under ${describeMods(modsOf(cj)) || 'standard'} but is played here under ${describeMods(mods) || 'standard'}`);
}
const n = +(a.n ?? 50);
const t0 = Date.now();
const tot = { kills: 0, escapes: 0, gensDone: 0, hooks: 0, dur: 0 };
const stats = {};
for (let i = 0; i < n; i++) {
  const r = runMatch({ map: maps[(1000 + i) % maps.length], seed: 1000 + i, config, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  tot.kills += r.kills; tot.escapes += r.escapes; tot.gensDone += r.gensDone; tot.hooks += r.hooks; tot.dur += r.durationS;
  for (const [k, v] of Object.entries(r.stats)) stats[k] = (stats[k] ?? 0) + v;
}
const f = (v) => (v / n).toFixed(2);
console.log(`${n} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`kills ${f(tot.kills)}  escapes ${f(tot.escapes)}  gens ${f(tot.gensDone)}  hooks ${f(tot.hooks)}  dur ${f(tot.dur)}s`);
console.log(Object.entries(stats).map(([k, v]) => `${k} ${f(v)}`).join('  '));
