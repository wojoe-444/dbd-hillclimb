// Why does evolution switch hiding off? Same seeds, the evolved champion pair, survivor hiding as evolved vs switched
// back on. Reports survivor fitness (as in src/hillclimb/worker.js: 0.5 x normalised BP + 0.5 x (12 - hook stages)/12)
// and its parts, repair time, how often a hiding / peeking survivor is found and what most likely led the hunter
// there, and the hunter's belief accuracy (probability mass near each free survivor's true position).
//
// Usage: node scripts/diag-hiding.js [--n 24] [--champ runs/evo-v13/champions.json] [--map maps/gas-heaven]
//        [--on '{"hideDist":40,...}']   (knobs for the "hiding on" config; default = the survivor space defaults
//                                        for the hiding knobs + hideThreat 0.6)
import { readFileSync } from 'node:fs';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { scoreBloodpoints } from '../src/hillclimb/bloodpoints.js';
import { hookStagesTotal } from '../src/hillclimb/hunterscore.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
const champ = JSON.parse(readFileSync(a.champ ?? 'runs/evo-v13/champions.json', 'utf8')).champ;
const hp = { ...defaults(B.hunter.space), ...champ.hunter };
const sOff = { ...defaults(B.survivor.space), ...champ.survivor };
const d = defaults(B.survivor.space);
const HIDE_KEYS = ['hideDist', 'hideHoldS', 'hideStayS', 'hideThreat', 'hideThreatR', 'hideGenFear', 'hideOnLayer', 'hideOnClosing', 'hideMoveMaxM', 'hideMaxS', 'peekW', 'peekMoveMaxM'];
const sOn = { ...sOff, ...Object.fromEntries(HIDE_KEYS.map((k) => [k, d[k]])), hideThreat: 0.6, ...(a.on ? JSON.parse(a.on) : {}) };
const n = +(a.n ?? 24);

function run(sp, label) {
  const T = { fit: 0, bpFit: 0, stages: 0, gens: 0, kills: 0, dur: 0, repairS: 0, hideS: 0, aliveS: 0, peeks: 0, hides: 0,
    found: 0, cause: { belief: 0, noise: 0, scratch: 0, injured: 0, stumble: 0 }, accN: 0, acc: { repair: [0, 0], hide: [0, 0], other: [0, 0] }, naive: { repair: [0, 0], hide: [0, 0], other: [0, 0] } };
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i, sv = [];
    const mk = B.survivor.make(sp);
    const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: (ctx) => { const b = mk(ctx); sv.push(b); return b; } });
    const hb = m.hunter.brain.belief;
    const lastRepairT = [-99, -99, -99, -99], hideState = [0, 0, 0, 0], prevHideTicks = [0, 0, 0, 0], prevPeekTicks = [0, 0, 0, 0], seenPrev = [false, false, false, false];
    const massHist = [[], [], [], []], lastSeenByH = [null, null, null, null];
    const walkArea = hb.cells.length * hb.cs * hb.cs;
    while (!m.over) {
      m.step();
      const t = m.t;
      for (let k = 0; k < 4; k++) {
        const s = m.survivors[k], b = sv[k];
        if (s.st > 1) { seenPrev[k] = m.hunter.seen[k]; continue; }
        T.aliveS += m.dt;
        if (s.curAct === 'repair') { T.repairS += m.dt; lastRepairT[k] = t; }
        const hiding = b.stats.hideTicks > prevHideTicks[k] || b.stats.peekTicks > prevPeekTicks[k];
        prevHideTicks[k] = b.stats.hideTicks; prevPeekTicks[k] = b.stats.peekTicks;
        if (hiding) { T.hideS += m.dt; hideState[k] = t; }
        if (m.hunter.seen[k]) lastSeenByH[k] = { x: s.x, z: s.z, t };
        // belief mass near the true position, sampled every 2 s, for survivors the hunter hasn't seen for >= 3 s
        // (vs a naive estimator: 'within 10 m of where the hunter last saw them')
        if (m.tick % 20 === 0 && hb.state[k] === 'alive' && !(lastSeenByH[k] && t - lastSeenByH[k].t < 3)) {
          const mass = hb.massNear(k, s.x, s.z, 10);
          massHist[k].push([t, mass]); if (massHist[k].length > 5) massHist[k].shift();
          const cls = s.curAct === 'repair' ? 'repair' : (t - hideState[k] < 1 ? 'hide' : 'other');
          T.acc[cls][0] += mass; T.acc[cls][1]++;
          T.naive[cls][0] += lastSeenByH[k] && Math.hypot(lastSeenByH[k].x - s.x, lastSeenByH[k].z - s.z) < 10 ? 1 : 0; T.naive[cls][1]++;
        }
        // the hunter starts seeing a survivor that was hiding / peeking within the last 1 s: found. Why?
        const seen = m.hunter.seen[k];
        if (seen && !seenPrev[k] && t - hideState[k] < 1) {
          T.found++;
          const old = massHist[k].find((x) => t - x[0] >= 3.5 && t - x[0] <= 6.5);
          const marks = m.hunter.visMarks.filter((mk2) => Math.hypot(mk2.x - s.x, mk2.z - s.z) < 15).length;
          if (old && old[1] >= 0.4) T.cause.belief++;
          else if (t - lastRepairT[k] < 6) T.cause.noise++;
          else if (marks > 0) T.cause.scratch++;
          else if (s.st === 1) T.cause.injured++;
          else T.cause.stumble++;
        }
        seenPrev[k] = seen;
      }
      void walkArea;
    }
    const res = m.result();
    const bp = scoreBloodpoints(res), st = hookStagesTotal(res);
    T.fit += 0.5 * bp.survivorFit + 0.5 * (12 - Math.min(12, st)) / 12; T.bpFit += bp.survivorFit; T.stages += st;
    T.gens += res.gensDone; T.kills += res.kills; T.dur += res.durationS;
    for (const b of sv) { T.peeks += b.stats.peeks; T.hides += b.stats.hides; }
    T.uniform = (Math.PI * 100) / walkArea;
  }
  const f = (v) => (v / n).toFixed(3), pc = (x, y) => (100 * x / Math.max(1e-9, y)).toFixed(1) + '%';
  const acc = (c) => (T.acc[c][1] ? (T.acc[c][0] / T.acc[c][1]).toFixed(3) : '-');
  const nv = (c) => (T.naive[c][1] ? (T.naive[c][0] / T.naive[c][1]).toFixed(3) : '-');
  console.log(`\n== ${label}`);
  console.log(`  survivor fitness ${f(T.fit)}  (BP part ${f(T.bpFit)}, hook stages ${f(T.stages)})  gens ${f(T.gens)}  kills ${f(T.kills)}  dur ${(T.dur / n).toFixed(0)} s`);
  console.log(`  repairing ${pc(T.repairS, T.aliveS)} of alive survivor time, hiding/peeking ${pc(T.hideS, T.aliveS)}; hides ${f(T.hides)}/match, peeks ${f(T.peeks)}/match`);
  console.log(`  found while hiding/peeking: ${T.found} (${(T.found / n).toFixed(2)}/match); likely lead: belief ${T.cause.belief}, repair noise ${T.cause.noise}, scratch marks ${T.cause.scratch}, injured (grunts) ${T.cause.injured}, none of these ${T.cause.stumble}`);
  console.log(`  hunter belief: mean P(survivor within 10 m of its true position): repairing ${acc('repair')}, hiding ${acc('hide')}, other ${acc('other')}  (uniform guess: ${T.uniform.toFixed(3)})`);
  console.log(`    unseen >= 3 s only; naive 'last sighting within 10 m' hit rate: repairing ${nv('repair')}, hiding ${nv('hide')}, other ${nv('other')}`);
}
run(sOff, 'as evolved (hiding off)');
run(sOn, 'hiding switched back on');
