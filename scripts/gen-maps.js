#!/usr/bin/env node
// Generate a pool of tile-based Gas Heaven variants.
//
//   node scripts/gen-maps.js [--count 32] [--seed 1] [--out maps/gas-heaven] [--render 4] [--no-png] [--shaped odd|all|none]
//
// --shaped (default odd): which variants get a seeded stepped outline (src/mapgen/outline.js) instead of the
// layout's fixed outline. odd = v001, v003, ... (half the pool; the viewer/evolution pick v[seed % 32]).
//
// Writes <out>/v000.json ... plus <out>/index.json, renders the first --render variants to
// docs/maps/gas-heaven-tiles/ (SVG, and PNG via headless Chrome/Edge if found), and writes the tile stats
// report docs/maps/gas-heaven-tiles.md. Every variant must pass scripts/validate-map.js (analyzeMap).
import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { analyzeMap } from './validate-map.js';
import { renderSvg } from './render-map.js';
import { generateFromLayout, gasHeavenLayout, OUTLINE_FAMILIES, hashSeed, makeRng, TILE_LIST, resolveTile, composeFeatures } from '../src/mapgen/index.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const count = Number(opt('count', 32));
const baseSeed = Number(opt('seed', 1));
const outDir = opt('out', path.join('maps', 'gas-heaven'));
const renderCount = Number(opt('render', 4));
const wantPng = !args.includes('--no-png');
const shapedMode = opt('shaped', 'odd');
const isShaped = i => shapedMode === 'all' || (shapedMode === 'odd' && i % 2 === 1);
// families round-robin over the shaped variants so the pool always holds all of them (v001 notched, v003 circlish, ...)
const familyOf = i => OUTLINE_FAMILIES[(shapedMode === 'all' ? i : i >> 1) % OUTLINE_FAMILIES.length];
const renderDir = path.join('docs', 'maps', 'gas-heaven-tiles');
const reportPath = path.join('docs', 'maps', 'gas-heaven-tiles.md');

// ---- 1. tile library self-check: every tile, with all / no optional pallets, validates standalone ------
function checkTile(tile) {
  const problems = [];
  for (const mode of ['all', 'none']) for (const [rot, mirror] of [[0, false], [1, true]]) {
    const r = resolveTile(tile, makeRng(1), { rot, mirror, mode });
    const n = tile.size, W = n + 2;
    const grid = new Array(W * W).fill('.');
    r.rows.forEach((row, z) => [...row].forEach((ch, x) => { grid[(z + 1) * W + x + 1] = ch; }));
    const { obstacles, windows, pallets } = composeFeatures(grid, W, W);
    const map = {
      id: 'tile-check', name: tile.id, size: { w: W, h: W }, outline: [[0, 0], [W, 0], [W, W], [0, W]], eyeHeight: 1.6,
      obstacles, windows, pallets,
      generators: r.genSlots.map(([x, z], i) => ({ id: `g${i}`, x: x + 1.5, z: z + 1.5 })),
      hooks: r.hookSlots.map(([x, z], i) => ({ id: `h${i}`, x: x + 1.5, z: z + 1.5 })),
      exitGates: [], spawns: { hunter: [{ x: 0.5, z: 0.5 }], survivors: [{ x: 0.5, z: 0.5 }] }, labels: [],
    };
    const res = analyzeMap(map);
    for (const e of res.errors) if (!e.startsWith('generators must contain')) problems.push(`${mode}/rot${rot}${mirror ? 'm' : ''}: ${e}`);
    const border = r.rows.some((row, z) => [...row].some((ch, x) => (x === 0 || z === 0 || x === n - 1 || z === n - 1) && ch !== '.'));
    if (border) problems.push('border row/column is not walkable');
  }
  return problems;
}
let tileProblems = 0;
for (const t of TILE_LIST) {
  const p = checkTile(t);
  if (p.length) { tileProblems++; console.error(`TILE ${t.id}:\n  ${[...new Set(p)].slice(0, 6).join('\n  ')}`); }
}
if (tileProblems) { console.error(`${tileProblems} tile(s) failed the self-check.`); process.exit(1); }
console.log(`Tile library: ${TILE_LIST.length} tiles pass the standalone check (all/no optional pallets, rotated + mirrored).`);

// ---- 2. generate variants -------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (/^v\d{3}\.json$/.test(f)) rmSync(path.join(outDir, f));
const variants = [];
let retries = 0;
const failReasons = {};
for (let i = 0; i < count; i++) {
  const tag = `v${String(i).padStart(3, '0')}`;
  let done = null;
  for (let attempt = 0; attempt < 25 && !done; attempt++) {
    const seed = hashSeed('gas-heaven', baseSeed, i, attempt);
    const r = generateFromLayout(gasHeavenLayout, seed, isShaped(i) ? { shaped: true, family: familyOf(i) } : {});
    if (!r.ok) { retries++; failReasons[r.error.replace(/\d+/g, 'N')] = (failReasons[r.error.replace(/\d+/g, 'N')] ?? 0) + 1; continue; }
    r.map.id = `gas-heaven-${tag}`;
    r.map.name = `Gas Heaven (tiles ${tag})`;
    const res = analyzeMap(r.map);
    if (res.errors.length) { retries++; failReasons['validator: ' + res.errors[0].replace(/\d+/g, 'N')] = (failReasons['validator: ' + res.errors[0].replace(/\d+/g, 'N')] ?? 0) + 1; continue; }
    done = { tag, seed, map: r.map, stats: r.stats, res };
  }
  if (!done) { console.error(`${tag}: no valid variant after 25 attempts`); process.exit(1); }
  writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(done.map, null, 1) + '\n');
  variants.push(done);
  const s = done.stats;
  const sh = done.map.mapgen.shape;
  console.log(`${tag} seed ${done.seed}: VALID · ${sh ? `${sh.family} ${done.map.size.w}x${done.map.size.h} ${sh.areaM2} m² (${sh.moved.length} moved) · ` : 'base outline · '}${s.pallets} pallets · ${s.windows} windows · ${s.strongLoops} strong / ${s.weakLoops} weak loops · dead tiles ${(s.deadTileFraction * 100).toFixed(0)}% · gens ${s.generators} · hooks ${s.hooks} (max ${done.res.maxHookDistance} m) · gates ${s.gates.join('+')}`);
}
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
  map: 'gas-heaven', generator: gasHeavenLayout.generator, baseSeed, count,
  note: 'Tile-based Gas Heaven variants from scripts/gen-maps.js. Regenerate: node scripts/gen-maps.js --count ' + count + ' --seed ' + baseSeed,
  variants: variants.map(v => ({ file: `${v.tag}.json`, id: v.map.id, seed: v.seed, outline: v.map.mapgen.shape?.family ?? 'base', ...pick(v.stats, ['pallets', 'windows', 'strongLoops', 'weakLoops', 'safePallets', 'unsafePallets', 'godPallets', 'deadTileFraction', 'deadZoneFraction', 'generators', 'hooks']) })),
}, null, 1) + '\n');
console.log(`Wrote ${variants.length} variants + index.json to ${outDir} (${retries} rejected attempts: ${JSON.stringify(failReasons)}).`);

function pick(o, keys) { return Object.fromEntries(keys.map(k => [k, o[k]])); }

// ---- 3. renders -----------------------------------------------------------------------------------------
mkdirSync(renderDir, { recursive: true });
const browser = wantPng && [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => existsSync(p));
for (const v of variants.slice(0, renderCount)) {
  const svgPath = path.resolve(renderDir, `${v.tag}.svg`);
  writeFileSync(svgPath, renderSvg(v.map, v.res));
  let note = '';
  if (browser) {
    try {
      const { w, h } = v.map.size;
      execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${svgPath.replace(/\.svg$/, '.png')}`,
        `--window-size=${(w + 12) * 10},${(h + 24) * 10}`, pathToFileURL(svgPath).href], { stdio: 'ignore', timeout: 60000 });
      note = ' + PNG';
    } catch { note = ' (PNG failed)'; }
  }
  console.log(`Rendered ${path.relative('.', svgPath)}${note}`);
}

// ---- 4. report ------------------------------------------------------------------------------------------
const pct = x => `${Math.round(x * 100)}%`;
const agg = key => { const xs = variants.map(v => v.stats[key]); return { min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length }; };
const slotSummary = t => {
  const chars = t.rows.join('');
  const groups = resolveTile(t, makeRng(1), { mode: 'all' }).pallets;
  const guaranteed = groups.filter(g => !g.optional).length;
  const choice = new Set([...chars].filter(c => c >= '1' && c <= '9')).size;
  const optional = groups.length - guaranteed - choice;
  return { guaranteed, optional, choice, windows: [...chars].filter(c => c === 'W').length, gens: [...chars].filter(c => c === 'G').length };
};
const lines = [];
lines.push('# Gas Heaven — tile-based variants', '');
lines.push(`Generated by \`node scripts/gen-maps.js --count ${count} --seed ${baseSeed}\` (this file is rewritten on every run).`);
lines.push('Generator: `src/mapgen/` (tile library `tiles.js`, layout spec `layouts/gas-heaven.js`, pipeline `generate.js`). Variants: `maps/gas-heaven/vNNN.json`, listed in `maps/gas-heaven/index.json`. The hand-made v1 map `maps/gas-heaven.json` is unchanged.', '');
lines.push('## How a variant is built', '');
lines.push('1. 112 × 96 m outline on an 8 m grid (156 cells). Cells touching the outline form the outer **ring**; the rest is the **inner** area.');
lines.push(`   **Shaped variants** (\`--shaped ${shapedMode}\`; default: every odd variant): the outline is instead a seeded stepped polygon from \`src/mapgen/outline.js\` — 144–153 tiles (9216–9792 m²), aspect ≤ 1.6, min width 4 tiles everywhere, no holes; families round-robin: ${OUTLINE_FAMILIES.join(', ')}. Fixed pieces keep their slot when it fits inside, else move to the nearest free tile slot (\`fitLayoutToOutline\`; the MID enclosure moves as one piece with its jungle gym); pallet and hook budgets scale with area. The Outline column below names the family.`);
lines.push('2. No fixed placements: one shack (any rotation, never mirrored), one infinite-loop probe (canary), three maze-pool tiles and one car pile go to random free inner slots per seed.');
lines.push('3. Two exit gates on ring cells along different outline edges ≥ 75 m apart.');
lines.push(`4. Free inner 2×2 blocks get a 16 m loop tile with p=${gasHeavenLayout.bigTileChance} (jungle gyms, T+L, filler loops; repeated types are down-weighted); the remaining inner cells get 8 m small fillers or dead zones; ring cells mostly dead zones (trees, rocks, lone cars) with a few small fillers.`);
lines.push(`5. Optional pallets roll per tile (\`p\` groups) and car piles roll *one* of their numbered spots or none. If the total exceeds ${gasHeavenLayout.pallets.max}, random optional non-landmark pallets are removed; below ${gasHeavenLayout.pallets.min} the seed is rejected.`);
lines.push(`6. ${gasHeavenLayout.gens.count.join('-')} generator candidates chosen from tile slots, spread at least ~${gasHeavenLayout.gens.minSpacing} m where possible, all at least ${gasHeavenLayout.gens.minEdgeM} m from the outline.`);
lines.push(`7. Spawns: ${gasHeavenLayout.spawns.survivorAnchors} survivor *anchors* and ${gasHeavenLayout.spawns.hunter} hunter points spread around the whole perimeter, each ${gasHeavenLayout.spawns.inset.join('–')} m inside the outline, outside landmarks; anchors need ≥ ${pct(gasHeavenLayout.spawns.anchorOpenFraction)} walkable cells within ${gasHeavenLayout.spawns.anchorOpenRadius} m (the engine scatters the 4 survivors within 15 m of the chosen anchor and picks a hunter point on the opposite side). Maps declare \`spawnRules\`, so the validator enforces the inset/walkable/open-space rules for them.`);
lines.push(`8. Hooks: exactly ${gasHeavenLayout.hooks.max} hooks placed by simulated annealing so every walkable cell is within ${gasHeavenLayout.hooks.radius} m (4-neighbour walk, the validator's metric) of a hook; tile hook slots are preferred.`, '');
lines.push('## Tile library', '');
lines.push('Pallet slots: G = guaranteed, O = optional groups (spawn chance in brackets), C = numbered choice spots (one spawns, chance in brackets). Rating = loop judgment used for the strong/weak counts below. Pallet safety = isolated dropped pallet against an M1 killer; these judgments do not change engine rules. Window-only T+Ls are not pallet loops. See docs/research/tile-accuracy.md for the audit and source limitations.', '');
lines.push('| Tile | Size | Category | Pallets G / O / C | Windows | Gen slots | Rating rule | Pallet safety | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const ratingRule = {
  shack: 'strong', jgv1: 'strong', jgv2: 'strong', 'tl-wall': 'weak',
  'pallet-gym': 'strong with pallet, otherwise none',
  'four-lane-open': 'strong with window or pallet', 'four-lane-closed': 'strong with pallet, weak with window only',
  'variant-gym': 'strong with pallet, weak with window only',
  'carpile-long': 'strong with pallet, otherwise none', 'filler-wallcar': 'strong with pallet, otherwise none',
  'infinite-loop': 'strong (owner test probe)',
};
for (const t of TILE_LIST) {
  const s = slotSummary(t);
  const rule = ratingRule[t.id] ?? (t.category === 'dead' || t.category === 'gate' ? 'none (dead)' : 'weak if a pallet spawned, else none');
  lines.push(`| \`${t.id}\` ${t.name} | ${t.size} m | ${t.category} | ${s.guaranteed} / ${s.optional}${s.optional ? ` (${pct(t.optionalChance)})` : ''} / ${s.choice}${s.choice ? ` (${pct(t.choiceChance)})` : ''} | ${s.windows} | ${s.gens} | ${rule} | ${s.guaranteed + s.optional + s.choice ? t.palletSafety : 'n/a'} | ${(t.notes ?? '').replace(/\|/g, '/')} |`);
}
lines.push('', '## Per-variant stats', '');
lines.push(`- **Dead tiles** = share of the 156 8 m cells covered by tiles rated "none" (dead zones, gate areas, fillers/car piles whose pallet did not spawn).`);
lines.push(`- **Dead zone** = share of walkable cells more than ${gasHeavenLayout.deadZoneDistance} m (walking) from any pallet or window.`);
lines.push('- Loop counts are per tile instance (the preserved probe counts once although it holds four windows).', '');
lines.push('| Variant | Outline | Pallets | Windows | Strong | Weak | Dead tiles | Dead zone | Gens | JG v1/v2 | T+L | Mazes | Car piles (pallet/none) | Gates |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const v of variants) {
  const s = v.stats, tc = s.tileCounts, tiles = v.map.mapgen.tiles;
  const cars = tiles.filter(t => t.category === 'carpile');
  const mazes = tiles.filter(t => t.category === 'maze').map(t => t.tile).join(', ');
  lines.push(`| ${v.tag} | ${v.map.mapgen.shape ? `${v.map.mapgen.shape.family} ${v.map.size.w}×${v.map.size.h} (${v.map.mapgen.shape.areaM2} m²)` : 'base'} | ${s.pallets} | ${s.windows} | ${s.strongLoops} | ${s.weakLoops} | ${pct(s.deadTileFraction)} | ${pct(s.deadZoneFraction)} | ${s.generators} | ${tc.jgv1 ?? 0}/${tc.jgv2 ?? 0} | ${tc['tl-wall'] ?? 0} | ${mazes} | ${cars.filter(t => t.pallets).length}/${cars.filter(t => !t.pallets).length} | ${s.gates.join(' ')} |`);
}
const row = (label, key, f = x => x.toFixed(1)) => { const a = agg(key); return `| ${label} | ${f(a.min)} | ${f(a.mean)} | ${f(a.max)} |`; };
lines.push('', '### Spread across the pool', '', '| Stat | Min | Mean | Max |', '| --- | --- | --- | --- |');
lines.push(row('Pallets', 'pallets'), row('Windows', 'windows'), row('Strong loops', 'strongLoops'), row('Weak loops', 'weakLoops'), row('Safe pallets', 'safePallets'), row('Unsafe pallets', 'unsafePallets'), row('God pallets', 'godPallets'), row('Dead tiles', 'deadTileFraction', pct), row('Dead zone', 'deadZoneFraction', pct));
lines.push('', 'Hand-made v1 for comparison: 14 pallets, 9 windows.', '');
lines.push('## Renders', '', `First ${Math.min(renderCount, variants.length)} variants in \`docs/maps/gas-heaven-tiles/\` (tinted rectangles = tile footprints: tan landmark, purple maze, red car pile, blue loop, green filler; dashed outline + name on non-dead tiles).`, '');
for (const v of variants.slice(0, renderCount)) lines.push(`- [${v.tag}](gas-heaven-tiles/${v.tag}.svg)${browser ? ` · ![${v.tag}](gas-heaven-tiles/${v.tag}.png)` : ''}`);
writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`Wrote ${reportPath}`);
