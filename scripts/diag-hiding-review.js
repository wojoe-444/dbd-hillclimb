// Read-only hiding review. In-memory getters/labels never reach an action or observation.
// node scripts/diag-hiding-review.js --n 32 --out <file> [--variant on|walk|run|no-scratches|on-no-scratches] [--champ <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { scoreBloodpoints, BP } from '../src/hillclimb/bloodpoints.js';
import { survivalTimeScore } from '../src/hillclimb/hunterscore.js';

const args = process.argv.slice(2), a = {};
for (let i = 0; i < args.length; i += 2) a[args[i].slice(2)] = args[i + 1];
const n = +(a.n ?? 32), seed0 = +(a.seed ?? 1000), maps = loadMapPool(a.map ?? 'maps/gas-heaven');
let code = readFileSync('src/brains/survivor.js', 'utf8');
const replace = (from, to) => {
  if (!code.includes(from)) throw new Error('Instrumentation anchor changed: ' + from);
  code = code.replace(from, to);
};
replace("    let mode = 'work';", "    let reviewKind = 'work';\n    let mode = 'work';");
replace('      stats,', '      stats,\n      get reviewState() { return { mode, kind: reviewKind, hide: !!hide, genTarget }; },');
replace('        stats.decides++;', "        stats.decides++; reviewKind = 'work';");
replace('if (spot) { hiddenUntil', "if (spot) { reviewKind = 'visibleHide'; hiddenUntil");
replace("          // move away from the last sighting toward the farthest unfinished gen", "          reviewKind = 'sneak';\n          // move away from the last sighting toward the farthest unfinished gen");
code = code.replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(resolve('src/brains', rel)).href}'`);
const { makeSurvivor } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...hp, ...c.hunter }; sp = { ...sp, ...c.survivor }; }
const hideKeys = ['hideDist', 'hideHoldS', 'hideStayS', 'hideThreat', 'hideThreatR', 'hideGenFear', 'hideOnLayer', 'hideOnClosing', 'hideMoveMaxM', 'hideMaxS', 'peekW', 'peekMoveMaxM'];
if (['on', 'walk', 'run', 'on-no-scratches'].includes(a.variant)) {
  const d = defaults(B.survivor.space);
  for (const k of hideKeys) sp[k] = d[k];
  sp.hideThreat = 0.6;
}
if (a.variant === 'walk') { sp.walkWhenTR = 1; sp.hideWalk = 1; sp.coverRun = 0; }
if (a.variant === 'run') { sp.walkWhenTR = 0; sp.hideWalk = 0; sp.coverRun = 1; }
const rows = [];
for (let i = 0; i < n; i++) {
  const seed = seed0 + i, brains = [], latest = [], active = [], departures = [], episodes = [], leads = [], lastRepair = [], sightTimes = [[], [], [], []];
  const r = { seed, map: maps[seed % maps.length].id, standingS: 0, repairS: 0, time: {}, departures: [], episodes, newSightings: 0, scratchAssociatedSightings: 0 };
  const m = createMatch({ map: maps[seed % maps.length], seed,
    config: a.variant?.endsWith('no-scratches') ? { senses: { scratchRange: 0 } } : {},
    hunter: B.hunter.make(hp), survivors: ctx => {
      const b = makeSurvivor(sp)(ctx); brains[ctx.id] = b;
      return { decide(obs, api) {
        const prevHide = b.stats.hideTicks, prevPeek = b.stats.peekTicks;
        const action = b.decide(obs, api), state = b.reviewState;
        const hide = b.stats.hideTicks > prevHide || b.stats.peekTicks > prevPeek;
        latest[ctx.id] = { t: obs.t, kind: hide ? 'hide' : state.kind,
          mode: state.mode, tr: obs.terror?.layer ?? 0, h: !!obs.hunter, chased: !!obs.self.chased,
          x: obs.self.x, z: obs.self.z, action };
        return action;
      } };
    } });
  let prevSeen = [false, false, false, false], share = [0, 0, 0, 0];
  const objOf = s => s.repairC * BP.survivor.repairPerGen + s.leverS * BP.survivor.leverPerSecond;
  while (!m.over) {
    const prev = m.survivors.map(s => ({ act: s.curAct, gen: s.curTgt, x: s.x, z: s.z, obj: objOf(s) }));
    m.step();
    if (m.chaseTgt >= 0) for (const s of m.survivors) if (s.id !== m.chaseTgt) share[m.chaseTgt] += objOf(s) - prev[s.id].obj;
    for (const s of m.survivors) {
      const k = s.id, info = latest[k], seen = !!m.hunter.seen[k], moving = Math.hypot(s.vx, s.vz) > 0.2;
      if (!info) continue;
      const kind = s.st <= 1 && ['hide', 'visibleHide', 'sneak'].includes(info.kind) ? (info.kind === 'sneak' ? 'sneak' : 'hide') : null;
      if (s.st <= 1) {
        r.standingS += m.dt;
        if (s.curAct === 'repair') r.repairS += m.dt;
        if (kind) {
          const key = kind + ':' + (s.curAct === 'repair' ? 'repair' : moving ? (info.action.walk ? 'walk' : 'run') : 'still');
          r.time[key] = (r.time[key] ?? 0) + m.dt;
        }
      }
      if (active[k] && (kind !== active[k].kind || s.st > 1)) { active[k].end = m.t; active[k] = null; }
      if (kind && !active[k]) {
        active[k] = { who: k, kind, start: m.t, seenAtStart: prevSeen[k] || seen, found: false, tr: info.tr, fromRepair: prev[k].act === 'repair', walkedS: 0, ranS: 0 };
        episodes.push(active[k]);
      }
      if (active[k]) {
        if (moving) active[k][info.action.walk ? 'walkedS' : 'ranS'] += m.dt;
        if (!active[k].seenAtStart && seen) { active[k].found = true; active[k].firstLOS ??= m.t - active[k].start; }
      }
      if (prev[k].act === 'repair' && s.curAct !== 'repair' && s.st <= 1) {
        const d = { who: k, gen: prev[k].gen, start: m.t, kind: kind ?? info.mode, tr: info.tr, seenAtStart: prevSeen[k] || seen, walkedS: 0, ranS: 0, firstMove: null, found: false };
        r.departures.push(d); departures[k] = d;
      }
      const dep = departures[k];
      if (dep) {
        if (s.curAct === 'repair' || s.st > 1 || m.t - dep.start >= 10) {
          dep.end = m.t;
          dep.returnSameGen = s.curAct === 'repair' && s.curTgt === dep.gen;
          departures[k] = null;
        } else {
          if (moving) { const gait = info.action.walk ? 'walk' : 'run'; dep.firstMove ??= gait; dep[gait === 'walk' ? 'walkedS' : 'ranS'] += m.dt; }
          if (!dep.seenAtStart && seen) dep.found = true;
        }
      }
      if (seen && !prevSeen[k] && s.st <= 1) {
        sightTimes[k].push(m.t);
        r.newSightings++;
        // Association only: same heuristic distance as diag-hiding, no causal assertion or mark ownership.
        const marks = m.hunter.visMarks.filter(mark => Math.hypot(mark.x - s.x, mark.z - s.z) < 15).length;
        if (marks) r.scratchAssociatedSightings++;
        if (kind) leads.push({ kind, marks, grunts: m.hunter.grunts.some(g => Math.hypot(g.x - s.x, g.z - s.z) < 10), recentRepair: m.t - (lastRepair[k] ?? -99) < 6 });
      }
      if (s.curAct === 'repair') lastRepair[k] = m.t;
      prevSeen[k] = seen;
    }
  }
  for (const e of active) if (e) { e.end = m.t; e.censored = true; }
  for (const e of episodes) {
    e.seenWithin10S = sightTimes[e.who].some(t => t >= e.start && t <= e.start + 10);
    e.followupCensored = m.t < e.start + 10;
  }
  for (const d of departures) if (d) { d.end = m.t; d.censored = true; }
  const res = m.result(); res.chaseShareObj = share;
  r.fit = 0.5 * scoreBloodpoints(res).survivorFit + 0.5 * survivalTimeScore(res);
  r.survival = survivalTimeScore(res); r.gens = res.gensDone; r.kills = res.kills; r.duration = res.durationS;
  r.hides = brains.reduce((s, b) => s + b.stats.hides, 0); r.peeks = brains.reduce((s, b) => s + b.stats.peeks, 0);
  r.leads = leads; rows.push(r);
  process.stderr.write(`${a.variant ?? 'default'} ${i + 1}/${n}\n`);
}
function aggregate() {
  const sum = key => rows.reduce((s, r) => s + r[key], 0), mean = key => sum(key) / n;
  const ep = rows.flatMap(r => r.episodes), dep = rows.flatMap(r => r.departures);
  const time = {}; for (const r of rows) for (const [k, v] of Object.entries(r.time)) time[k] = (time[k] ?? 0) + v;
  const group = list => ({ n: list.length, unseenStart: list.filter(e => !e.seenAtStart).length, found: list.filter(e => !e.seenAtStart && e.found).length,
    seenWithin10S: list.some(e => 'seenWithin10S' in e) ? list.filter(e => !e.seenAtStart && e.seenWithin10S).length : null,
    unseenFollowupCensored: list.some(e => 'followupCensored' in e) ? list.filter(e => !e.seenAtStart && e.followupCensored).length : null,
    firstWalk: list.some(e => 'firstMove' in e) ? list.filter(e => e.firstMove === 'walk').length : null,
    firstRun: list.some(e => 'firstMove' in e) ? list.filter(e => e.firstMove === 'run').length : null,
    still: list.some(e => 'firstMove' in e) ? list.filter(e => e.firstMove === null).length : null,
    sameGenWithin10S: list.some(e => 'returnSameGen' in e) ? list.filter(e => e.returnSameGen).length : null,
    walkedS: list.reduce((s, e) => s + e.walkedS, 0), ranS: list.reduce((s, e) => s + e.ranS, 0), censored: list.filter(e => e.censored).length });
  return { n, fit: mean('fit'), survival: mean('survival'), gens: mean('gens'), kills: mean('kills'), duration: mean('duration'), hides: mean('hides'), peeks: mean('peeks'),
    standingS: sum('standingS'), repairS: sum('repairS'), time, episodes: Object.fromEntries(['hide', 'sneak'].map(k => [k, group(ep.filter(e => e.kind === k))])),
    departures: group(dep), threatenedDepartures: group(dep.filter(d => d.tr > 0)), stealthDepartures: group(dep.filter(d => ['hide', 'sneak'].includes(d.kind))),
    newSightings: sum('newSightings'), scratchAssociatedSightings: sum('scratchAssociatedSightings'), leads: rows.flatMap(r => r.leads) };
}
const out = { variant: a.variant ?? 'default', champ: a.champ ?? null, seed0, map: a.map ?? 'maps/gas-heaven', summary: aggregate(), rows };
if (a.out) writeFileSync(a.out, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
