#!/usr/bin/env node
// Cross-play matrix: every hunter of a list of param sets against every survivor team of the list, on the same
// fixed held-out seeds (2^31 + i, never used for training; consecutive seeds walk the map pool).
//
// Usage: node scripts/crossplay.js --sets default,runs/evo-v14,runs/evo-v15[,runs/evo-v15@gen20][,v15=path]
//          [--hunters <sets>] [--survivors <sets>]   (override rows / columns separately)
//          [--n 32] [--seed-base 2147483648] [--map maps/gas-heaven] [--threads N] [--metrics f.js] [--json out.json]
//          [--mod genSeconds=80]   (game modifiers, src/sim/modifiers.js; warns when a set was trained under other rules)
// Set specs: see src/hillclimb/evalplan.js resolveParamSet. Archived params are clamped into TODAY's spaces and played
// by TODAY's brains (knobs missing from the archive take today's defaults; the report lists them).
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getBrains } from '../src/brains/index.js';
import { createPool } from '../src/hillclimb/pool.js';
import { resolveParamSet, heldOutSeeds, HELDOUT_BASE, summarize, gitInfo, mapPoolInfo, modMismatches } from '../src/hillclimb/evalplan.js';
import { modsFromArgv, modsRecord, describeMods } from '../src/sim/modifiers.js';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const list = (s) => String(s).split(',').filter(Boolean);
const mapPath = resolve(args.map ?? 'maps/gas-heaven');
const B = getBrains(args.hunter ?? 'param', args.survivor ?? 'param');
const spaces = { hunter: B.hunter.space, survivor: B.survivor.space };
const sets = list(args.sets ?? 'default');
const rows = list(args.hunters ?? sets).map((s) => resolveParamSet(s, spaces));
const cols = list(args.survivors ?? sets).map((s) => resolveParamSet(s, spaces));
const seeds = heldOutSeeds(+(args.n ?? 32), +(args['seed-base'] ?? HELDOUT_BASE));
const threads = +(args.threads ?? Math.max(1, cpus().length - 1));
const metrics = args.metrics ? list(args.metrics).map((p) => resolve(p)) : [];
const mods = modsFromArgv(argv);
if (Object.keys(mods).length) console.log(`GAME MODIFIERS: ${describeMods(mods)} (non-standard rules)`);
for (const w of new Set(modMismatches([...rows, ...cols], mods))) console.warn(w);

for (const s of [...new Map([...rows, ...cols].map((x) => [x.source, x])).values()]) for (const [side, st] of Object.entries(s.stale)) {
  if (st.missing.length || st.dropped.length) console.log(`note: ${s.name} ${side}: ${st.missing.length} knobs missing (today's default used), ${st.dropped.length} retired knobs dropped`);
}

const pool = createPool({ threads, mapPath, hunterBrain: args.hunter ?? 'param', survivorBrain: args.survivor ?? 'param', metrics, mods });
const jobs = [];
rows.forEach((h, hi) => cols.forEach((s, si) => { for (const seed of seeds) jobs.push({ seed, hunterParams: h.hunter, survivorParams: s.survivor, tag: { hi, si } }); }));
const t0 = Date.now();
console.log(`crossplay: ${rows.length} hunters x ${cols.length} survivor teams x ${seeds.length} held-out seeds = ${jobs.length} matches, ${threads} threads`);
const results = await pool.run(jobs);
pool.close();

const cells = rows.map((_, hi) => cols.map((_, si) => summarize(results.filter((r) => r.hi === hi && r.si === si))));
const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(16, ...rows.map((r) => r.name.length + 2), ...cols.map((c) => c.name.length + 2));
const table = (title, f) => {
  console.log(`\n${title}  (rows = hunter, columns = survivor team)`);
  console.log(pad('', w) + cols.map((c) => pad(c.name, w)).join(''));
  rows.forEach((r, hi) => console.log(pad(r.name, w) + cols.map((_, si) => pad(f(cells[hi][si]), w)).join('')));
};
table('kills / escapes', (c) => `${c.kills.toFixed(2)} / ${c.escapes.toFixed(2)}`);
table('gens done (gen-equivalents incl. partial)', (c) => `${c.gensDone.toFixed(2)} (${c.genProgress.toFixed(2)})`);
table('hunter fitness (table/100) / survivor fitness', (c) => `${c.hunterFit.toFixed(3)} / ${c.survivorFit.toFixed(3)}`);
table('duration s', (c) => c.durationS.toFixed(0));
if (cells[0][0].metrics) for (const k of Object.keys(cells[0][0].metrics)) table(`metric ${k}`, (c) => (c.metrics?.[k] ?? NaN).toFixed(3));
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);

if (args.json) writeFileSync(resolve(args.json), JSON.stringify({
  git: gitInfo(), ...modsRecord(mods), mapPool: mapPoolInfo(mapPath), seeds: { first: seeds[0], n: seeds.length },
  hunters: rows.map(({ name, source, stale, modifiers }) => ({ name, source, stale, modifiers })), survivors: cols.map(({ name, source, stale, modifiers }) => ({ name, source, stale, modifiers })), cells,
}, null, 2));
