// After a survivor finishes a vault while chased: how long does it stand (nearly) still in the next 3 s, and what is
// the brain asking for while it stands? Usage: node scripts/diag-postvault.js [--n 24] [--map maps/gas-heaven] [--champ ...]
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';
const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
const n = +(a.n ?? 24), WIN = 3;
let vaults = 0, stillT = 0, winT = 0, longStill = 0; const kinds = {}; const ex = [];
for (let i = 0; i < n; i++) {
  const seed = 5000 + i;
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const was = m.survivors.map(() => null); const watch = m.survivors.map(() => null);
  while (!m.over) {
    m.step();
    m.survivors.forEach((s, k) => {
      if (was[k] && !s.vault && m.chaseTgt === s.id && s.st <= 1) { vaults++; watch[k] = { t0: m.t, still: 0, hd0: Math.hypot(m.hunter.x - s.x, m.hunter.z - s.z) }; }
      was[k] = s.vault;
      const w = watch[k]; if (!w) return;
      if (m.t - w.t0 > WIN || s.st > 1) { if (w.still >= 1.0) longStill++; watch[k] = null; return; }
      winT += m.dt;
      if (Math.hypot(s.vx, s.vz) < 0.5) {
        w.still += m.dt; stillT += m.dt;
        const act = s.lastAction || {};
        const k2 = act.vault ? 'vault-queued' : act.moveTo ? (Math.hypot(act.moveTo.x - s.x, act.moveTo.z - s.z) < 0.6 ? 'moveTo-self(hold)' : 'moveTo-far-but-still') : act.act ? 'act:' + act.act : 'no-move';
        kinds[k2] = (kinds[k2] || 0) + m.dt;
        if (ex.length < 8 && w.still > 0.99 && w.still < 1.0 + m.dt) ex.push({ seed, t: +m.t.toFixed(1), id: s.id, hunterDist: +Math.hypot(m.hunter.x - s.x, m.hunter.z - s.z).toFixed(1), hunterVaulting: !!m.hunter.vault, action: JSON.stringify(act).slice(0, 160) });
      }
    });
  }
}
console.log(`chased vaults ${vaults}; in the ${WIN}s after: standing still ${(100 * stillT / winT).toFixed(1)}% of the time; vaults followed by >=1 s still: ${longStill} (${(100 * longStill / vaults).toFixed(1)}%)`);
console.log('still time by brain request (s):', Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +v.toFixed(1)])));
for (const e of ex) console.log(' ', JSON.stringify(e));
