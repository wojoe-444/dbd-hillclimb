#!/usr/bin/env node
// Goal-layer diagnostics for the 'goal' survivor (survivor-goal.js): time share per goal, entries, top transitions,
// switch rate, and dithering = a goal switch that returns to the previous goal within 1 s (A -> B -> A).
//   node scripts/diag-goal.js [--n 8] [--champ runs/x/champions.json] [--map maps/gas-heaven]
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { GOALS } from '../src/brains/survivor-goal.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains('param', 'goal');
const hp = defaults(B.hunter.space);
let sp = defaults(B.survivor.space);
if (a.champ) sp = clampParams(B.survivor.space, { ...sp, ...JSON.parse(readFileSync(a.champ, 'utf8')).champ.survivor });
const n = +(a.n ?? 8);
const ticks = new Float64Array(GOALS.length), enters = new Float64Array(GOALS.length), trans = {};
const flipPairs = {};
let switches = 0, aliveS = 0, flipBacks = 0, fallbacks = 0, kills = 0, esc = 0, gens = 0;
for (let i = 0; i < n; i++) {
  const seed = 7000 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const hist = m.survivors.map(() => []);   // [t, goal] on each change
  while (!m.over) {
    m.step();
    m.survivors.forEach((s, k) => {
      if (s.st >= 5) return;
      aliveS += 0.1;
      const g = s.brain.goal, H = hist[k];
      if (g && (!H.length || H[H.length - 1][1] !== g)) {
        H.push([m.t, g]);
        if (H.length >= 3 && H[H.length - 3][1] === g && m.t - H[H.length - 2][0] <= 1.0) { flipBacks++; const key = `${g}>${H[H.length - 2][1]}>${g}`; flipPairs[key] = (flipPairs[key] || 0) + 1; }
      }
    });
  }
  const r = m.result(); kills += r.kills; esc += r.escapes; gens += r.gensDone;
  for (const s of m.survivors) {
    const gs = s.brain.goalStats;
    for (let g = 0; g < GOALS.length; g++) { ticks[g] += gs.ticks[g]; enters[g] += gs.enters[g]; }
    switches += gs.switches; fallbacks += gs.fallbacks;
    for (const [k, v] of Object.entries(gs.trans)) trans[k] = (trans[k] || 0) + v;
  }
}
const tot = ticks.reduce((x, y) => x + y, 0);
console.log(`${n} matches: kills ${(kills / n).toFixed(2)} esc ${(esc / n).toFixed(2)} gens ${(gens / n).toFixed(2)}`);
console.log('goal        share   entries/match');
GOALS.forEach((g, i) => console.log(`${g.padEnd(10)} ${(100 * ticks[i] / tot).toFixed(1).padStart(5)}%  ${(enters[i] / n).toFixed(1).padStart(6)}`));
console.log(`switches ${(switches / (aliveS / 60)).toFixed(2)}/survivor-min, flip-backs (A>B>A within 1 s) ${flipBacks} = ${(flipBacks / (aliveS / 60)).toFixed(3)}/survivor-min, fallbacks/decision ${(fallbacks / Math.max(1, tot)).toFixed(3)}`);
console.log('top transitions: ' + Object.entries(trans).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k} ${(v / n).toFixed(1)}`).join(', '));
console.log('flip-backs by pair: ' + Object.entries(flipPairs).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', '));
