// End-to-end check that the distance-held machinery drives chase behaviour (1 survivor vs the param hunter; the other
// three survivors are removed (escaped) and the gates are powered so the engine's last-survivor rule never ends it).
//   probe : on every gas-heaven variant, a chased survivor that knows the map starts 7 m outside the infinite-loop
//           probe tile (found via map.mapgen.tiles, tile === 'infinite-loop'), the hunter 9 m behind it. Reports
//           seconds alive (cap), seconds on the tile, tile window vaults and four-window laps.
//   dead  : test-small with a 5 m wide, 12 m deep dead-end pocket straight away from the hunter; open ground left /
//           right. Reports how often the survivor enters the pocket and seconds alive.
// node scripts/diag-chasepath.js [--cap 60] [--src <dir>] [--sp knob=v,...] [--only probe|dead] [--n 32]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { findInfLoopTile } from '../src/diag/canary.js';

const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[argv[i].slice(2)] = true; else { a[argv[i].slice(2)] = v; i++; } }
const src = resolve(a.src ?? 'src');
const imp = (p) => import(pathToFileURL(resolve(src, p)).href);
const { createMatch } = await imp('sim/index.js');
const { getBrains } = await imp('brains/index.js');
const { defaults } = await imp('hillclimb/params.js');
const B = getBrains();
const sp = defaults(B.survivor.space), hp = defaults(B.hunter.space);
if (typeof a.sp === 'string') for (const p of a.sp.split(',')) { const [k, v] = p.split('='); sp[k] = +v; }
const cap = +(a.cap ?? 60);

export function duel(map, seed, sPos, hPos, { cap: capS = cap, onStep } = {}) {
  let brain = null;
  const mk = B.survivor.make(sp);
  const idle = () => ({ decide: () => ({}) });
  const m = createMatch({ map, seed, config: { maxMatchS: capS + 5 }, hunter: B.hunter.make(hp), survivors: [(ctx) => { brain = mk(ctx); return brain; }, idle, idle, idle] });
  for (let i = 1; i < 4; i++) m.survivors[i].st = 6;
  m.gatesPowered = true;
  const s = m.survivors[0], h = m.hunter;
  s.x = sPos.x; s.z = sPos.z; h.x = hPos.x; h.z = hPos.z; h.face = Math.atan2(s.z - h.z, s.x - h.x);
  m.step();                                            // brain made (ctx) on the first decide
  if (brain && brain.know) brain.know.anchorKnown.fill(1);   // it has explored the map
  while (!m.over && m.t < capS && s.st < 2) { m.step(); if (onStep) onStep(m, s); }
  return { alive: Math.min(m.t, capS), downed: s.st >= 2, m, brain };
}

function probe() {
  const maps = loadMapPool(a.map ?? 'maps/gas-heaven').slice(0, +(a.n ?? 32));
  let alive = 0, onTile = 0, vaults = 0, laps = 0, downs = 0, n = 0;
  for (const [mi, map] of maps.entries()) {
    const sq = findInfLoopTile(map); if (!sq) continue;
    const cx = (sq.x0 + sq.x1) / 2, cz = (sq.z0 + sq.z1) / 2;
    // start: 7 m outside the tile's square on the side away from the map centre's nearest open cell, hunter 9 m further
    const W = map.size.w, H = map.size.h;
    const blocked = (x, z) => x < 1 || z < 1 || x > W - 1 || z > H - 1 || map.obstacles.some((o) => x >= o.x - 0.5 && x < o.x + o.w + 0.5 && z >= o.z - 0.5 && z < o.z + o.d + 0.5);
    let start = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = { x: cx + dx * (8 + 7), z: cz + dz * (8 + 7) }, hh = { x: s.x + dx * 9, z: s.z + dz * 9 };
      if (!blocked(s.x, s.z) && !blocked(hh.x, hh.z)) { start = [s, hh]; break; }
    }
    if (!start) continue;
    const tw = map.windows.filter((w) => w.x + 0.5 >= sq.x0 && w.x + 0.5 <= sq.x1 && w.z + 0.5 >= sq.z0 && w.z + 0.5 <= sq.z1).map((w) => `${w.x},${w.z}`);
    let lastV = null, tail = [], tv = 0, lp = 0, ot = 0;
    const r = duel(map, 7000 + mi, start[0], start[1], { onStep(m, s) {
      if (s.x >= sq.x0 && s.x <= sq.x1 && s.z >= sq.z0 && s.z <= sq.z1) ot += m.dt;
      const v = s.vault;
      if (v && v !== lastV) {
        const i = v.cell % m.md.w, j = Math.floor(v.cell / m.md.w), key = `${i},${j}`;
        if (tw.includes(key)) { tv++; if (tail.includes(key)) tail = []; tail.push(key); if (tail.length === 4) { lp++; tail = []; } } else tail = [];
      }
      lastV = v || null;
    } });
    n++; alive += r.alive; onTile += ot; vaults += tv; laps += lp; downs += r.downed ? 1 : 0;
    if (a.list) console.log(`${map.id} alive ${r.alive.toFixed(1)} onTile ${ot.toFixed(1)} vaults ${tv} laps ${lp}${r.downed ? ' DOWN' : ''}`);
  }
  console.log(`probe: ${n} variants  alive ${(alive / n).toFixed(1)}s (cap ${cap})  on tile ${(onTile / n).toFixed(1)}s  tile vaults ${(vaults / n).toFixed(2)}  laps ${(laps / n).toFixed(2)}  downed ${downs}/${n}`);
}

function deadEnd() {
  const base = JSON.parse(readFileSync('maps/test-small.json', 'utf8'));
  // pocket x 22..26 (inside), z 21..32, mouth at z = 21 facing north; walls x = 21 and x = 27, bottom z = 33
  const map = { ...base, id: 'test-deadend', obstacles: [...base.obstacles.filter((o) => !['l-1', 'l-2', 'r3'].includes(o.id)),
    { id: 'de-w', x: 21, z: 21, w: 1, d: 13, height: 3.5, kind: 'wall' }, { id: 'de-e', x: 27, z: 21, w: 1, d: 13, height: 3.5, kind: 'wall' },
    { id: 'de-s', x: 21, z: 33, w: 7, d: 1, height: 3.5, kind: 'wall' }], pallets: base.pallets.filter((p) => p.id !== 'p-gap') };
  const inPocket = (p) => p.x > 22 && p.x < 27 && p.z > 22 && p.z < 33;
  let entered = 0, alive = 0, n = +(a.n ?? 16);
  for (let k = 0; k < n; k++) {
    const ox = (k % 4) - 1.5, hz = 8 + (k >> 2);
    let went = false;
    const r = duel(map, 8000 + k, { x: 24.5 + ox, z: 18.5 }, { x: 24.5 + ox * 0.5, z: hz }, { cap: Math.min(cap, 30), onStep(m, s) { if (inPocket(s)) went = true; } });
    if (went) entered++; alive += r.alive;
  }
  console.log(`dead end: ${n} starts  entered the pocket ${entered}/${n}  alive ${(alive / n).toFixed(1)}s (cap ${Math.min(cap, 30)})`);
}

if (!a.only || a.only === 'probe') probe();
if (!a.only || a.only === 'dead') deadEnd();
