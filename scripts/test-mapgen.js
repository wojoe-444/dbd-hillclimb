#!/usr/bin/env node
// Geometry regressions, including the owner's protected templates and shipped pool.
// node scripts/test-mapgen.js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TILES, TILE_LIST, SOLID_CHARS as TILES_SOLIDS, resolveTile, makeRng, composeFeatures, gasHeavenLayout, outlineInset } from '../src/mapgen/index.js';
import { analyzeMap } from './validate-map.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedRows = {
  'tl-wall': '49a5348f1f192a5aae65171d983343bd88fcf36b1b33d1da8cd6e3515ce86721',
  shack: 'f7147c3f477fe53c0fe569272e6e0fa348998125d59a78a787f8a0a7e1ff5840',
  jgv1: 'e6cf15b673a5849fbc93928e1871a54d9a368079cf752d0581cb3722d8921a76',
  jgv2: '221a93fca3f2a33eefa565e33b98f0fe3ea3dbe34848be897b354f6faa7bbbfe',
  'infinite-loop': '2e386f6ccbd6f4ca211be2fbb78e706c0ef6828550c161035b0d558b7daf92a2',
};
for (const [id, expected] of Object.entries(protectedRows)) assert.equal(hash(TILES[id].rows), expected, `${id}: owner-protected geometry`);
assert.deepEqual(gasHeavenLayout.overlays, [], 'MID overlays retired (user 2026-11-16)');

const gyms = { 'pallet-gym': [1, 0], 'four-lane-open': [1, 1], 'four-lane-closed': [1, 1], 'variant-gym': [1, 1] };
let transforms = 0;
for (const tile of TILE_LIST) {
  assert.equal(tile.rows.length, tile.size, `${tile.id}: height`);
  for (const row of tile.rows) assert.equal(row.length, tile.size, `${tile.id}: width`);
  for (const mode of ['all', 'none', 'roll']) for (let rot = 0; rot < 4; rot++) for (const mirror of [false, true]) {
    const r = resolveTile(tile, makeRng(17), { mode, rot, mirror });
    const n = tile.size;
    assert(r.rows.every((row, z) => [...row].every((c, x) => (x && z && x < n - 1 && z < n - 1) || c === '.')), `${tile.id}: connected border`);
    const { windows, pallets } = composeFeatures(r.rows.flatMap(row => [...row]), n, n);
    const at = (x, z) => r.rows[z]?.[x];
    for (const f of [...windows, ...pallets]) {
      const len = f.length ?? 1;
      const [dx, dz] = f.axis === 'x' ? [0, 1] : [1, 0];
      assert(at(f.x - dx, f.z - dz) in TILES_SOLIDS && at(f.x + dx * len, f.z + dz * len) in TILES_SOLIDS, `${tile.id}: feature has both jambs`);
      const [ax, az] = f.axis === 'x' ? [1, 0] : [0, 1];
      for (let i = 0; i < len; i++) for (const side of [-1, 1]) {
        assert(!(at(f.x + dx * i + ax * side, f.z + dz * i + az * side) in TILES_SOLIDS), `${tile.id}: feature approach is clear`);
      }
    }
    if (gyms[tile.id]) assert.deepEqual([pallets.length, windows.length], gyms[tile.id], `${tile.id}: single pallet/window contract`);
    if (tile.category === 'carpile' && mode === 'roll') assert(pallets.length <= 1, `${tile.id}: exclusive pallet choice`);
    if (tile.category === 'dead' || tile.category === 'gate') assert.equal(pallets.length + windows.length, 0);
    transforms++;
  }
}

const load = file => JSON.parse(readFileSync(file, 'utf8'));
const index = load('maps/gas-heaven/index.json');
assert.equal(index.count, 32);
assert.equal(index.variants.length, 32);
for (const [i, variant] of index.variants.entries()) {
  assert.equal(variant.file, `v${String(i).padStart(3, '0')}.json`);
  const map = load(`maps/gas-heaven/${variant.file}`), result = analyzeMap(map);
  assert.deepEqual(result.errors, [], variant.file);
  assert(result.maxHookDistance <= 26, `${variant.file}: hook walk coverage`);
  assert(map.generators.every(g => outlineInset(g.x, g.z, map.outline) >= 6), `${variant.file}: generator edge inset`);
  const pr = map.mapgen.shape ? map.mapgen.shape.areaM2 / 9984 : 1;   // shaped outlines scale the pallet budget by area (generate.js)
  assert(map.pallets.length >= Math.round(14 * pr) && map.pallets.length <= Math.round(24 * pr), `${variant.file}: pallet budget`);
  const tiles = map.mapgen.tiles;
  const at = (x, z) => tiles.find(t => t.x === x && t.z === z);
  // no fixed placements (user 2026-11-16): one shack (never mirrored) and one infinite-loop probe at random slots
  for (const id of ['shack', 'infinite-loop']) assert.equal(tiles.filter(t => t.tile === id).length, 1, `${variant.file}: one ${id}`);
  assert(tiles.filter(t => t.tile === 'shack').every(t => t.mirror === false), `${variant.file}: shack unmirrored`);
  const s = map.mapgen.stats;
  assert.equal(s.safePallets + s.unsafePallets + s.godPallets, map.pallets.length, `${variant.file}: safety totals`);
  for (const key of ['pallets', 'windows', 'strongLoops', 'weakLoops', 'safePallets', 'unsafePallets', 'godPallets', 'deadTileFraction', 'deadZoneFraction']) assert.equal(variant[key], s[key], `${variant.file}: index ${key}`);
}
console.log(`${TILE_LIST.length} tile templates, ${transforms} resolutions and all 32 maps passed; fixed pieces, feature approaches, density, generator inset and hook coverage preserved.`);
