// Why chased window vaults are not fast. For every window vault a chased survivor starts in full matches, records the
// engine tier (fast 0.5 / medium 0.9 / slow 1.5) and, for non-fast ones, the reason:
//   walk      - walking (slow vault)
//   revault   - the owner's rule: within survivor.revaultNoFastS of the hunter clearing that window
//   angle     - run-up long enough but its heading is > fastVaultAngleDeg off the vault axis
//   short     - run-up < fastVaultRunupM; split by what started the final straight segment (the last run-up reset):
//               stopped (no movement that tick: hold / arrived), slowed (moved < 60% of a step: wall slide / body),
//               turn (heading changed > 25 deg: where? side point / approach cell / elsewhere), landing (a vault just ended)
// plus the loop runner's lineup decision for that crossing (brain.chaseDbg / stats.lineup; knob vaultLineup), and
// counterfactual fast shares under looser run-up rules (questions for the owner, docs/research/fast-vaults.md).
// Usage: node scripts/diag-fastvault.js [--n 32] [--seed0 1000] [--map maps/gas-heaven] [--sp knob=v,...] [--champ file] [--json]
//        [--whyLu chosen|cost|dropped|...]   (reasons for the non-fast vaults of one lineup-decision class)
import { readFileSync } from 'node:fs';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';

const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; } }
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
let hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.champ) ({ hunter: hp, survivor: sp } = JSON.parse(readFileSync(a.champ, 'utf8')).champ);
if (a.sp) { for (const kv of String(a.sp).split(',')) { const [k, v] = kv.split('='); sp[k] = +v; } sp = clampParams ? clampParams(B.survivor.space, sp) : sp; }
const n = +(a.n ?? 32), seed0 = +(a.seed0 ?? 1000);

export function runFastVaultDiag({ n, seed0, maps, hp, sp }) {
  const R = { vaults: 0, fast: 0, medium: 0, slow: 0, why: {}, turnAt: {}, mode: {}, modeFast: {}, runD: [], resetDist: [], turnDeg: [], aliveS: 0, matches: 0, lineup: {}, luWhy: {}, whyByLu: {}, readmeFast: 0, cone45: 0, runFace45: 0 };
  const inc = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
  for (let i = 0; i < n; i++) {
    const seed = seed0 + i;
    const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
    const md = m.md, W = md.w, sv = m.cfg.survivor, step = sv.runSpeed * m.dt;
    const st = m.survivors.map(() => ({ runD: 0, lastReset: null, vault: null }));
    while (!m.over) {
      const pre = m.survivors.map((s) => ({ x: s.x, z: s.z, runD: s.runD || 0, vault: s.vault, act: s.lastAction, dbg: s.brain.chaseDbg, clear: null }));
      m.step();
      m.survivors.forEach((s, k) => {
        const p = pre[k], S = st[k];
        if (s.vault && !p.vault) {
          const wi = m.winOfCell.get(s.vault.cell);
          if (wi === undefined || m.chaseTgt !== s.id) { S.lastReset = null; return; }
          const w = md.windows[wi], cx = w.x + 0.5, cz = w.z + 0.5;
          const nx = Math.sign(s.vault.x1 - s.vault.x0) * (w.axis === 'x' ? 1 : 0), nz = Math.sign(s.vault.z1 - s.vault.z0) * (w.axis === 'x' ? 0 : 1);
          const d = s.vault.dur, tier = d <= sv.vaultFastS + 1e-9 ? 'fast' : d <= sv.vaultMediumS + 1e-9 ? 'medium' : 'slow';
          R.vaults++; R[tier]++;
          // counterfactual (README wording): straight running whose every step heads within the cone of the vault direction
          { const cosT = Math.cos(sv.fastVaultAngleDeg * Math.PI / 180), cl0 = m.winHunterClearT.get(s.vault.cell); let acc = 0;
            for (let q = (S.hist || []).length - 1; q >= 0; q--) { const h = S.hist[q]; if (!h.ok || h.dx * nx + h.dz * nz < cosT) break; acc += h.ml; }
            const elig = tier !== 'slow' && !(cl0 !== undefined && m.t - m.dt - cl0 < sv.revaultNoFastS);
            if (elig && acc >= sv.fastVaultRunupM - 1e-6) R.readmeFast++;
            const c45 = Math.cos(Math.PI / 4); let a45 = 0, run = 0; const hs = S.hist || [];
            for (let q = hs.length - 1; q >= 0; q--) { const h = hs[q]; if (!h.ok || h.dx * nx + h.dz * nz < c45) break; a45 += h.ml; }
            for (let q = hs.length - 1; q >= 0; q--) { const h = hs[q]; if (!h.ok) break; run += h.ml; }
            const last = hs[hs.length - 1];
            if (elig && a45 >= sv.fastVaultRunupM - 1e-6) R.cone45++;
            if (elig && run >= sv.fastVaultRunupM - 1e-6 && last && last.dx * nx + last.dz * nz >= c45) R.runFace45++; }
          const dbg = s.brain.chaseDbg ?? p.dbg;
          const mode = dbg ? (dbg.lineup ? 'loop-lineup' : 'loop') : 'open';
          inc(R.mode, mode); if (tier === 'fast') inc(R.modeFast, mode);
          const lw = (dbg && dbg.luWhy) || (dbg ? 'loop:none' : 'open');
          R.luWhy[lw] = R.luWhy[lw] || { fast: 0, medium: 0, slow: 0 }; R.luWhy[lw][tier]++;
          if (tier !== 'fast') {
            const cl = m.winHunterClearT.get(s.vault.cell);
            let why;
            if (tier === 'slow') why = 'walk';
            else if (cl !== undefined && m.t - m.dt - cl < sv.revaultNoFastS) why = 'revault';
            else if (p.runD >= sv.fastVaultRunupM - 1e-6) why = 'angle';
            else {
              const r = S.lastReset;
              if (!r) why = 'short:unknown';
              else {
                why = 'short:' + r.kind;
                R.resetDist.push(Math.hypot(r.x - cx, r.z - cz));
                if (r.kind === 'turn') {
                  R.turnDeg.push(r.deg);
                  const u = Math.abs(w.axis === 'x' ? r.x - cx : r.z - cz), lat = Math.abs(w.axis === 'x' ? r.z - cz : r.x - cx);
                  const where = u <= 1.55 && lat < 0.5 ? 'approachCell' : Math.hypot(u - 1.6, lat) < 0.8 ? 'sidePoint' : u < 3.7 && lat < 0.5 ? 'inLane<3.7m' : 'elsewhere';
                  inc(R.turnAt, where);
                }
              }
              R.runD.push(p.runD);
            }
            inc(R.why, why); const lw2 = (dbg && dbg.luWhy) || 'x'; R.whyByLu[lw2] = R.whyByLu[lw2] || {}; inc(R.whyByLu[lw2], why + (S.lastReset && S.lastReset.kind === 'turn' ? '@' + Math.hypot(S.lastReset.x - cx, S.lastReset.z - cz).toFixed(1) + '/' + (S.lastReset.deg|0) : ''));
          }
          S.lastReset = null; S.hist = []; return;
        }
        if (s.vault) return;
        if (p.vault && !s.vault) { S.lastReset = { kind: 'landing', x: s.x, z: s.z }; return; }
        // run-up bookkeeping (mirrors match.js): a reset = the new runD isn't the old one plus this tick's move
        const ml = Math.hypot(s.x - p.x, s.z - p.z), rd = s.runD || 0;
        if (rd + 1e-6 < p.runD + ml || (p.runD === 0 && rd > 0 && rd <= ml + 1e-6)) {
          let kind;
          if (ml < 1e-6) { const mt = p.act && p.act.moveTo; kind = !mt ? 'stopped:noMove' : Math.hypot(mt.x - p.x, mt.z - p.z) < 0.15 ? 'stopped:arrived/hold' : 'stopped:blocked'; }
          else if (p.act && p.act.walk) kind = 'walk';
          else if (ml < 0.6 * step) kind = 'slowed';
          else kind = 'turn';
          {
            let deg = 0;
            if (kind === 'turn' && S.prevDir) deg = Math.acos(Math.max(-1, Math.min(1, ((s.x - p.x) * S.prevDir.x + (s.z - p.z) * S.prevDir.z) / ml))) * 180 / Math.PI;
            // a stop followed by moving again: the reset that matters is the stop (the new segment starts from standing)
            if (!(rd > 0 && S.lastReset && S.lastReset.kind.startsWith('stopped') && S.stoppedAt === m.tick - 1)) S.lastReset = { kind, x: p.x, z: p.z, deg };
            if (kind.startsWith('stopped')) S.stoppedAt = m.tick;
          }
        }
        (S.hist || (S.hist = [])).push({ ml, dx: ml > 1e-6 ? (s.x - p.x) / ml : 0, dz: ml > 1e-6 ? (s.z - p.z) / ml : 0, ok: !(p.act && p.act.walk) && ml >= 0.6 * step }); if (S.hist.length > 14) S.hist.shift();
        if (ml > 1e-6) S.prevDir = { x: (s.x - p.x) / ml, z: (s.z - p.z) / ml };
      });
    }
    for (const s of m.survivors) for (const [k, v] of Object.entries((s.brain.stats && s.brain.stats.lineup) || {})) inc(R.lineup, k, v);
    R.matches++;
  }
  return R;
}

const R = runFastVaultDiag({ n, seed0, maps, hp, sp });
const pct = (x) => (100 * x / Math.max(1, R.vaults)).toFixed(1) + '%';
const q = (arr) => { if (!arr.length) return '-'; const s = [...arr].sort((x, y) => x - y); return `p25 ${s[Math.floor(s.length * 0.25)].toFixed(2)} med ${s[Math.floor(s.length / 2)].toFixed(2)} p75 ${s[Math.floor(s.length * 0.75)].toFixed(2)}`; };
if (a.json) console.log(JSON.stringify(R));
else {
  console.log(`${R.matches} matches (seeds ${seed0}..${seed0 + n - 1}, ${a.map ?? 'maps/gas-heaven'}): chased window vaults ${R.vaults}  fast ${R.fast} (${pct(R.fast)})  medium ${R.medium} (${pct(R.medium)})  slow ${R.slow} (${pct(R.slow)})`);
  console.log(`counterfactual: fast if the run-up only had to keep every step within ${25} deg of the vault direction (README wording, no anchored first heading): ${R.readmeFast} (${pct(R.readmeFast)})`);
  console.log(`counterfactual: 45 deg cone (every step of the last 2.5 m within 45 deg): ${R.cone45} (${pct(R.cone45)});  2.5 m of uninterrupted running in any direction + last step within 45 deg: ${R.runFace45} (${pct(R.runFace45)})`);
  console.log('not fast, why (share of all chased window vaults):');
  for (const [k, v] of Object.entries(R.why).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${pct(v)}`);
  console.log('  turn location:', JSON.stringify(R.turnAt));
  console.log('  run-up at the vault (short ones, m):', q(R.runD));
  console.log('  distance from window centre where the final straight began (m):', q(R.resetDist));
  console.log('  turn angle at that reset (deg):', q(R.turnDeg));
  console.log('lineup decisions (running window crossings):', JSON.stringify(R.lineup));
  console.log('vault tier by the crossing lineup decision:', JSON.stringify(R.luWhy));
  if (a.whyLu) console.log(JSON.stringify(R.whyByLu[a.whyLu]));
  console.log('by brain mode (vaults / fast):', Object.entries(R.mode).map(([k, v]) => `${k} ${v}/${R.modeFast[k] || 0} (${(100 * (R.modeFast[k] || 0) / v).toFixed(0)}% fast)`).join('  '));
}
