#!/usr/bin/env node
// Scripted reflex scenario for the 'goal' survivor (survivor-goal.js): survivor 0 is the goal brain, its three teammates
// are put on hooks, the hunter idles far away. With the reflex
//     IF allOthersOut > 0.5 THEN rescue[crouch,covered] +6
// survivor 0 crouch-walks to a hook along covered steps; without it (defaults) it runs straight there.
// Also exported for scripts/test-sim.js.  Usage: node scripts/demo-reflex.js [--ticks 120]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { reflexGenes, decodeReflexes } from '../src/brains/survivor-goal.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// reflexes: [{ if, and?, goal, bonus, gait?, cover?, wait? }] (reflexGenes spec); hunterAt: where the hunter idles
export function reflexScenario({ reflexes = [], ticks = 120, hunterAt = { x: 44.5, z: 33.5 }, map } = {}) {
  map = map || JSON.parse(readFileSync(join(root, 'maps/test-small.json'), 'utf8'));
  const B = getBrains('param', 'goal');
  const sp = defaults(B.survivor.space);
  reflexes.forEach((r, k) => Object.assign(sp, reflexGenes(k, r)));
  const idle = () => ({ decide: () => ({}) });
  const m = createMatch({ map, seed: 3, hunter: () => ({ decide: () => ({}) }), survivors: [B.survivor.make(sp), idle, idle, idle] });
  const me = m.survivors[0];
  me.x = 24.5; me.z = 24.5;
  m.hunter.x = hunterAt.x; m.hunter.z = hunterAt.z;
  [[1, 1], [2, 2], [3, 7]].forEach(([id, h]) => { const s = m.survivors[id]; s.st = 3; m.hunter.carrying = id; m._hookSurvivor(s, m.hooks[h]); });
  const trace = [];
  for (let i = 0; i < ticks && !m.over; i++) {
    m.step();
    const a = me.lastAction || {};
    trace.push({ t: +m.t.toFixed(1), x: me.x, z: me.z, goal: me.brain.goal, crouch: !!a.crouch, crouched: !!me.crouch, walk: !!a.walk, act: a.act || null, moveTo: a.moveTo || null });
  }
  return { m, me, trace, stats: me.brain.goalStats, dbg: me.brain.debug(m.t), decoded: decodeReflexes(sp) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ti = process.argv.indexOf('--ticks'), ticks = ti > 0 ? +process.argv[ti + 1] : 120;
  for (const [name, reflexes] of [['defaults', []], ['reflex', [{ if: ['allOthersOut', '>', 0.5], goal: 'rescue', bonus: 6, gait: 'crouch', cover: true }]]]) {
    const r = reflexScenario({ reflexes, ticks });
    const n = r.trace.length, share = (k) => (100 * r.trace.filter((x) => x[k]).length / n).toFixed(0) + '%';
    console.log(`${name}: ${r.decoded.join(' | ') || '(no reflexes)'}`);
    console.log(`  goals ${[...new Set(r.trace.map((x) => x.goal))].join(',')}  crouch-action ${share('crouch')}  crouched ${share('crouched')}  rescues ${r.m.stats.rescues}  travelled to (${r.me.x.toFixed(1)}, ${r.me.z.toFixed(1)})`);
    console.log(`  modes ${JSON.stringify(r.stats.modes)}  reflex fired ${Array.from(r.stats.reflexFired)} won ${Array.from(r.stats.reflexWon)}`);
  }
}
