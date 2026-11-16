// Early-match idleness: share of survivor ticks in the first N seconds where a standing survivor has no interaction
// and speed < 0.2 m/s, with a breakdown: deliberate (no moveTo, or a moveTo target < 1 m away = arrived / holding at a
// loop entry), blocked by a teammate (target >= 1 m away and a teammate within 1.2 m; split: target is a teammate's
// position / a gen side slot / other), other stuck.
//
// Usage: node scripts/diag-idle.js [--n 16] [--s 30] [--map maps/gas-heaven] [--champ runs/<run>/champions.json]
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
const n = +(a.n ?? 16), S = +(a.s ?? 30);
const c = { ticks: 0, idle: 0, onMate: 0, onSlot: 0, nearMate: 0, other: 0, noMove: 0, hold: 0 };
for (let i = 0; i < n; i++) {
  const seed = 1000 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const slots = m.gens.flatMap((g) => g.slots.map((s) => ({ x: s.x, z: s.z })));
  while (!m.over && m.t < S) {
    m.step();
    for (const s of m.survivors) {
      if (s.st > 1) continue;
      c.ticks++;
      const act = s.lastAction || {};
      if (act.act || Math.hypot(s.vx, s.vz) >= 0.2) continue;
      c.idle++;
      const mt = act.moveTo;
      if (!mt) { c.noMove++; continue; }
      if (Math.hypot(mt.x - s.x, mt.z - s.z) < 1) { c.hold++; continue; }
      const mates = m.survivors.filter((o) => o !== s && o.st <= 1);
      if (!mates.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 1.2)) { c.other++; continue; }
      if (mates.some((o) => Math.hypot(o.x - mt.x, o.z - mt.z) < 0.3)) c.onMate++;
      else if (slots.some((q) => Math.hypot(q.x - mt.x, q.z - mt.z) < 0.05)) c.onSlot++;
      else c.nearMate++;
    }
  }
}
const pc = (v) => (100 * v / Math.max(1, c.ticks)).toFixed(1) + '%';
console.log(`first ${S} s, ${n} matches: idle ${pc(c.idle)} of standing-survivor ticks`);
console.log(`  deliberate: stand ${pc(c.noMove)}, arrived / holding (target < 1 m) ${pc(c.hold)}`);
console.log(`  blocked by a teammate: ${pc(c.onMate + c.onSlot + c.nearMate)} (target = a teammate's position ${pc(c.onMate)}, a gen side slot ${pc(c.onSlot)}, other ${pc(c.nearMate)})`);
console.log(`  other stuck (no teammate near) ${pc(c.other)}`);
