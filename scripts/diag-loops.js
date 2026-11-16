// Loop diagnostics for the survivor brain's "equivalent distance held" evaluator (src/brains/loops.js).
//
// 1) --top K: with FULL map knowledge, the K best distinct circuits on a few variants (expected distance held per
//    chase incl. the window blocker budget, and per lap), marking anchors inside the infinite-loop probe tile (*).
// 2) chases with default knobs (normal exploration): chases that start inside / near the infinite-loop tile
//    (BITIC slot x 24-40, z 40-56, +4 m margin) vs elsewhere: count, mean duration, share ending in a down,
//    time from the chase start to that survivor's next down (cap 60 s), and window vaults made inside the tile;
//    plus, over all chases: mean duration and the share ending within 16 m of the map's outer wall.
// 3) duel (--duel 8): one survivor with full anchor knowledge starts at the tile's north-west window with the hunter
//    10 m behind, vs the same at the best circuit entry NOT in the tile; mean time to down (cap 60 s).
//
// Usage: node scripts/diag-loops.js [--n 32] [--top 5] [--variants 0,7,19] [--map maps/gas-heaven] [--champ runs/<run>/champions.json]
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { LoopModel } from '../src/brains/loops.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
const TILE = { x0: 24, x1: 40, z0: 40, z1: 56 }, MARGIN = 4;
const inTile = (p, m = 0) => p.x >= TILE.x0 - m && p.x <= TILE.x1 + m && p.z >= TILE.z0 - m && p.z <= TILE.z1 + m;

// ---- 1) full-knowledge ranking ----
const K = +(a.top ?? 5);
for (const vi of (a.variants ?? '0,7,19').split(',').map(Number)) {
  const map = maps[vi % maps.length];
  let ctx = null;
  createMatch({ map, seed: 1, hunter: () => ({ decide: () => ({}) }), survivors: (c) => { ctx ??= c; return { decide: () => ({}) }; } });
  const L = new LoopModel(ctx);
  const all = L.allCircuits();
  const name = (c) => { const an = L.anchors[c >> 1]; return `${an.kind === 'w' ? 'W' : 'P'}:${an.id}${c & 1 ? '<' : '>'}${inTile(an.c) ? '*' : ''}`; };
  const bestOther = all.find((o) => !o.seq.some((c) => inTile(L.anchors[c >> 1].c)));
  console.log(`${map.id}: ${L.anchors.length} anchors, ${all.length} circuits with positive distance held; best circuit without tile anchors ${bestOther ? bestOther.fresh.toFixed(1) : '-'} m/chase`);
  all.slice(0, K).forEach((o, r) => console.log(`  #${r + 1} ${o.fresh.toFixed(1).padStart(5)} m/chase  ${o.lap.toFixed(1).padStart(5)} m/lap  ${o.seq.map(name).join(' -> ')}`));
}

// ---- 2) chases with default knobs ----
const n = +(a.n ?? 32);
const st = { tile: { n: 0, dur: 0, downs: 0, ttd: 0 }, other: { n: 0, dur: 0, downs: 0, ttd: 0 } };
let wallEnds = 0, allEnds = 0, allDur = 0;
const edgeDist = (map, pt) => { let best = Infinity; const o = map.outline; for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const ax = o[j][0], az = o[j][1], ex = o[i][0] - ax, ez = o[i][1] - az, L = ex * ex + ez * ez; const u = L > 0 ? Math.max(0, Math.min(1, ((pt.x - ax) * ex + (pt.z - az) * ez) / L)) : 0; best = Math.min(best, Math.hypot(ax + u * ex - pt.x, az + u * ez - pt.z)); } return best; };
let tileVaults = 0, chaseVaults = 0, explored = 0, nb = 0, tileKnown = 0, tileAnch = 0;
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const seed = 1000 + i, brains = [];
  const mk = B.survivor.make(sp);
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: (ctx) => { const b = mk(ctx); brains.push(b); return b; } });
  let cur = null, evN = 0;
  const recs = [], lastRec = [null, null, null, null];
  while (!m.over) {
    m.step();
    for (; evN < m.events.length; evN++) {
      const e = m.events[evN];
      if (e.type === 'chaseStart') { const s = m.survivors[e.who]; cur = { who: e.who, t: m.t, tile: inTile(s, MARGIN), down: false, ttd: null }; recs.push(cur); lastRec[e.who] = cur; }
      else if (e.type === 'hit' && e.state === 'downed') {
        if (cur && e.who === cur.who) cur.down = true;
        const r = lastRec[e.who]; if (r && r.ttd === null && m.t - r.t <= 60) r.ttd = m.t - r.t;
      }
      else if (e.type === 'vault' && e.chased) { chaseVaults++; if (inTile(m.survivors[e.who])) tileVaults++; }
      else if (e.type === 'chaseEnd' && cur) { allEnds++; allDur += m.t - cur.t; if (edgeDist(maps[seed % maps.length], m.survivors[cur.who]) < 16) wallEnds++; const b = cur.tile ? st.tile : st.other; b.n++; b.dur += m.t - cur.t; if (cur.down) b.downs++; cur = null; }
    }
  }
  for (const r of recs) (r.tile ? st.tile : st.other).ttd += r.ttd ?? Math.min(60, m.t - r.t);
  for (const b of brains) {
    if (!b.know) continue;
    explored += b.know.fraction(); nb++;
    b.know.anchors.forEach((an, k) => { if (inTile(an.c)) { tileAnch++; if (b.know.anchorKnown[k]) tileKnown++; } });
  }
}
const f = (b) => `${b.n} chases, mean ${(b.dur / Math.max(1, b.n)).toFixed(1)} s, ${(100 * b.downs / Math.max(1, b.n)).toFixed(0)}% end in a down, mean time to the next down ${(b.ttd / Math.max(1, b.n)).toFixed(1)} s (cap 60)`;
console.log(`\n${n} matches (default knobs, normal exploration) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  chases starting in/near the infinite-loop tile: ${f(st.tile)}`);
console.log(`  chases elsewhere:                             ${f(st.other)}`);
console.log(`  all chases: ${allEnds}, mean duration ${(allDur / Math.max(1, allEnds)).toFixed(1)} s, ending within 16 m of the outer wall: ${(100 * wallEnds / Math.max(1, allEnds)).toFixed(1)}%`);
console.log(`  window vaults during chases: ${chaseVaults}, of which inside the tile: ${tileVaults} (${(100 * tileVaults / Math.max(1, chaseVaults)).toFixed(1)}%)`);
console.log(`  survivors' map knowledge at match end: ${(100 * explored / Math.max(1, nb)).toFixed(0)}% of the map explored, tile windows known ${(100 * tileKnown / Math.max(1, tileAnch)).toFixed(0)}%`);

// ---- 3) duel: tile vs the best circuit elsewhere ----
const nd = +(a.duel ?? 8);
if (nd > 0) {
  const map = maps[0];
  const run = (where) => {
    let tot = 0, downs = 0;
    for (let seed = 1; seed <= nd; seed++) {
      const brains = []; const mk = B.survivor.make(sp);
      const m = createMatch({ map, seed, hunter: B.hunter.make(hp), survivors: (c) => { const b = mk(c); brains.push(b); return b; } });
      for (const b of brains) b.know.anchorKnown.fill(1);
      const L = brains[0].loops;
      let Pt;
      if (where === 'tile') { const w = L.anchors.filter((x) => x.kind === 'w' && inTile(x.c)).sort((p, q) => p.c.z - q.c.z || p.c.x - q.c.x)[0]; Pt = w.s[0]; }
      else { const o = L.allCircuits().find((c) => !c.seq.some((x) => inTile(L.anchors[x >> 1].c))); Pt = L.sidePt[o.seq[0]]; }
      const s = m.survivors[0];
      s.x = Pt.x; s.z = Pt.z;
      // hunter 8-14 m (path) away, in line of sight, facing the survivor
      let placed = false;
      for (let r = 8; r <= 14 && !placed; r += 1) for (let k = 0; k < 16 && !placed; k++) {
        const x = Pt.x + r * Math.cos(k * Math.PI / 8), z = Pt.z + r * Math.sin(k * Math.PI / 8);
        const i = Math.floor(x), j = Math.floor(z);
        if (!(i > 0 && j > 0 && i < L.W && j < L.H && !L.solid[j * L.W + i])) continue;
        const q = { x: i + 0.5, z: j + 0.5 }, d = m.hunter.nav.dist(q, Pt);
        if (m.hunter.api.los(q, Pt) && d >= 8 && d <= 14) { m.hunter.x = q.x; m.hunter.z = q.z; m.hunter.face = Math.atan2(Pt.z - q.z, Pt.x - q.x); placed = true; }
      }
      const t0 = m.t; let downT = null;
      while (!m.over && m.t - t0 < 60) { m.step(); if (m.events.some((e) => e.type === 'hit' && e.who === 0 && e.state === 'downed')) { downT = m.t - t0; break; } }
      tot += downT ?? 60; if (downT !== null) downs++;
    }
    return `mean time to down ${(tot / nd).toFixed(1)} s (cap 60), downed ${downs}/${nd}`;
  };
  console.log(`
duel on ${map.id} (full anchor knowledge, hunter 8-14 m path away, in sight):`);
  console.log('  start at the infinite-loop tile:        ' + run('tile'));
  console.log('  start at the best circuit elsewhere:    ' + run('other'));
}
