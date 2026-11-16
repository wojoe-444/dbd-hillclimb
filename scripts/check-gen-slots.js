#!/usr/bin/env node
// Generator side-slot check: every generator candidate must have >= 1 usable side (walkable N/E/S/W neighbour cell;
// see src/sim/README.md "Generators"). Prints a warning list of gens with only 1-2 usable sides.
//   node scripts/check-gen-slots.js [maps/gas-heaven.json maps/gas-heaven/v000.json ...]   (default: all maps)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMap } from '../src/sim/mapdata.js';
import { genSlots } from '../src/sim/match.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export function slotReport(files) {
  const rows = [];
  for (const f of files) {
    const md = prepareMap(JSON.parse(fs.readFileSync(f, 'utf8')));
    for (const g of md.genCands) rows.push({ file: path.relative(root, f), id: g.id, x: g.x, z: g.z, sides: genSlots(md, g).map(s => s.side) });
  }
  return rows;
}
export function allMapFiles() {
  const dir = path.join(root, 'maps/gas-heaven');
  return [path.join(root, 'maps/gas-heaven.json'), path.join(root, 'maps/test-small.json'),
    ...fs.readdirSync(dir).filter(f => /^v\d+\.json$/.test(f)).sort().map(f => path.join(dir, f))].filter(f => fs.existsSync(f));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(f => path.resolve(f)) : allMapFiles();
  const rows = slotReport(files);
  const zero = rows.filter(r => r.sides.length === 0), few = rows.filter(r => r.sides.length > 0 && r.sides.length <= 2);
  const hist = [0, 0, 0, 0, 0]; for (const r of rows) hist[r.sides.length]++;
  console.log(`${files.length} maps, ${rows.length} generator candidates; usable sides histogram 0..4: ${hist.join(' ')}`);
  for (const r of few) console.log(`WARN ${r.file} ${r.id} (${r.x},${r.z}): only ${r.sides.length} usable side(s) ${r.sides.join('')}`);
  for (const r of zero) console.log(`ERROR ${r.file} ${r.id} (${r.x},${r.z}): no usable side`);
  if (zero.length) process.exit(1);
}
