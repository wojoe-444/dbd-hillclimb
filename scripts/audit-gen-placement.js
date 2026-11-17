#!/usr/bin/env node
// Reproducible geometry audit of candidates AND the actual match initializer (no brain ticks).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createMatch, prepareMap, mergeConfig } from '../src/sim/index.js';
import { NavShared } from '../src/sim/nav.js';
import { genSlots } from '../src/sim/match.js';
import { outlineInset } from '../src/mapgen/index.js';

const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const dir = opt('map', 'maps/gas-heaven'), n = Number(opt('seeds', 128));
const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
const data = { candidates: {}, selected: {}, spawns: {} };
const add = (group, key, value) => (data[group][key] ??= []).push(value);
const idle = () => ({ decide: () => ({}) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
let tight = 0, tightEuclidean = 0, matches = 0, inaccessible = 0;
for (const v of index.variants) {
  const map = JSON.parse(readFileSync(path.join(dir, v.file), 'utf8'));
  // Same candidate geometry and actor RNG, with the pre-change match sampler, for attribution.
  if (args.includes('--legacy-selection')) delete map.generatorRules;
  const md = prepareMap(map), nav = new NavShared(md, mergeConfig());
  const gens = md.genCands, sides = gens.map(g => genSlots(md, g));
  const fields = sides.map(ss => ss.map(s => nav.computeField(Math.floor(s.z) * md.w + Math.floor(s.x), null, 0)));
  const walking = gens.map((_, i) => gens.map((_, j) => i === j ? 0 : Math.min(...fields[i].flatMap(f => sides[j].map(s => f[Math.floor(s.z) * md.w + Math.floor(s.x)] / 1000)))));
  const euclidean = gens.map(a => gens.map(b => dist(a, b)));
  const loopPoints = [...md.windows, ...md.pallets.map(p => ({ x: p.cx, z: p.cz }))];
  const features = loopPoints.map(p => nav.computeField(Math.floor(p.z) * md.w + Math.floor(p.x), null, 0));
  const edge = gens.map(g => outlineInset(g.x, g.z, map.outline));
  const loopWalk = sides.map(ss => Math.min(...features.flatMap(f => ss.map(s => f[Math.floor(s.z) * md.w + Math.floor(s.x)] / 1000))));
  const deadTile = gens.map(g => map.mapgen.tiles.find(t => g.x >= t.x && g.x < t.x + t.size && g.z >= t.z && g.z < t.z + t.size)?.rating === 'none' ? 1 : 0);
  inaccessible += sides.filter(s => s.length !== 4).length;
  function geometry(ids, group) {
    let tour = Infinity, eTour = Infinity, closest = Infinity;
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a];
      add(group, 'nearestWalkM', Math.min(...ids.filter(j => j !== i).map(j => walking[i][j])));
      add(group, 'nearestEuclideanM', Math.min(...ids.filter(j => j !== i).map(j => euclidean[i][j])));
      add(group, 'edgeM', edge[i]); add(group, 'loopWalkM', loopWalk[i]);
      add(group, 'deadTileFraction', deadTile[i]); add(group, 'farFromLoopFraction', loopWalk[i] > 12 ? 1 : 0);
      for (let b = a + 1; b < ids.length; b++) {
        const j = ids[b]; add(group, 'pairWalkM', walking[i][j]); add(group, 'pairEuclideanM', euclidean[i][j]);
        closest = Math.min(closest, walking[i][j]);
        for (let c = b + 1; c < ids.length; c++) {
          const k = ids[c]; tour = Math.min(tour, walking[i][j] + walking[j][k] + walking[k][i]);
          eTour = Math.min(eTour, euclidean[i][j] + euclidean[j][k] + euclidean[k][i]);
        }
      }
    }
    add(group, 'closestPairWalkM', closest); add(group, 'minThreeGenTourWalkM', tour); add(group, 'minThreeGenTourEuclideanM', eTour);
    return { tour, eTour };
  }
  add('candidates', 'count', gens.length); geometry(gens.map((_, i) => i), 'candidates');
  for (let seed = 1000; seed < 1000 + n; seed++) {
    const m = createMatch({ map, seed, hunter: idle, survivors: idle });
    const ids = m.gens.map(g => g.ci), { tour, eTour } = geometry(ids, 'selected');
    tight += tour < 80 ? 1 : 0; tightEuclidean += eTour < 80 ? 1 : 0; matches++;
    for (const [role, points] of [['survivor', m.survivors.map(s => s.spawn)], ['hunter', [m.hunter.spawn]]]) {
      for (const p of points) {
        const cell = Math.floor(p.z) * md.w + Math.floor(p.x);
        const ds = ids.map(i => Math.min(...fields[i].map(f => f[cell] / 1000)));
        add('spawns', `${role}NearestGenWalkM`, Math.min(...ds));
        for (const d of ds) add('spawns', `${role}ToGenWalkM`, d);
      }
    }
    // A reproducible spread proxy: how far an omitted candidate is from the nearest selected one.
    for (let i = 0; i < gens.length; i++) add('selected', 'candidateCoverageM', Math.min(...ids.map(j => euclidean[i][j])));
  }
  process.stderr.write(`${v.file} audited\n`);
}
function summary(xs) {
  if (xs.some(x => !Number.isFinite(x))) throw new Error('Audit found an unreachable measurement');
  xs.sort((a, b) => a - b);
  const q = p => xs[Math.floor((xs.length - 1) * p)];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: xs[0], p05: q(.05), median: q(.5), p95: q(.95), max: xs.at(-1) };
}
const result = { variants: index.variants.length, seedsPerVariant: n, seedStart: 1000, matches, candidatesWithoutFourSides: inaccessible,
  ...(args.includes('--legacy-selection') ? { legacySelection: true } : {}),
  tightThreeGenTourBelow80mFraction: tight / matches, tightEuclideanTourBelow80mFraction: tightEuclidean / matches,
  ...Object.fromEntries(Object.entries(data).map(([g, metrics]) => [g, Object.fromEntries(Object.entries(metrics).map(([key, xs]) => [key, summary(xs)]))])) };
const json = JSON.stringify(result, (_, v) => typeof v === 'number' ? +v.toFixed(4) : v, 2) + '\n';
if (opt('out')) writeFileSync(opt('out'), json);
console.log(json);
