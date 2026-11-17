// Read-only review telemetry. Outputs JSON; no shared brain state or altered observations.
// node scripts/diag-survivor-weakness.js --n 64 --map maps/gas-heaven --out scratch/pool.json
// Optional --sp key=value,...; --hp key=value,...; --champ path; --seed 1000; --detail 1.
// Isolated hypotheses: --prototype injured-heal | work-during-chase (neither is a recommended fix).
import { readFileSync, writeFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const a = Object.fromEntries(process.argv.slice(2).reduce((r, x, i, xs) => x.startsWith('--') ? [...r, [x.slice(2), xs[i + 1]]] : r, []));
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
// Optional isolated brain experiments and diagnostic getters. Decisions are unchanged without --prototype.
// No engine, source file, or map is modified.
if (a.prototype || a.detail) {
  let code = readFileSync('src/brains/survivor.js', 'utf8');
  const replace = (from, to) => { if (!code.includes(from)) throw new Error('Prototype patch no longer matches'); code = code.replace(from, to); };
  if (a.detail) replace('      stats,', '      stats,\n      get reviewState() { return { mode, genTarget, circ: !!circ, phase: circ?.phase, crossed: circ?.crossed }; },');
  if (a.prototype === 'injured-heal') replace("if (me.state === 'healthy' && P.altruism > 0.15)", "if ((me.state === 'healthy' || me.state === 'injured') && P.altruism > 0.15)");
  else if (a.prototype === 'work-during-chase') {
    replace("else if (h && dh < P.fleeSeenDist)", "else if (h && dh < P.fleeSeenDist && !(otherChased && P.trustChase > 0.5 && dh > 10))");
    replace("if (mode !== 'chase' && h && dh < P.hideDist && !me.chased)", "if (mode !== 'chase' && h && dh < P.hideDist && !me.chased && !(otherChased && P.trustChase > 0.5 && dh > 10))");
  } else if (a.prototype) throw new Error('Unknown --prototype');
  code = code.replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(resolve('src/brains', rel)).href}'`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  B.survivor.make = mod.makeSurvivor;
}
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...hp, ...c.hunter }; sp = { ...sp, ...c.survivor }; }
for (const [key, params, space] of [['sp', sp, B.survivor.space], ['hp', hp, B.hunter.space]]) {
  if (a[key]) for (const kv of a[key].split(',')) { const [k, v] = kv.split('='); if (!(k in space)) throw new Error(k); params[k] = +v; }
}
const n = +(a.n ?? 64), seed0 = +(a.seed ?? 1000), rows = [];
const mean = xs => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const quantile = (xs, q) => [...xs].sort((x, y) => x - y)[Math.floor((xs.length - 1) * q)] ?? null;
for (let i = 0; i < n; i++) {
  const seed = seed0 + i, brains = [], seen = [], base = B.survivor.make(sp);
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: ctx => {
    const br = base(ctx); brains[ctx.id] = br;
    return { decide(obs, api) {
      const h = obs.hunter, me = obs.self;
      seen[ctx.id] = { hDist: h ? Math.hypot(h.x - me.x, h.z - me.z) : Infinity,
        otherChased: obs.hud?.some(x => x.id !== me.id && x.chased), terror: !!obs.terror,
        known: obs.gens?.filter(g => g.known).length ?? 0 };
      return br.decide(obs, api);
    } };
  } });
  const r = { seed, map: maps[seed % maps.length].id, standingS: 0, bins: {}, first120: {}, runModes: {}, idleModes: {}, healFailedReasons: {}, chaseBins: [0, 0, 0, 0], chaseAllFourBins: [0, 0, 0, 0],
    chaseStandingS: 0, nonchasedStandingS: 0, nonchasedRepairS: 0, seen20OtherChaseS: 0, seen20OtherChaseRepairS: 0,
    repairWithOthersS: 0, hitsWhileRepairing: 0, hitsAfterOtherChaseExposure: 0, chasesAfterOtherChaseExposure: 0, repairRequestedNoWorkS: 0, healRequestedNoWorkS: 0, knownAt60: [], downedWithInjuredOnlyS: 0,
    chaseLengths: [], chaseEnd: {}, downNearResource: 0, downsTotal: 0, downsNearEdge: 0, fast: 0, medium: 0, slow: 0,
    hitsMidVault: 0, hitBoostDistance: [], rescues: 0, trades: 0, endReason: null, deaths: {}, stats: null, healPlan: {} };
  let ei = 0; const active = new Map(), vaults = [], boost = [], rescueTimes = [], exposedT = [-99, -99, -99, -99];
  while (!m.over) {
    const prev = m.survivors.map(s => ({ x: s.x, z: s.z, st: s.st, act: s.curAct }));
    const oldStats = brains.map(b => ({ hide: b.stats.hideTicks, peek: b.stats.peekTicks }));
    const prevActs = prev.map(p => p.act);
    m.step();
    const dt = m.dt, repairing = m.survivors.filter(s => s.curAct === 'repair').length;
    const allFour = m.survivors.every(s => s.st <= 1);
    if (m.chaseTgt >= 0) { r.chaseBins[repairing] += dt; if (allFour) r.chaseAllFourBins[repairing] += dt; }
    if (m.survivors.some(s => s.st === 2) && m.survivors.some(s => s.st === 1) && !m.survivors.some(s => s.st === 0)) r.downedWithInjuredOnlyS += dt;
    for (const s of m.survivors) {
      const k = s.id, A = s.lastAction || {}, info = seen[k] ?? {};
      if (s.vault && vaults[k] !== s.vault && [2, 3].includes(m.md.kind[s.vault.cell])) {
        r[s.vault.dur <= m.cfg.survivor.vaultFastS + 1e-9 ? 'fast' : s.vault.dur <= m.cfg.survivor.vaultMediumS + 1e-9 ? 'medium' : 'slow']++;
      }
      vaults[k] = s.vault;
      if (boost[k] && m.t <= boost[k].until + 1e-9) boost[k].dist += Math.hypot(s.x - prev[k].x, s.z - prev[k].z);
      else if (boost[k]) { r.hitBoostDistance.push(boost[k].dist); boost[k] = null; }
      if (s.st > 1) continue;
      r.standingS += dt;
      const moving = Math.hypot(s.vx, s.vz) > 0.2;
      const hiding = brains[k].stats.hideTicks > oldStats[k].hide || brains[k].stats.peekTicks > oldStats[k].peek;
      const bin = s.curAct === 'repair' ? 'repair' : ['heal', 'rescue', 'mend', 'openGate', 'dropPallet'].includes(s.curAct) ? s.curAct
        : s.vault ? 'vault' : m.chaseTgt === k ? (moving ? 'chaseMove' : 'chaseStill')
        : hiding ? (moving ? 'hideMove' : 'hideStill') : moving ? (A.walk ? 'walk' : 'run') : 'idle';
      r.bins[bin] = (r.bins[bin] ?? 0) + dt;
      const debug = brains[k].reviewState;
      if (debug && ['run', 'walk'].includes(bin)) { const key = debug.mode === 'chase' ? 'brainChaseOutsideHud' : debug.mode === 'sneak' ? 'sneak' : debug.genTarget === -2 ? 'explore' : A.act === 'heal' || (typeof A.target === 'number' && A.act === 'rescue') ? 'altruism' : 'workOrAltruism'; r.runModes[key] = (r.runModes[key] ?? 0) + dt; }
      if (debug && bin === 'idle') { const key = debug.mode + (debug.circ ? ':loop:' + debug.phase : ''); r.idleModes[key] = (r.idleModes[key] ?? 0) + dt; }
      if (m.t <= 120) r.first120[bin] = (r.first120[bin] ?? 0) + dt;
      if (m.chaseTgt === k) r.chaseStandingS += dt;
      else {
        r.nonchasedStandingS += dt;
        if (s.curAct === 'repair') r.nonchasedRepairS += dt;
        if (info.otherChased && info.hDist < 20) { exposedT[k] = m.t; r.seen20OtherChaseS += dt; if (s.curAct === 'repair') r.seen20OtherChaseRepairS += dt; }
      }
      if (s.curAct === 'repair' && repairing > 1 && m.survivors.some(o => o.id !== k && o.curAct === 'repair' && o.curTgt === s.curTgt)) r.repairWithOthersS += dt;
      if (A.act === 'repair' && s.curAct !== 'repair') r.repairRequestedNoWorkS += dt;
      if (A.act === 'heal' && s.curAct !== 'heal') {
        r.healRequestedNoWorkS += dt;
        const patient = m.survivors[A.target];
        const reason = !patient ? 'noTarget' : patient.st !== 1 && patient.st !== 2 ? 'wrongState' : patient.dwT >= 0 ? 'deepWound' : Math.hypot(patient.x-s.x, patient.z-s.z)>1.6 ? 'range' : Math.hypot(patient.vx,patient.vz)>0.01 ? 'moving' : patient.curAct ? 'patientAct:' + patient.curAct : 'other';
        r.healFailedReasons[reason] = (r.healFailedReasons[reason] ?? 0) + dt;
      }
      if (m.tick === 600) r.knownAt60.push(info.known);
    }
    for (; ei < m.events.length; ei++) {
      const e = m.events[ei];
      if (e.type === 'chaseStart') { active.set(e.who, e.t); if (e.t - exposedT[e.who] <= 5) r.chasesAfterOtherChaseExposure++; }
      if (e.type === 'chaseEnd') { if (active.has(e.who)) r.chaseLengths.push(e.t - active.get(e.who)); active.delete(e.who); r.chaseEnd[e.reason] = (r.chaseEnd[e.reason] ?? 0) + 1; }
      if (e.type === 'rescue') { r.rescues++; rescueTimes.push({ ...e }); }
      if (e.type === 'hit') {
        const s = m.survivors[e.who];
        // safety of working near a hunter that chases someone else: hits mid-repair / within 5 s of that exposure
        if (prevActs[e.who] === 'repair') r.hitsWhileRepairing++;
        if (e.t - exposedT[e.who] <= 5) r.hitsAfterOtherChaseExposure++;
        if (s.vault) r.hitsMidVault++;
        if (e.state === 'injured' && !e.endurance) boost[e.who] = { until: m.t + 1.8, dist: 0 };
        if (e.state === 'downed') {
          r.downsTotal++;
          if (Math.min(...[...m.md.windows, ...m.md.pallets].map(a => Math.hypot(s.x - (a.cx ?? a.x + 0.5), s.z - (a.cz ?? a.z + 0.5)))) < 4) r.downNearResource++;
          // Polygon boundary rather than rectangular bounding box.
          const o = maps[seed % maps.length].outline;
          let ed = Infinity;
          for (let p = 0, q = o.length - 1; p < o.length; q = p++) { const [x, z] = o[q], dx = o[p][0] - x, dz = o[p][1] - z;
            const u = Math.max(0, Math.min(1, ((s.x - x) * dx + (s.z - z) * dz) / (dx * dx + dz * dz || 1))); ed = Math.min(ed, Math.hypot(s.x - x - u * dx, s.z - z - u * dz)); }
          if (ed < 16) r.downsNearEdge++;
          for (const unhook of rescueTimes) if (!unhook.traded && m.t - unhook.t <= 10 && [unhook.who, unhook.by].includes(e.who)) { unhook.traded = true; r.trades++; }
        }
      }
      if (e.type === 'death') r.deaths[e.cause] = (r.deaths[e.cause] ?? 0) + 1;
    }
  }
  // heal planner episodes (healplan.js stats: arrivals / readLetGo / readKept / healedLetGo / healedAfterGen / sigLetGo / sigKeep ...)
  for (const b of brains) if (b && b.heal) for (const [k, v] of Object.entries(b.heal.stats)) r.healPlan[k] = (r.healPlan[k] ?? 0) + v;
  const res = m.result();
  Object.assign(r, { kills: res.kills, escapes: res.escapes, gensDone: res.gensDone, durationS: res.durationS, endReason: res.endReason,
    rawRepairS: res.survivors.reduce((s, x) => s + x.repairS, 0), effectiveRepairS: 90 * res.survivors.reduce((s, x) => s + x.repairC, 0),
    netRepairS: m.gens.reduce((s, g) => s + (g.done ? 90 : g.p), 0), unusedPallets: [...m.ps].filter(x => x === 0).length, stats: res.stats });
  rows.push(r);
}
const summary = {};
for (const k of Object.keys(rows[0])) if (typeof rows[0][k] === 'number') summary[k] = mean(rows.map(r => r[k]));
for (const k of ['bins', 'first120', 'runModes', 'idleModes', 'healFailedReasons', 'chaseEnd', 'deaths', 'stats', 'healPlan']) { summary[k] = {}; for (const r of rows) for (const [x, v] of Object.entries(r[k])) summary[k][x] = (summary[k][x] ?? 0) + v / n; }
for (const k of ['chaseBins', 'chaseAllFourBins']) summary[k] = [0, 1, 2, 3].map(i => mean(rows.map(r => r[k][i])));
summary.endReasons = rows.reduce((c, r) => (c[r.endReason] = (c[r.endReason] ?? 0) + 1, c), {});
summary.chase = { n: rows.flatMap(r => r.chaseLengths).length, mean: mean(rows.flatMap(r => r.chaseLengths)), median: quantile(rows.flatMap(r => r.chaseLengths), 0.5), p90: quantile(rows.flatMap(r => r.chaseLengths), 0.9) };
summary.hitBoostDistance = mean(rows.flatMap(r => r.hitBoostDistance)); summary.knownAt60 = mean(rows.flatMap(r => r.knownAt60));
console.log(JSON.stringify(summary, null, 2));
if (a.out) writeFileSync(a.out, JSON.stringify({ args: a, summary, rows }, null, 2));
