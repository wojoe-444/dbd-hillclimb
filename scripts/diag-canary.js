// Canary: chase time survivors spend on the infinite-loop probe tile (src/diag/canary.js).
// node scripts/diag-canary.js [--n 64] [--map maps/gas-heaven] [--seed0 1000] [--champ runs/x/champions.json]
//   [--sp knob=v,knob=v] [--hp knob=v,...] [--src <dir with sim/ + brains/ + hillclimb/>] [--json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeCanary, mergeCanary } from '../src/diag/canary.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[argv[i].slice(2)] = true; else { a[argv[i].slice(2)] = v; i++; } }
const src = resolve(a.src ?? 'src');
const imp = (p) => import(pathToFileURL(resolve(src, p)).href);
const { createMatch } = await imp('sim/index.js');
const { getBrains } = await imp('brains/index.js');
const { defaults } = await imp('hillclimb/params.js');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...hp, ...c.hunter }; sp = { ...sp, ...c.survivor }; }
const kv = (s, o) => { if (typeof s === 'string') for (const p of s.split(',')) { const [k, v] = p.split('='); o[k] = +v; } };
kv(a.sp, sp); kv(a.hp, hp);
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const n = +(a.n ?? 64), seed0 = +(a.seed0 ?? 1000);
const res = []; let kills = 0, esc = 0, dur = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const seed = seed0 + i, map = maps[seed % maps.length];
  const m = createMatch({ map, seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const can = makeCanary(m, map);
  while (!m.over) { m.step(); can.step(); }
  res.push(can.result());
  const r = m.result(); kills += r.kills; esc += r.escapes; dur += r.durationS;
}
const t = mergeCanary(res), f = (x, d = 1) => x.toFixed(d);
if (a.json) console.log(JSON.stringify(t));
console.log(`${n} matches (${t.matchesPresent} with the probe tile) in ${((Date.now() - t0) / 1000).toFixed(1)}s   kills ${f(kills / n, 2)} esc ${f(esc / n, 2)} dur ${f(dur / n)}s`);
console.log(`chase s/match ${f(t.chaseS / n)}  on probe tile ${f(t.tileChaseS / n)} (${f(100 * t.tileShare)}%)  tile window vaults/match ${f(t.tileVaults / n, 2)}  laps/match ${f(t.laps / n, 2)}`);
console.log(`chases/match ${f(t.chases / n, 2)}  that used the tile ${f(t.tileChases / n, 2)}  mean chase there ${f(t.meanTileChaseS)}s vs elsewhere ${f(t.meanOtherChaseS)}s  downs ending tile chases ${t.tileDowns}/${t.tileChases}, other ${t.otherDowns}/${t.chases - t.tileChases}`);
