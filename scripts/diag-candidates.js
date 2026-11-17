// Candidate-wreck bookkeeping check (MapKnowledge.cands): how often a survivor marks a public generator candidate as a
// wreck although it's one of the chosen gens (a false negative the brain must recover from by passing by later), and how
// many candidates / gens each survivor has resolved at 60 / 120 s. Observes engine state; never feeds it back.
// node scripts/diag-candidates.js [--n 16] [--map maps/gas-heaven] [--sp key=v,...]
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { loadMapPool } from '../src/hillclimb/maps.js';
const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains();
const hp = defaults(B.hunter.space), sp = defaults(B.survivor.space);
if (a.sp) for (const kv of a.sp.split(',')) { const [k, v] = kv.split('='); if (!(k in sp)) throw new Error(k); sp[k] = +v; }
const n = +(a.n ?? 16);
let falseWreck = 0, wrecks = 0, res60 = 0, known60 = 0, res120 = 0, known120 = 0, cnt = 0;
for (let i = 0; i < n; i++) {
  const seed = 1000 + i, brains = [], base = B.survivor.make(sp);
  const m = createMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: (ctx) => (brains[ctx.id] = base(ctx)) });
  const isGen = (c) => m.gens.some((g) => Math.abs(g.x - c.x) < 1 && Math.abs(g.z - c.z) < 1);
  while (!m.over) {
    m.step();
    if (m.tick === 600 || m.tick === 1200) for (const b of brains) {
      const r = [...b.know.candRes].filter((x) => x !== 0).length, kn = [...b.know.candRes].filter((x) => x === 1).length;
      if (m.tick === 600) { res60 += r; known60 += kn; cnt++; } else { res120 += r; known120 += kn; }
    }
  }
  for (const b of brains) b.know.cands.forEach((c, k) => { if (b.know.candRes[k] === -1) { wrecks++; if (isGen(c)) falseWreck++; } });
}
console.log(`wreck marks ${wrecks}, false (actually a gen) ${falseWreck} (${(100 * falseWreck / Math.max(1, wrecks)).toFixed(2)}%)`);
console.log(`per survivor: resolved@60 ${(res60 / cnt).toFixed(2)} (gens ${(known60 / cnt).toFixed(2)})  resolved@120 ${(res120 / cnt).toFixed(2)} (gens ${(known120 / cnt).toFixed(2)})`);
