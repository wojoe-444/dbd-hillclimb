// Endgame diagnostic: what survivors do once the exit gates are powered. With default bots the gates power in only a
// few matches, so by default this is a LABELLED SHORT-GEN diagnostic: config gens.needed = 2 (--needed 5 = the real
// rules, natural endgames only). Read-only: observes engine state and events, never changes a decision.
//
// Per powered match: escapes, kills, deaths after powering by cause, survivors standing / hooked / downed at powering,
// time to the first gate opening and first escape, duplicate lever work (a survivor's openGate on a lever someone
// else holds; two standing survivors within 3 m of the same unopened lever), teammates hooked at / after powering:
// rescued, died on the hook, killed by the collapse / all-down; rescues in the endgame and trades (rescuer or rescued
// downed within 10 s).
//
// Usage: node scripts/diag-endgame.js [--n 64] [--needed 2] [--map maps/gas-heaven] [--seed 1000]
//        [--set gateHoldProg=0.9,endgameSaveMarginS=5]   (survivor knob overrides) [--champ runs/<run>/champions.json]
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...hp, ...c.hunter }; sp = { ...sp, ...c.survivor }; }
if (a.set) for (const kv of a.set.split(',')) { const [k, v] = kv.split('='); if (!(k in B.survivor.space)) throw new Error('unknown survivor knob ' + k); sp = { ...sp, [k]: +v }; }
const n = +(a.n ?? 64), seed0 = +(a.seed ?? 1000), needed = +(a.needed ?? 2);
const config = { gens: { needed } };

const R = {
  matches: 0, powered: 0, escapes: 0, kills: 0, escPowered: 0, killsPowered: 0, gensDone: 0, dur: 0,
  atPower: { standing: 0, hooked: 0, downed: 0 }, deathsAfter: {}, toOpen: [], toEscape: [],
  dupLeverS: 0, crowdLeverS: 0, leverS: 0, hookedOpps: 0, hookedRescued: 0, hookedDiedHook: 0, hookedOther: 0,
  egRescues: 0, egTrades: 0, leftWithHooked: 0, endReasons: {},
};
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const seed = seed0 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, config, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const S = m.survivors, dt = m.dt ?? 0.1;
  let evRead = 0, powerT = -1, openT = -1, escT = -1;
  const opps = new Map(), recent = [];
  while (!m.over) {
    m.step();
    for (; evRead < m.events.length; evRead++) {
      const e = m.events[evRead];
      if (e.type === 'gatesPowered') {
        powerT = m.t;
        for (const s of S) {
          if (s.st <= 1) R.atPower.standing++; else if (s.st === 4) { R.atPower.hooked++; opps.set(s.id, { t: m.t }); R.hookedOpps++; } else if (s.st === 2 || s.st === 3) R.atPower.downed++;
        }
      } else if (powerT >= 0 && e.type === 'hook') { opps.set(e.who, { t: m.t }); R.hookedOpps++; }
      else if (powerT >= 0 && e.type === 'rescue') {
        R.egRescues++; recent.push({ by: e.by, who: e.who, t: m.t, done: false });
        if (opps.has(e.who)) { R.hookedRescued++; opps.delete(e.who); }
      } else if (powerT >= 0 && e.type === 'hit' && e.state === 'downed') {
        for (const r of recent) if (!r.done && m.t - r.t <= 10 && (e.who === r.by || e.who === r.who)) { r.done = true; R.egTrades++; }
      } else if (e.type === 'gateOpen' && openT < 0 && powerT >= 0) openT = m.t;
      else if (e.type === 'escape') {
        if (escT < 0 && powerT >= 0) escT = m.t;
        if (powerT >= 0 && S.some((s) => s.st === 4)) R.leftWithHooked++;
      } else if (e.type === 'death' && powerT >= 0) {
        R.deathsAfter[e.cause] = (R.deathsAfter[e.cause] ?? 0) + 1;
        if (opps.has(e.who)) { if (e.cause === 'hookDeath' || e.cause === 'hook3') R.hookedDiedHook++; else R.hookedOther++; opps.delete(e.who); }
      }
    }
    if (powerT >= 0) {
      for (const g of m.gates) {
        if (g.open) continue;
        let near = 0;
        for (const s of S) {
          if (s.st > 1) continue;
          if (Math.hypot(s.x - g.lx, s.z - g.lz) < 3) near++;
          const A = s.lastAction || {};
          if (A.act === 'openGate' && Math.hypot(s.x - g.lx, s.z - g.lz) <= 1.6) {
            R.leverS += dt;
            if (g.user >= 0 && g.user !== s.id) R.dupLeverS += dt;
          }
        }
        if (near >= 2) R.crowdLeverS += dt;
      }
    }
  }
  const r = m.result();
  R.matches++; R.escapes += r.escapes; R.kills += r.kills; R.gensDone += r.gensDone; R.dur += r.durationS;
  R.endReasons[r.endReason] = (R.endReasons[r.endReason] ?? 0) + 1;
  if (powerT >= 0) {
    R.powered++; R.escPowered += r.escapes; R.killsPowered += r.kills;
    if (openT >= 0) R.toOpen.push(openT - powerT);
    if (escT >= 0) R.toEscape.push(escT - powerT);
  }
  for (const o of opps.values()) { void o; R.hookedOther++; }
}
const f = (x, d = 2) => (+x).toFixed(d);
const P = Math.max(1, R.powered);
const med = (v) => { if (!v.length) return '-'; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(1); };
console.log(`[diag-endgame] gens.needed=${needed}${needed < 5 ? ' (SHORT-GEN DIAGNOSTIC, not the real rules)' : ''}  ${n} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`all: kills ${f(R.kills / n)}  escapes ${f(R.escapes / n)}  gens ${f(R.gensDone / n)}  dur ${f(R.dur / n, 1)}s  end ${JSON.stringify(R.endReasons)}`);
console.log(`powered ${R.powered}/${n}: escapes/powered ${f(R.escPowered / P)}  kills/powered ${f(R.killsPowered / P)}`);
console.log(`at powering: standing ${f(R.atPower.standing / P)}  hooked ${f(R.atPower.hooked / P)}  downed/carried ${f(R.atPower.downed / P)}`);
console.log(`deaths after powering /powered: ${Object.entries(R.deathsAfter).map(([k, v]) => `${k} ${f(v / P)}`).join('  ') || '-'}`);
console.log(`power -> first gate open: median ${med(R.toOpen)} s (${R.toOpen.length})   -> first escape: median ${med(R.toEscape)} s (${R.toEscape.length})`);
console.log(`lever work ${f(R.leverS / P, 1)} s/powered: duplicate (lever held by another) ${f(R.dupLeverS / P, 1)} s  two standing within 3 m of one lever ${f(R.crowdLeverS / P, 1)} s`);
console.log(`hooked at/after powering: ${R.hookedOpps} -> rescued ${R.hookedRescued}  died on hook ${R.hookedDiedHook}  other (collapse/allDown/match end) ${R.hookedOther}   escapes while a teammate hung ${R.leftWithHooked}`);
console.log(`endgame rescues ${R.egRescues}, trades (downed within 10 s) ${R.egTrades}`);
