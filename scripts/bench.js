#!/usr/bin/env node
// Throughput benchmark: runs N matches with the baseline brains and prints win stats + matches/second.
//
//   node scripts/bench.js [--n 200] [--map maps/gas-heaven.json] [--seed 1] [--warmup 10]
//                         [--decide-every 1] [--perception-every 2] [--config '{"gens":{"repairS":60}}'] [--mod genSeconds=80]
//
// The first `--warmup` matches (different seeds) fill the shared navigation caches and are not timed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMatch, modsFromArgv, withMods } from '../src/sim/index.js';
import { survivorBrain, hunterBrain } from '../src/sim/testbrains.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const n = +opt('n', 200), seed0 = +opt('seed', 1), warm = +opt('warmup', 10);
const mapPath = opt('map', fs.existsSync(path.join(root, 'maps/gas-heaven.json')) ? 'maps/gas-heaven.json' : 'maps/test-small.json');
const map = JSON.parse(fs.readFileSync(path.resolve(root, mapPath), 'utf8'));
let config = opt('config', null) ? JSON.parse(opt('config')) : {};
config = withMods(config, modsFromArgv(args));   // game modifiers (src/sim/modifiers.js) win over --config
if (opt('decide-every', null)) config = { ...config, decisionEvery: +opt('decide-every') };
if (opt('perception-every', null)) config = { ...config, sight: { ...(config.sight || {}), perceptionEvery: +opt('perception-every') } };

const run = seed => runMatch({ map, seed, config, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] });
for (let i = 0; i < warm; i++) run(1000000 + i);

let ticks = 0, kills = 0, escapes = 0, timeouts = 0, gens = 0, hooks = 0, dur = 0;
const winners = { hunter: 0, survivors: 0, draw: 0 };
const killsHist = [0, 0, 0, 0, 0];
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const r = run(seed0 + i);
  ticks += r.ticks; kills += r.kills; escapes += r.escapes; timeouts += r.timeouts; gens += r.gensDone; hooks += r.hooks; dur += r.durationS;
  winners[r.winner]++; killsHist[r.kills]++;
}
const sec = (performance.now() - t0) / 1000;

console.log(`map ${map.id} (${map.size.w}x${map.size.h}), ${n} matches (+${warm} warmup), config ${JSON.stringify(config)}`);
console.log(`winners: hunter ${winners.hunter}  survivors ${winners.survivors}  draw ${winners.draw}`);
console.log(`avg per match: ${(kills / n).toFixed(2)} kills, ${(escapes / n).toFixed(2)} escapes, ${(timeouts / n).toFixed(2)} timeouts, ${(gens / n).toFixed(2)} gens, ${(hooks / n).toFixed(2)} hooks, ${(dur / n).toFixed(0)} s game time (${(ticks / n) | 0} ticks)`);
console.log(`kill histogram (0..4): ${killsHist.join(' ')}`);
console.log(`time ${sec.toFixed(2)} s  ->  ${(n / sec).toFixed(1)} matches/s,  ${((ticks / sec) / 1000).toFixed(0)}k ticks/s  (${(sec * 1e6 / ticks).toFixed(1)} us/tick)`);
