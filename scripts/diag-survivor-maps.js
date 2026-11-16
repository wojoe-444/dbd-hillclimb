// Static geometry of the exact match seeds used by survivor-weakness.md. Does not advance a match.
// node scripts/diag-survivor-maps.js [maps/gas-heaven] [64]
import { loadMapPool } from '../src/hillclimb/maps.js';
import { createMatch } from '../src/sim/index.js';
const dummy = () => ({ decide: () => ({}) });
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const path = process.argv[2] ?? 'maps/gas-heaven', n = +(process.argv[3] ?? 64);
const maps = loadMapPool(path), rows = [];
for (let seed = 1000; seed < 1000 + n; seed++) {
  const map = maps[seed % maps.length];
  const m = createMatch({ map, seed, hunter: dummy, survivors: dummy });
  const gs = m.gens, d = (x, y) => m.hunter.nav.dist(x.slots[0], y.slots[0]);
  const pairs = gs.flatMap((g, i) => gs.slice(i + 1).map(h => d(g, h)));
  let tour = Infinity;
  for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) for (let k = j + 1; k < gs.length; k++) {
    tour = Math.min(tour, d(gs[i], gs[j]) + d(gs[j], gs[k]) + d(gs[k], gs[i]));
  }
  let area = 0;
  for (let i = 0, j = map.outline.length - 1; i < map.outline.length; j = i++) area += map.outline[j][0] * map.outline[i][1] - map.outline[i][0] * map.outline[j][1];
  rows.push({ minPair: Math.min(...pairs), pairMean: mean(pairs), threeTour: tour, pallets: m.md.pallets.length,
    windows: m.md.windows.length, area: Math.abs(area / 2), slots: mean(gs.map(g => g.slots.length)) });
}
console.log(JSON.stringify({ path, n, summary: Object.fromEntries(Object.keys(rows[0]).map(k => [k, {
  mean: mean(rows.map(r => r[k])), min: Math.min(...rows.map(r => r[k])), max: Math.max(...rows.map(r => r[k])) }])), rows }, null, 2));
