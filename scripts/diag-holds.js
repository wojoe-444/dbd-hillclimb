// What does the hunter do while a chased survivor holds still at a window (brain asks to stand there facing it)?
// Each hold episode (>= 0.5 s standing within 2.5 m of a window, chased) ends with one of:
//   hunterVault  : the hunter vaults THAT window (toward the survivor) -- it walks into the vault-back mind game
//   survivorFirst: the survivor vaults / leaves first (the hunter came round, or the hold timed out)
//   hit          : the survivor is hit during the hold
// plus the seconds the survivor gained per exchange (hunter vault time - survivor's next vault time).
// node scripts/diag-holds.js [--n 24] [--map maps/gas-heaven] [--sp knob=v,...] [--champ file]
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
if (a.champ) { const c = JSON.parse(readFileSync(a.champ, 'utf8')).champ; hp = { ...hp, ...c.hunter }; sp = { ...sp, ...c.survivor }; }
if (a.sp) for (const p of a.sp.split(',')) { const [k, v] = p.split('='); sp[k] = +v; }
const n = +(a.n ?? 24);
const out = { hunterVault: 0, survivorFirst: 0, hit: 0, holdS: 0 };
let exch = 0, gain = 0;
for (let i = 0; i < n; i++) {
  const seed = 5000 + i, map = maps[seed % maps.length];
  const m = createMatch({ map, seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
  const ep = [null, null, null, null];
  const winC = m.md.windows.map((w) => ({ x: w.x + 0.5, z: w.z + 0.5, cell: w.cell }));
  let lastHV = null;
  while (!m.over) {
    m.step();
    const H = m.hunter, hv = H.vault && H.vault !== lastHV ? H.vault : null; lastHV = H.vault || null;
    m.survivors.forEach((s, k) => {
      const act = s.lastAction || {};
      const holding = m.chaseTgt === k && s.st <= 1 && !s.vault && Math.hypot(s.vx, s.vz) < 0.5 && act.face && act.moveTo && Math.hypot(act.moveTo.x - s.x, act.moveTo.z - s.z) < 0.8;
      let e = ep[k];
      if (!e && holding) {
        let w = null, bd = 2.5; for (const c of winC) { const d = Math.hypot(c.x - s.x, c.z - s.z); if (d < bd) { bd = d; w = c; } }
        if (w) ep[k] = e = { t0: m.t, w, hits: s.st };
      }
      if (!e) return;
      if (s.st !== e.hits || s.st > 1) { if (m.t - e.t0 >= 0.5) out.hit++; ep[k] = null; return; }
      if (hv && hv.cell === e.w.cell) { if (m.t - e.t0 >= 0.5) { out.hunterVault++; out.holdS += m.t - e.t0; e.wait = { t: m.t }; } else ep[k] = null; if (!e.wait) ep[k] = null; return; }
      if (e.wait) {   // the hunter is vaulting toward me: did I vault back over the same window, and how fast?
        if (s.vault && s.vault.cell === e.w.cell) { exch++; gain += (m.cfg.hunter.vaultS ?? 1.7) - s.vault.dur; ep[k] = null; }
        else if (m.t - e.wait.t > 3) ep[k] = null;
        return;
      }
      if (!holding && (s.vault || Math.hypot(s.vx, s.vz) > 1)) { if (m.t - e.t0 >= 0.5) { out.survivorFirst++; out.holdS += m.t - e.t0; } ep[k] = null; }
    });
  }
}
const tot = out.hunterVault + out.survivorFirst + out.hit;
console.log(`hold episodes ${tot} (mean ${(out.holdS / Math.max(1, out.hunterVault + out.survivorFirst)).toFixed(2)} s): hunter vaults that window ${out.hunterVault} (${(100 * out.hunterVault / tot).toFixed(0)}%), survivor moves first ${out.survivorFirst}, hit while holding ${out.hit}`);
console.log(`after the hunter's vault the survivor vaulted straight back ${exch} times, gaining ${(gain / Math.max(1, exch)).toFixed(2)} s (hunter vault - my vault) each`);
