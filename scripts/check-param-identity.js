#!/usr/bin/env node
// Fingerprint of the 'param' survivor's play: full match results (events included) on fixed seeds for the default knobs
// and a few seeded random knob sets. Used to check that a refactor of survivor.js is behaviour-preserving:
//   node scripts/check-param-identity.js > before.txt   (on the old commit)
//   node scripts/check-param-identity.js > after.txt    (after the refactor) ; diff before.txt after.txt
// [--n 6] [--sets 3] [--survivor param] [--map maps/gas-heaven]
import { createHash } from 'node:crypto';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { runMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const maps = loadMapPool(a.map ?? 'maps/gas-heaven');
const B = getBrains('param', a.survivor ?? 'param');
const n = +(a.n ?? 6), sets = +(a.sets ?? 3);
// seeded random knob sets (mulberry32), so a refactor is also checked off the defaults (other branches active)
const mul = (s) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const paramSets = [defaults(B.survivor.space)];
for (let k = 1; k < sets; k++) {
  const r = mul(77 + k), p = {};
  for (const [key, [lo, hi]] of Object.entries(B.survivor.space)) p[key] = lo + (hi - lo) * r();
  paramSets.push(p);
}
const hp = defaults(B.hunter.space);
const all = createHash('sha256');
paramSets.forEach((sp, k) => {
  for (let i = 0; i < n; i++) {
    const seed = 4242 + 31 * i;
    const r = runMatch({ map: maps[seed % maps.length], seed, hunter: B.hunter.make(hp), survivors: B.survivor.make(sp) });
    const j = JSON.stringify(r), h = createHash('sha256').update(j).digest('hex').slice(0, 16);
    all.update(h);
    console.log(`set ${k} seed ${seed} ${h}  kills ${r.kills} esc ${r.escapes} gens ${r.gensDone} dur ${r.durationS}`);
  }
});
console.log('ALL ' + all.digest('hex').slice(0, 16));
