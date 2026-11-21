#!/usr/bin/env node
// Geometry regressions, including the owner's protected templates and shipped pool.
// node scripts/test-mapgen.js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TILES, TILE_LIST, SOLID_CHARS as TILES_SOLIDS, resolveTile, makeRng, composeFeatures, gasHeavenLayout, generateFromLayout, outlineInset } from '../src/mapgen/index.js';
import { analyzeMap } from './validate-map.js';
import { generatorSets, selectGenerators } from '../src/sim/gen-selection.js';
import { prepareMap, createMatch } from '../src/sim/index.js';
import { genSlots } from '../src/sim/match.js';
import { makeRng as simRng } from '../src/sim/rng.js';

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
    if (tile.id === 'shack') {
      assert.equal(r.genSlots.length, 1);
      const [x, z] = r.genSlots[0];
      assert(x > 3 && x < n - 4 && z > 3 && z < n - 4, 'shack slot stays indoors under all transforms');
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(at(x + dx, z + dz), '.', 'shack repair sides');
    }
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
{
  const seed = index.variants[0].seed, a = generateFromLayout(gasHeavenLayout, seed), b = generateFromLayout(gasHeavenLayout, seed);
  assert(a.ok && b.ok, 'known seed regenerates'); assert.deepEqual(a, b, 'candidate packing and mapgen deterministic');
  const impossible = structuredClone(gasHeavenLayout); impossible.gens.minSpacing = 1000;
  assert.equal(generateFromLayout(impossible, seed).ok, false, 'impossible candidate spacing rejects instead of relaxing');
  const noPallets = generateFromLayout({ ...gasHeavenLayout, pallets: { min: 0, max: 0 } }, seed);
  assert.equal(noPallets.ok, false, 'guaranteed and protected pallets can exceed the budget');
  assert.match(noPallets.error, /10 non-removable pallets exceed max 0/);
}
for (const [i, variant] of index.variants.entries()) {
  assert.equal(variant.file, `v${String(i).padStart(3, '0')}.json`);
  const map = load(`maps/gas-heaven/${variant.file}`), result = analyzeMap(map);
  const opts = variant.outline === 'base' ? {} : { shaped: true, family: variant.outline };
  const regenerated = generateFromLayout(gasHeavenLayout, variant.seed, opts);
  assert(regenerated.ok, `${variant.file}: ${regenerated.error}`);
  assert.deepEqual({ ...regenerated.map, id: map.id, name: map.name }, map, `${variant.file}: reproduces the shipped seed`);
  assert.deepEqual(result.errors, [], variant.file);
  assert(result.maxHookDistance <= 26, `${variant.file}: hook walk coverage`);
  assert(map.generators.every(g => outlineInset(g.x, g.z, map.outline) >= 6), `${variant.file}: generator edge inset`);
  const md = prepareMap(map);
  assert(md.genCands.every(g => genSlots(md, g).length === 4), `${variant.file}: four repair sides`);
  assert.deepEqual(map.generatorRules, gasHeavenLayout.gens.selection);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  for (const a of map.generators) for (const b of map.generators) if (a !== b) assert(distance(a, b) >= 20, `${variant.file}: candidate spacing never relaxed`);
  const sets = generatorSets(md.genCands, 7, map.generatorRules);
  assert(sets.length, `${variant.file}: feasible match selection`);
  assert.equal(new Set(sets.flat()).size, md.genCands.length, 'every candidate appears in a feasible seven');
  for (const ids of sets) {
    for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
      assert(distance(md.genCands[ids[a]], md.genCands[ids[b]]) >= 24, 'selected pair spacing');
      for (let c = b + 1; c < 7; c++) assert(distance(md.genCands[ids[a]], md.genCands[ids[b]]) + distance(md.genCands[ids[b]], md.genCands[ids[c]]) + distance(md.genCands[ids[c]], md.genCands[ids[a]]) >= 80, 'selected triple perimeter');
    }
    assert(md.genCands.every(g => ids.some(j => distance(g, md.genCands[j]) <= 40)), 'selected footprint coverage');
  }
  const sampled = new Set();
  const cold = prepareMap(structuredClone(map));
  for (let seed = 1000; seed < 1128; seed++) {
    const chosen = selectGenerators(md, 7, simRng(seed, 'world'), simRng(seed, 'generator-placement'));
    assert(sets.some(s => s.join() === chosen.join()));
    assert.deepEqual(chosen, selectGenerators(cold, 7, simRng(seed, 'world'), simRng(seed, 'generator-placement')), 'warm/cold selection determinism');
    sampled.add(chosen.join());
  }
  assert(sets.length === 1 || sampled.size > 1, 'seeded variation among feasible subsets');
  const idle = () => ({ decide: () => ({}) });
  const match = createMatch({ map, seed: 1000, hunter: idle, survivors: idle });
  assert.deepEqual(match.gens.map(g => g.ci), selectGenerators(md, 7, simRng(1000, 'world'), simRng(1000, 'generator-placement')), 'engine uses constrained selector');
  const legacy = structuredClone(map); delete legacy.generatorRules;
  const other = createMatch({ map: legacy, seed: 1000, hunter: idle, survivors: idle });
  assert.deepEqual([match.hunter.spawn, ...match.survivors.map(s => s.spawn)], [other.hunter.spawn, ...other.survivors.map(s => s.spawn)], 'selection leaves world/spawn RNG unchanged');
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

// Run the CLI from a temporary workspace so both map files and the docs report are isolated.
{
  const cwd = mkdtempSync(join(tmpdir(), 'test-mapgen-'));
  try {
    const out = join(cwd, 'maps', 'gas-heaven');
    mkdirSync(out, { recursive: true });
    const before = { 'index.json': 'old index\n', 'v000.json': 'old v000\n', 'v031.json': 'old v031\n', 'v1000.json': 'old v1000\n', 'notes.txt': 'keep\n' };
    for (const [file, contents] of Object.entries(before)) writeFileSync(join(out, file), contents);
    const snapshot = () => Object.fromEntries(readdirSync(out).map(file => [file, readFileSync(join(out, file), 'utf8')]));
    const script = fileURLToPath(new URL('./gen-maps.js', import.meta.url));
    const run = (args, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, script, '--no-png', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
    for (const [args, error] of [
      [['--count', '0'], /--count/],
      [['--count', '1.5'], /--count/],
      [['--seed', 'Infinity'], /--seed/],
      [['--render', '-1'], /--render must/],
      [['--out'], /--out/],
      [['--out', join(out, 'notes.txt')], /--out must name a directory/],
      [['--shaped', 'sometimes'], /--shaped/],
      [['--shpaed', 'none'], /--shpaed/],
    ]) {
      const rejected = run(args);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, error);
      assert.equal(rejected.stdout, '', 'invalid options are rejected before the tile check');
      assert.deepEqual(snapshot(), before, 'invalid options leave the pool intact');
    }

    // Only the shaped variant scales its pallet minimum, making every v001 attempt impossible.
    const fixture = join(cwd, 'impossible-outline-budget.mjs');
    const mapgenUrl = new URL('../src/mapgen/index.js', import.meta.url);
    writeFileSync(fixture, `import { gasHeavenLayout } from ${JSON.stringify(mapgenUrl.href)};\ngasHeavenLayout.refCells = 1;\n`);
    const failed = run(['--count', '2', '--render', '0'], ['--import', pathToFileURL(fixture).href]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /v000 seed \d+: VALID/);
    assert.match(failed.stderr, /v001: no valid variant after 25 attempts/);
    assert.deepEqual(snapshot(), before, 'exhausting retries after a valid variant leaves the pool intact');
    assert(!existsSync(join(cwd, 'docs')), 'failed generation leaves the report untouched');

    const succeeded = run(['--count', '1', '--render', '0']);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['index.json', 'notes.txt', 'v000.json']);
    assert.equal(readFileSync(join(out, 'notes.txt'), 'utf8'), before['notes.txt']);
    const newIndex = load(join(out, 'index.json'));
    assert.deepEqual(newIndex.variants, [index.variants[0]]);
    assert.deepEqual(load(join(out, 'v000.json')), load('maps/gas-heaven/v000.json'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
// Legacy fixtures keep their exact old shuffle, including the next world RNG value.
{
  const md = prepareMap(load('maps/test-small.json')), a = simRng(4, 'world'), b = simRng(4, 'world');
  const expected = b.shuffle(md.genCands.map((_, i) => i)).slice(0, 7).sort((x, y) => x - y);
  assert.deepEqual(selectGenerators(md, 7, a), expected); assert.equal(a.next(), b.next());
  const invalid = structuredClone(md.map); invalid.generatorRules = { minSpacingM: 1000, minThreeGenTourM: 80, maxCoverageM: 40 };
  assert.throws(() => selectGenerators(prepareMap(invalid), 7, simRng(1)), /No feasible/);
  assert(analyzeMap(invalid).errors.some(e => e.includes('no feasible')));
}
// Compare enumeration to an independent brute-force oracle, including exact-boundary acceptance.
{
  const points = [[0, 0], [24, 0], [48, 0], [0, 24], [24, 24], [48, 24], [0, 48], [24, 48], [48, 48]].map(([x, z]) => ({ x, z }));
  const rules = { minSpacingM: 24, minThreeGenTourM: 80, maxCoverageM: 24 }, expected = [];
  const d = (i, j) => Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
  for (let mask = 0; mask < (1 << points.length); mask++) {
    const ids = points.map((_, i) => i).filter(i => mask & (1 << i));
    if (ids.length !== 4 || points.some((_, i) => ids.every(j => d(i, j) > 24))) continue;
    let valid = true;
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      if (d(ids[a], ids[b]) < 24) valid = false;
      for (let c = b + 1; c < 4; c++) if (d(ids[a], ids[b]) + d(ids[b], ids[c]) + d(ids[c], ids[a]) < 80) valid = false;
    }
    if (valid) expected.push(ids.join());
  }
  assert(expected.length > 1, 'oracle exercises a nontrivial feasible set');
  assert.deepEqual(generatorSets(points, 4, rules).map(s => s.join()).sort(), expected.sort());
}
console.log(`${TILE_LIST.length} tile templates, ${transforms} resolutions and all 32 maps passed; fixed pieces, feature approaches, density, generator inset and hook coverage preserved.`);
console.log('All 32 shipped seeds regenerated exactly; CLI pool preservation and replacement passed.');
