// Detect dithering: an agent whose facing flips by more than ~143 deg on consecutive ticks while moving (alternating
// between two goals each tick) — the "camera spinning back and forth" look. Reports counts per role and the first
// few streaks with time, position and the brain's action, so the culprit branch can be found.
//
// Usage: node scripts/diag-dither.js [--n 12] [--map maps/gas-heaven] [--champ runs/<run>/champions.json] [--streak 3] [--hp knob=v,...]
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
if (a.hp) for (const p of a.hp.split(',')) { const [k, v] = p.split('='); hp[k] = +v; }   // hunter knob overrides, e.g. --hp holdVaultP=0
const n = +(a.n ?? 12), minStreak = +(a.streak ?? 3);
const FLIP = 2.5; // rad

const stat = { hunter: { ticks: 0, flips: 0, streaks: 0 }, survivor: { ticks: 0, flips: 0, streaks: 0 } };
const examples = [];
for (let i = 0; i < n; i++) {
  const seed = 9000 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const agents = [m.hunter, ...m.survivors];
  const prev = agents.map((x) => x.face), streak = agents.map(() => 0);
  while (!m.over) {
    m.step();
    agents.forEach((ag, k) => {
      const role = k === 0 ? 'hunter' : 'survivor';
      if (k > 0 && ag.st > 1) { streak[k] = 0; prev[k] = ag.face; return; }   // only standing survivors
      stat[role].ticks++;
      let d = Math.abs(ag.face - prev[k]); if (d > Math.PI) d = 2 * Math.PI - d; prev[k] = ag.face;
      const moving = Math.hypot(ag.vx, ag.vz) > 0.5;
      if (d > FLIP && moving) {
        stat[role].flips++; streak[k]++;
        if (streak[k] === minStreak) {
          stat[role].streaks++;
          if (examples.length < 6) examples.push({ role, id: ag.id, seed, t: +m.t.toFixed(1), x: +ag.x.toFixed(1), z: +ag.z.toFixed(1), action: JSON.stringify(ag.lastAction || {}).slice(0, 140) });
        }
      } else streak[k] = 0;
    });
  }
}
for (const [role, s] of Object.entries(stat)) console.log(`${role.padEnd(8)} flips ${s.flips} / ${s.ticks} ticks (${(100 * s.flips / Math.max(1, s.ticks)).toFixed(2)}%), dither streaks (>=${minStreak} consecutive flips): ${s.streaks}`);
if (examples.length) { console.log('examples:'); for (const e of examples) console.log(' ', JSON.stringify(e)); }
