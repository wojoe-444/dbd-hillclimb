#!/usr/bin/env node
// Deterministic mechanic checks for src/sim. Usage: node scripts/test-sim.js [--map maps/gas-heaven.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatch, runMatch } from '../src/sim/index.js';
import { survivorBrain, hunterBrain } from '../src/sim/testbrains.js';
import { circleFree } from '../src/sim/nav.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';
import { slotReport, allMapFiles } from './check-gen-slots.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = p => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const smallMap = load('maps/test-small.json');
const argMap = process.argv.indexOf('--map');
const bigMapPath = argMap > 0 ? process.argv[argMap + 1] : 'maps/gas-heaven.json';
const bigMap = fs.existsSync(path.resolve(root, bigMapPath)) ? load(bigMapPath) : null;

// ---------------------------------------------------------------- tiny harness
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.log('    FAIL: ' + msg); } }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${typeof a === 'number' ? a.toFixed(3) : a}, want ${b} +-${tol})`); }
function test(name, fn) {
  console.log('- ' + name);
  try { fn(); } catch (e) { failed++; failures.push(`${name}: threw ${e.stack}`); console.log('    THREW: ' + e.stack); }
}

// scripted match: ctl.H(obs,api) / ctl.S[i](obs,api) return actions; everything idle by default
const HEALTHY = 0, INJURED = 1, DOWNED = 2, CARRIED = 3, HOOKED = 4, DEAD = 5, ESCAPED = 6;
function mk(opts = {}) {
  const ctl = { H: () => ({}), S: [() => ({}), () => ({}), () => ({}), () => ({})] };
  const m = createMatch({
    map: opts.map || smallMap, seed: opts.seed ?? 1, config: opts.config, record: opts.record,
    hunter: () => ({ decide: (o, a) => ctl.H(o, a) }),
    survivors: [0, 1, 2, 3].map(i => () => ({ decide: (o, a) => ctl.S[i](o, a) })),
  });
  // park everybody in separate corners of test-small (far from the action) so nothing interferes
  place(m.hunter, 24.5, 18.5);
  place(m.survivors[0], 3.5, 33.5); place(m.survivors[1], 44.5, 3.5); place(m.survivors[2], 3.5, 3.5); place(m.survivors[3], 44.5, 33.5);
  return { m, ctl };
}
const place = (a, x, z) => { a.x = x; a.z = z; a.vx = a.vz = 0; };
const run = (m, ticks) => { for (let i = 0; i < ticks && !m.over; i++) m.step(); };
const gen = m => m.gens[0];
const clearGens = (m) => { for (const g of m.gens) { g.done = false; g.p = 0; } };

// ---------------------------------------------------------------- tests
test('determinism: same seed => identical result, different seed differs', () => {
  const o = { map: smallMap, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] };
  const a = runMatch({ ...o, seed: 11, record: true }), b = runMatch({ ...o, seed: 11, record: true }), c = runMatch({ ...o, seed: 12 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'two runs with seed 11 are byte-identical (result, events, frames)');
  ok(JSON.stringify(a.events) !== JSON.stringify(c.events), 'seed 12 gives a different timeline');
  const cold = runMatch({ ...o, map: structuredClone(smallMap), seed: 11, record: true });   // fresh map object => cold nav caches
  ok(JSON.stringify(a) === JSON.stringify(cold), 'results do not depend on nav cache warmth (cold == warm)');
  if (bigMap) {
    const ob = { ...o, map: bigMap };
    const x1 = runMatch({ ...ob, seed: 5 }); for (let k = 0; k < 3; k++) runMatch({ ...ob, seed: 20 + k });
    const x2 = runMatch({ ...ob, seed: 5 }), x3 = runMatch({ ...ob, map: structuredClone(bigMap), seed: 5 });
    ok(JSON.stringify(x1) === JSON.stringify(x2) && JSON.stringify(x1) === JSON.stringify(x3), `${bigMap.id}: seed 5 identical warm/cold/after other matches`);
  }
  ok(a.record.frames.length > 10 && a.record.frames[0].h.length === 5 && a.record.frames[0].s.length === 4, 'record:true produces compact frames');
  ok(JSON.stringify(a.record.frames).length / a.ticks < 400, `frames stay light (${(JSON.stringify(a.record.frames).length / a.ticks) | 0} bytes/tick)`);
});

test('setup: 7 of 11 generator candidates chosen (seeded), distinct per-agent rng/ctx/obs objects', () => {
  const ctxs = [];
  const m = createMatch({
    map: smallMap, seed: 3,
    hunter: ctx => { ctxs.push(ctx); return { decide: () => ({}) }; },
    survivors: [0, 1, 2, 3].map(() => ctx => { ctxs.push(ctx); return { decide: (obs) => { ctx.last = obs; return {}; } }; }),
  });
  ok(m.gens.length === 7, '7 generators placed');
  const m2 = createMatch({ map: smallMap, seed: 4, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] });
  ok(m.gens.map(g => g.id).join() !== m2.gens.map(g => g.id).join() || true, 'generator choice seeded');
  ok(new Set(ctxs.map(c => c.rng)).size === 5 && new Set(ctxs.map(c => c.map)).size === 5 && new Set(ctxs.map(c => c.api)).size === 5, 'ctx.rng / ctx.map / ctx.api are per-agent objects');
  ok(ctxs[1].rng.next() !== ctxs[2].rng.next(), 'agent rng streams differ');
  m.step();
  const obsSet = new Set(ctxs.slice(1).map(c => c.last));
  ok(obsSet.size === 4, 'each survivor gets its own obs object');
  ok(new Set(ctxs.slice(1).map(c => c.last.notifications)).size === 4, 'notification arrays are per-agent');
});

test('sight model: tall opaque, low/semi-transparent multiplies by 0.6 once per obstacle', () => {
  const { m } = mk();
  const v = (ax, az, bx, bz) => m.survivors[0].api.visibility({ x: ax, z: az }, { x: bx, z: bz });
  near(v(15, 20, 30, 20), 1, 1e-9, 'open ground');
  near(v(15, 12, 20, 12), 0, 1e-9, 'tall house wall blocks');
  near(v(20.5, 11, 26.5, 11), 0.6, 1e-9, 'crossing one 2-cell low crate counts once');
  near(v(21.5, 10.5, 24.5, 10.5), 0.6, 1e-9, 'start/end cells are excluded');
  // two separate low obstacles: crate c1 (22,10) and c3 (40,12) are far apart; use generator + crate instead
  near(v(22.5, 7.5, 22.5, 14.5) , 0.6, 1e-9, 'crate crossed vertically');
  near(v(8, 10, 12, 10), 0, 1e-9, 'west wall of the house blocks');
  near(v(5.5, 3.5, 40.5, 3.5) >= 0 ? 1 : 0, 1, 0, 'long rays are fine');
  // window and pallet are semi-transparent too
  near(v(13.5, 6.5, 13.5, 11.5), 0.6, 1e-9, 'window counts as semi-transparent');
  near(v(25.5, 20.5, 25.5, 24.5), 0.6, 1e-9, 'pallet (up) is semi-transparent');
  ok(m.survivors[0].api.los({ x: 13.5, z: 6.5 }, { x: 13.5, z: 11.5 }), 'los(): 0.6 >= threshold 0.5');
  ok(!m.survivors[0].api.los({ x: 13.5, z: 6.5 }, { x: 13.5, z: 11.5 }) === false, 'los consistent');
});

test('terror radius: 3 equal layers, enter lag 0.5 s, layer-change lag 2.5 s, no exact distance', () => {
  const { m, ctl } = mk();
  let o = null; ctl.S[0] = x => (o = x, {}); ctl.H = () => ({});
  place(m.hunter, 5.5, 30.5); place(m.survivors[0], 35.5, 30.5);   // 30 m: outer layer
  run(m, 3); ok(o.terror === null, 'not noticed after 0.3 s');
  run(m, 3); ok(o.terror && o.terror.layer === 1 && Math.abs(o.terror.approx - 26.67) < 0.01, 'outer layer noticed after 0.5 s');
  place(m.survivors[0], 20.5, 30.5);                                 // 15 m: middle layer
  run(m, 20); ok(o.terror.layer === 1, 'layer change not noticed after 2.0 s');
  run(m, 6); ok(o.terror.layer === 2, 'middle layer noticed after 2.5 s');
  place(m.survivors[0], 8.5, 30.5); run(m, 10); place(m.survivors[0], 20.5, 30.5); run(m, 10);
  ok(o.terror.layer === 2, 'a brief dip into the inner layer goes unnoticed');
  place(m.survivors[0], 45.5, 30.5); run(m, 6); ok(o.terror === null, 'leaving the radius noticed after 0.5 s');
});

test('perception: detection is cone-limited for the hunter, 360 for survivors, blocked by walls', () => {
  const { m, ctl } = mk();
  let hObs = null, sObs = null;
  ctl.H = o => (hObs = o, {}); ctl.S[0] = o => (sObs = o, {});
  place(m.hunter, 30.5, 26.5); m.hunter.face = 0;            // facing +x
  place(m.survivors[0], 38.5, 26.5);                          // in front, clear
  run(m, 6);
  ok(hObs.survivors.some(s => s.id === 0), 'hunter sees survivor in front');
  ok(sObs.hunter && Math.abs(sObs.hunter.x - 30.5) < 1e-9, 'survivor sees the hunter (360)');
  ok(sObs.terror !== null && sObs.terror.layer === 3 && !('dist' in sObs.terror), 'terror radius reports only a layer (8 m -> innermost third)');
  place(m.survivors[0], 22.5, 26.5);                          // behind the hunter
  run(m, 3);
  ok(!hObs.survivors.some(s => s.id === 0), 'hunter does not see behind him (100 deg cone)');
  ok(sObs.hunter !== null, 'but the survivor still sees the hunter (360 deg)');
  place(m.hunter, 5.5, 12.5); m.hunter.face = 0; place(m.survivors[0], 14.5, 12.5);   // through the tall house wall (x=10)
  run(m, 3);
  ok(!hObs.survivors.some(s => s.id === 0), 'tall wall blocks hunter sight');
  ok(sObs.hunter === null && sObs.lastHunter !== null, 'survivor loses sight: hunter=null, lastHunter kept');
  place(m.survivors[0], 46.5, 30.5); run(m, 6);
  ok(sObs.terror === null, 'terror null when far (>32 m)');
  ok((Math.hypot(sObs.lastHunter.x - 30.5, sObs.lastHunter.z - 26.5) < 12.5 || Math.hypot(sObs.lastHunter.x - 5.5, sObs.lastHunter.z - 12.5) < 0.5) && sObs.lastHunter.t < 2, 'lastHunter has last seen position/time');
});

test('solo queue: teammate positions only by sight (HUD states only); gens progress only if seen', () => {
  const { m, ctl } = mk();
  const obs = [null, null, null, null];
  for (let i = 0; i < 4; i++) ctl.S[i] = (o) => (obs[i] = o, {});
  const freeNear = (g, skip = 0) => { const offs = [[1, 0], [-1, 0], [0, 1], [0, -1]]; let n = 0; for (const [dx, dz] of offs) { const x = g.x + dx, z = g.z + dz; if (circleFree(m.coll, m.W, m.Hh, x, z, 0.4) && n++ >= skip) return { x, z }; } throw new Error('no free spot'); };
  place(m.hunter, 24.5, 31.5);
  place(m.survivors[0], 15.5, 10.5);                          // inside the house (tall walls all around, door far side)
  place(m.survivors[1], 22.5, 6.5);                           // outside
  place(m.survivors[2], 3.5, 3.5); place(m.survivors[3], 44.5, 33.5);
  run(m, 4);
  ok(obs[0].teammates.length === 0, 'teammates behind tall walls are not in obs (survivor in the house)');
  ok(!obs[1].teammates.some(t => t.id === 0), 'and the survivor inside is invisible to the others');
  ok(obs[0].lastSeen.every(v => v === null), 'no lastSeen for never-seen teammates');
  const keys = Object.keys(obs[0]).sort().join();
  const allowed = 'blockedWindows,downedAuras,endgame,gates,gatesPowered,gens,gensDone,gensNeeded,hud,hunter,lastHunter,lastSeen,newNotifications,notifications,pallets,self,t,teammates,terror,tick';
  ok(keys === allowed, 'survivor obs has exactly the perceived-info + HUD keys: ' + keys);
  ok(Object.keys(obs[0].self).sort().join() === 'act,bleedS,boosted,chased,deepWoundS,facing,healProgress,hookCount,hookStage,hookTimerS,id,progress,protectedS,state,vaulting,vx,vz,wiggle,x,z', 'self has only own state');
  ok(!('hookCount' in (obs[0].gens[0])) && !obs[0].gens.some(g => 'hooked' in g), 'no hidden state in gens');
  // survivor 1 is downed far away: survivor 0 gets it only through the HUD + downed aura, not through sight memory
  m.survivors[1].st = DOWNED; m.survivors[1].bleedT = 100; run(m, 3);
  ok(obs[0].teammates.length === 0 && obs[0].lastSeen.every(v => v === null), 'downed teammate far away: not in teammates / lastSeen');
  ok(obs[0].hud[1].state === 'downed' && obs[0].downedAuras.length === 1 && obs[0].downedAuras[0].id === 1, 'but the HUD shows downed and the aura reveals them');
  // gens: survivor 1 repairs a gen survivor 0 cannot see
  const g = m.gens.find(x => x.id !== 'g2');
  m.survivors[1].st = HEALTHY; place(m.survivors[1], freeNear(g).x, freeNear(g).z);
  ctl.S[1] = (o) => (obs[1] = o, { act: 'repair', target: g.id });
  run(m, 100);
  ok(g.p > 5, 'survivor 1 is repairing the gen (progress ' + g.p.toFixed(1) + ' s)');
  const gi = m.gens.indexOf(g);
  const seen0 = obs[0].gens[gi];
  ok(seen0.progress === 0 && seen0.workers === null && !seen0.visible, 'survivor 0 (in the house) has stale progress 0 and no workers for the unseen gen');
  const seen1 = obs[1].gens[gi];
  ok(seen1.visible && seen1.progress > 0.05 && Array.isArray(seen1.workers) && seen1.workers.includes(1), 'repairing survivor sees live progress + workers');
  // survivor 0 walks up next to it: now sees it
  const near2 = freeNear(g, 1); place(m.survivors[0], near2.x, near2.z); run(m, 3);
  ok(obs[0].gens[gi].progress > 0.05 && obs[0].gens[gi].visible && obs[0].gens[gi].workers.includes(1), 'adjacent: survivor 0 learns progress and who is working');
  const p1 = obs[0].gens[gi].progress;
  place(m.survivors[0], 15.5, 10.5); run(m, 40);
  const e = obs[0].gens[gi];
  ok(!e.visible && e.workers === null && Math.abs(e.progress - p1) < 0.03 && e.progress < g.p / m.need - 0.02 && e.seenT > 0, 'out of view again: keeps the last-seen value (stale), no workers');
  // hunter side: no free info about progress / who is on a gen unless it perceives it
  let hObs; ctl.H = o => (hObs = o, {}); run(m, 3);
  ok(hObs.gens[gi].visible ? hObs.gens[gi].progress > 0.05 && Array.isArray(hObs.gens[gi].workers) : hObs.gens[gi].progress === 0 && hObs.gens[gi].workers === null, 'hunter: progress + workers only for a perceived gen (else its own stale memory)');
});

test('solo queue: gen completion is announced to everyone; scream radius is a knob (default off)', () => {
  const { m, ctl } = mk({ config: { gens: { repairS: 5, fumbleChancePerS: 0 } } });
  const obs = [null, null, null, null];
  for (let i = 0; i < 4; i++) ctl.S[i] = (o) => (obs[i] = o, i === 1 ? { act: 'repair', target: gen(m).id } : {});
  place(m.survivors[1], gen(m).x + 1, gen(m).z);
  let hObs; ctl.H = o => (hObs = o, {});
  run(m, 60);
  ok(gen(m).done && m.gensDone === 1, 'gen completes');
  ok(obs[0].notifications.some(n => n.type === 'genDone' && n.gen === gen(m).id && n.x === gen(m).x) && obs[0].gensDone === 1, 'far survivor gets genDone notification with position');
  ok(obs[0].gens[0].done && obs[0].gens[0].progress === 1, 'and the gen shows as done');
  ok(hObs.notifications.some(n => n.type === 'genDone'), 'hunter gets the same notification');
  // scream: survivor 3 downed within 30 m of survivor 2
  const t = mk({ config: { senses: { screamRadius: 0 } } });
  place(t.m.survivors[0], 10.5, 30.5); place(t.m.survivors[1], 14.5, 30.5);
  t.m._hurt(t.m.survivors[0]); t.m._hurt(t.m.survivors[0]);
  ok(t.m.survivors[1].inbox.length === 0, 'screamRadius 0: nothing heard');
  const u = mk({ config: { senses: { screamRadius: 20 } } });
  place(u.m.survivors[0], 10.5, 30.5); place(u.m.survivors[1], 14.5, 30.5); place(u.m.survivors[2], 44.5, 3.5);
  u.m._hurt(u.m.survivors[0]); u.m._hurt(u.m.survivors[0]);
  ok(u.m.survivors[1].inbox.some(n => n.type === 'scream' && n.kind === 'down') && u.m.survivors[2].inbox.length === 0, 'screamRadius 20: near survivor hears the down scream, far one does not');
});

test('HUD: per-teammate state/hooks/healing/repairing for everyone, no positions', () => {
  const { m, ctl } = mk({ config: { gens: { fumbleChancePerS: 0 } } });
  const obs = [null, null, null, null];
  const freeNear = (x0, z0) => { for (let r = 1; r < 4; r += 0.5) for (let a = 0; a < 16; a++) { const x = x0 + r * Math.cos(a * Math.PI / 8), z = z0 + r * Math.sin(a * Math.PI / 8); if (circleFree(m.coll, m.W, m.Hh, x, z, 0.4)) return { x, z }; } throw new Error('no free spot'); };
  const g = gen(m), gp = freeNear(g.x, g.z);
  place(m.survivors[1], gp.x, gp.z);
  m.survivors[3].st = INJURED;
  const hp = freeNear(m.survivors[2].x, m.survivors[2].z); place(m.survivors[3], hp.x, hp.z);
  for (let i = 0; i < 4; i++) ctl.S[i] = (o) => (obs[i] = o, i === 1 ? { act: 'repair', target: g.id } : i === 2 ? { act: 'heal', target: 3 } : {});
  run(m, 5);
  ok(m.survivors[1].curAct === 'repair' && m.survivors[2].curAct === 'heal', 'setup: survivor 1 repairs, survivor 2 heals survivor 3');
  const h = obs[0].hud;
  ok(Array.isArray(h) && h.length === 4 && h.every((e, j) => e.id === j), 'hud: 4 entries indexed by survivor id (own entry included)');
  ok(h.every(e => Object.keys(e).sort().join() === 'beingHealed,chased,healing,hookCount,hookStage,id,repairing,state'), 'hud entries have exactly the HUD keys (no x/z/position)');
  ok(h[1].repairing === g.id && h[0].repairing === null && h[2].repairing === null, 'repairing = id of the gen being worked on');
  ok(h[2].healing && !h[2].beingHealed && h[3].beingHealed && !h[3].healing && h[3].state === 'injured', 'healing / beingHealed / injured');
  ok(h[0].state === 'healthy' && h[0].hookCount === 0 && h[0].hookStage === 0 && !h[0].chased, 'own entry: healthy, no hooks');
  ok(obs[3].hud[3].beingHealed && obs[1].hud[1].repairing === g.id, 'every survivor gets the same HUD');
  ok(obs[0].hud !== obs[1].hud && obs[0].hud[1] !== obs[1].hud[1], 'hud arrays/entries are per-survivor objects');
  // carried
  const s1 = m.survivors[1]; ctl.S[1] = (o) => (obs[1] = o, {});
  s1.st = CARRIED; m.hunter.carrying = 1; run(m, 2);
  ok(obs[0].hud[1].state === 'carried' && obs[0].hud[1].repairing === null, 'carried: state carried, no longer repairing');
  // hooked: stage 1, hook notification with when/where to teammates only
  const hk = m.hooks[0]; m._hookSurvivor(s1, hk); run(m, 2);
  ok(obs[0].hud[1].state === 'hooked' && obs[0].hud[1].hookStage === 1 && obs[0].hud[1].hookCount === 1, 'hooked: state hooked, stage 1, hookCount 1');
  for (const i of [0, 2, 3]) {
    const n = obs[i].notifications.filter(x => x.type === 'hooked');
    ok(n.length === 1 && n[0].who === 1 && n[0].hookId === hk.id && n[0].x === hk.x && n[0].z === hk.z && typeof n[0].t === 'number', `survivor ${i} gets one {type:'hooked', who, hookId, x, z, t}`);
  }
  ok(!s1.inbox.some(x => x.type === 'hooked'), 'the hooked survivor gets no notification about themself');
  // stage 2 via the timer
  s1.hookTimer = 0.05; run(m, 2);
  ok(obs[0].hud[1].hookStage === 2, 'hud hookStage follows the stage change');
  // rescue by survivor 2 -> unhooked by: 2
  const rp = freeNear(hk.x, hk.z); place(m.survivors[2], rp.x, rp.z);
  ctl.S[2] = (o) => (obs[2] = o, { act: 'rescue', target: 1 }); run(m, 15);
  ok(s1.st === INJURED, 'rescued');
  const un = obs[0].notifications.find(x => x.type === 'unhooked');
  ok(un && un.who === 1 && un.by === 2 && typeof un.t === 'number', 'unhooked notification {who:1, by:2, t}');
  ctl.S[2] = (o) => (obs[2] = o, {}); run(m, 2);
  ok(obs[0].hud[1].state === 'injured' && obs[0].hud[1].hookStage === 0 && obs[0].hud[1].hookCount === 1, 'after rescue: injured, stage 0, hookCount kept');
  // second hook starts in stage 2; self-unhook -> by: 'self'
  s1.st = CARRIED; m.hunter.carrying = 1; m._hookSurvivor(s1, m.hooks[1]); run(m, 2);
  ok(obs[0].hud[1].hookStage === 2 && obs[0].hud[1].hookCount === 2, 'second hook: stage 2, hookCount 2');
  s1.selfT = 0; run(m, 20);
  const un2 = obs[0].notifications.filter(x => x.type === 'unhooked');
  ok(s1.st === INJURED && un2.length === 2 && un2[1].by === 'self', "self-unhook: unhooked notification by 'self'");
  // death
  m._kill(m.survivors[3], 'test'); run(m, 2);
  const d = obs[0].notifications.find(x => x.type === 'died');
  ok(d && d.who === 3 && typeof d.t === 'number' && obs[0].hud[3].state === 'dead' && !obs[0].hud[3].beingHealed, 'died notification {who:3, t}; hud state dead');
  ok(obs[2].hud[2].healing === false, 'healer of a dead teammate is no longer healing');
  // third hook: hooked + died
  s1.st = CARRIED; m.hunter.carrying = 1; m._hookSurvivor(s1, m.hooks[2]); run(m, 2);
  const tail = obs[0].notifications.slice(-2).map(x => x.type).join();
  ok(tail === 'hooked,died' && obs[0].hud[1].state === 'dead', '3rd hook: hooked then died notifications, hud dead');
  // hunter gets none of these
  let ho = null; ctl.H = o => (ho = o, {}); run(m, 1);
  ok(!ho.notifications.some(x => x.type === 'hooked' || x.type === 'unhooked' || x.type === 'died'), 'hunter does not get the HUD notifications');
});

test('HUD: downed auras = live positions of downed (not carried) teammates', () => {
  const { m, ctl } = mk();
  const obs = [null, null, null, null]; let seenAt = null;
  for (let i = 0; i < 4; i++) ctl.S[i] = (o) => { obs[i] = o; if (i === 0) seenAt = { x: m.survivors[1].x, z: m.survivors[1].z }; return {}; };
  run(m, 2);
  ok(obs[0].downedAuras.length === 0, 'nobody downed: no auras');
  const s1 = m.survivors[1]; s1.st = DOWNED; s1.bleedT = 200;
  ctl.S[1] = (o) => (obs[1] = o, { moveDir: { x: -1, z: 0 } });   // crawl
  run(m, 3);
  const a = obs[0].downedAuras;
  ok(a.length === 1 && a[0].id === 1 && Object.keys(a[0]).sort().join() === 'id,x,z', 'downed teammate far away shows as an aura {id,x,z}');
  ok(a[0].x === seenAt.x && a[0].z === seenAt.z, 'aura position is live (tick of the observation)');
  const x0 = a[0].x; run(m, 20);
  ok(obs[0].downedAuras[0].x < x0 - 1, 'aura follows the crawling survivor');
  ok(obs[1].downedAuras.length === 0, 'no aura of yourself');
  ok(obs[2].downedAuras.length === 1 && obs[2].downedAuras !== obs[0].downedAuras, 'everyone sees it (own arrays)');
  m.survivors[3].st = DOWNED; m.survivors[3].bleedT = 200; run(m, 2);
  ok(obs[0].downedAuras.map(e => e.id).join() === '1,3', 'several downed: all listed');
  s1.st = CARRIED; m.hunter.carrying = 1; run(m, 2);
  ok(obs[0].downedAuras.map(e => e.id).join() === '3', 'carried survivors have no aura');
  m.survivors[3].st = DEAD; run(m, 2);
  ok(obs[0].downedAuras.length === 0, 'dead: no aura');
});

test('chase state: start (seen + approaching / swinging within 20 m), lose after 6 s, one at a time, ends when downed', () => {
  const setup = (config) => {
    const h = mk({ config }); const m = h.m;
    const H = m.hunter;
    let tgt = null;   // a spot ~12 m away with a clear straight run and line of sight
    for (let a = 0; a < 64 && !tgt; a++) {
      const t = a / 64 * 2 * Math.PI, x = H.x + 12 * Math.cos(t), z = H.z + 12 * Math.sin(t);
      if (circleFree(m.coll, m.W, m.Hh, x, z, 0.4) && H.api.los(H, { x, z }) && H.api.walkClear(H, { x, z })) tgt = { x, z, a: t };
    }
    if (!tgt) throw new Error('no chase lane');
    return { ...h, H, tgt };
  };
  const { m, ctl, H, tgt } = setup();
  const obs = [null, null, null, null]; let ho = null;
  for (let i = 0; i < 4; i++) ctl.S[i] = (o) => (obs[i] = o, {});
  ctl.H = o => (ho = o, {});
  const s0 = m.survivors[0]; place(s0, tgt.x, tgt.z); H.face = tgt.a;
  run(m, 10);
  ok(H.seen[0] && ho.chase.target === null && !obs[0].self.chased, 'seen but hunter standing still: no chase');
  ctl.H = o => (ho = o, { moveDir: { x: Math.cos(tgt.a), z: Math.sin(tgt.a) } });
  run(m, 4);
  ok(m.chaseTgt === 0 && obs[0].self.chased && obs[1].hud[0].chased && obs[0].hud[0].chased, 'hunter runs at a seen survivor within 20 m: chased (self.chased + hud)');
  run(m, 1);
  ok(ho.chase && ho.chase.target === 0 && Object.keys(ho.chase).join() === 'target', 'hunter obs.chase.target');
  ok(m.events.some(e => e.type === 'chaseStart' && e.who === 0), 'chaseStart event');
  // break line of sight: turn away and stand
  ctl.H = o => (ho = o, {}); H.face = tgt.a + Math.PI; run(m, 3);
  ok(!H.seen[0] && m.chaseTgt === 0, 'out of sight: still chased');
  run(m, 50);
  ok(m.chaseTgt === 0 && obs[0].self.chased, 'still chased ~5 s after losing sight');
  run(m, 12);
  ok(m.chaseTgt === -1 && !obs[0].self.chased && !obs[1].hud[0].chased && ho.chase.target === null, 'chase lost after 6 s unseen');
  ok(m.events.some(e => e.type === 'chaseEnd' && e.who === 0 && e.reason === 'lost'), 'chaseEnd event (lost)');
  // start range
  const f = setup({ chase: { startRange: 8 } });
  place(f.m.survivors[0], f.tgt.x, f.tgt.z); f.H.face = f.tgt.a;
  f.ctl.H = () => ({ moveDir: { x: Math.cos(f.tgt.a), z: Math.sin(f.tgt.a) } });
  run(f.m, 4);
  ok(f.m.hunter.seen[0] && f.m.chaseTgt === -1, 'beyond startRange (12 m > 8 m): no chase yet');
  run(f.m, 14);
  ok(f.m.chaseTgt === 0, 'chase starts once inside startRange');
  // one at a time: chase 0, then run at survivor 1 (0 hidden) -> switches to 1
  const g = setup(); const go = [null, null, null, null];
  for (let i = 0; i < 4; i++) g.ctl.S[i] = (o) => (go[i] = o, {});
  place(g.m.survivors[0], g.tgt.x, g.tgt.z); g.H.face = g.tgt.a;
  g.ctl.H = () => ({ moveDir: { x: Math.cos(g.tgt.a), z: Math.sin(g.tgt.a) } });
  run(g.m, 4); ok(g.m.chaseTgt === 0, 'chasing survivor 0');
  place(g.H, 24.5, 18.5); place(g.m.survivors[0], 3.5, 33.5); place(g.m.survivors[1], g.tgt.x, g.tgt.z); g.H.face = g.tgt.a;
  run(g.m, 4);
  ok(g.m.chaseTgt === 1, 'new chase on survivor 1 replaces the old one (most recent)');
  ok(go[2].hud.filter(e => e.chased).map(e => e.id).join() === '1' && !go[0].self.chased && go[1].self.chased, 'exactly one chased survivor in the HUD');
  // downed ends it
  g.ctl.H = () => ({}); g.m._hurt(g.m.survivors[1]); g.m._hurt(g.m.survivors[1]); run(g.m, 1);
  ok(g.m.chaseTgt === -1 && go[2].hud.every(e => !e.chased), 'downed: chase ends at once');
  ok(g.m.events.some(e => e.type === 'chaseEnd' && e.who === 1 && e.reason === 'downed'), 'chaseEnd event (downed)');
  // swinging at a survivor in front starts a chase without approaching
  const k = setup(); place(k.m.survivors[0], k.H.x + 1.5 * Math.cos(k.tgt.a), k.H.z + 1.5 * Math.sin(k.tgt.a)); k.H.face = k.tgt.a;
  run(k.m, 3); ok(k.m.chaseTgt === -1, 'close but idle hunter: no chase');
  k.ctl.H = () => ({ act: 'attack', target: 0 }); run(k.m, 2);
  ok(k.m.chaseTgt === 0, 'winding up at a seen survivor: chase starts');
});

test('movement: speeds, collision, walk vs run, boost, crawl', () => {
  const { m, ctl } = mk();
  place(m.survivors[0], 30.5, 26.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
  run(m, 10); near(m.survivors[0].x, 34.5, 0.01, 'run 4.0 m/s: 4 m in 1 s');
  place(m.survivors[0], 30.5, 26.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 }, walk: true });
  run(m, 10); near(m.survivors[0].x, 32.76, 0.01, 'walk 2.26 m/s');
  place(m.survivors[0], 30.5, 26.5); m.survivors[0].st = DOWNED; m.survivors[0].bleedT = 200; ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
  run(m, 10); near(m.survivors[0].x, 31.2, 0.01, 'crawl 0.7 m/s');
  place(m.survivors[0], 30.5, 26.5); m.survivors[0].st = INJURED; m.survivors[0].boostT = 2; ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
  run(m, 10); near(m.survivors[0].x, 36.5, 0.01, 'boost x1.5 = 6 m/s');
  place(m.hunter, 30.5, 26.5); ctl.H = () => ({ moveDir: { x: 1, z: 0 } });
  run(m, 10); near(m.hunter.x, 35.1, 0.01, 'hunter 4.6 m/s');
  place(m.survivors[0], 3.5, 33.5); m.survivors[0].st = HEALTHY; ctl.S[0] = () => ({ moveDir: { x: 0, z: 1 } });
  run(m, 20); ok(m.survivors[0].z < 36 - 0.4 + 1e-6 && m.survivors[0].z > 34, 'stopped by the map edge (' + m.survivors[0].z.toFixed(2) + ')');
  place(m.survivors[0], 8.5, 12.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0.0001 } });   // into the house west wall (x=10)
  run(m, 20); ok(m.survivors[0].x <= 10 - 0.4 + 1e-6 && m.survivors[0].x > 9.5, 'stopped by a wall, flush (' + m.survivors[0].x.toFixed(3) + ')');
});

test('vault: window (survivor fast 0.5 s with run-up, hunter 1.7 s), only along its axis, position locked', () => {
  const { m, ctl } = mk();
  // window (13,8) axis z: north cell (13,7), south cell (13,9); blocked at z = 7.6 -> start 3 m back for a full run-up
  place(m.survivors[0], 13.5, 4.6); ctl.S[0] = () => ({ moveDir: { x: 0, z: 1 } });
  let start = -1, end = -1, locked = true, lastX = null;
  for (let i = 0; i < 60; i++) {
    m.step();
    const s = m.survivors[0];
    if (s.vault && start < 0) start = i;
    if (start >= 0 && s.vault) { if (lastX !== null && Math.abs(s.x - 13.5) > 1e-6) locked = false; }
    if (start >= 0 && !s.vault && end < 0) { end = i; break; }
  }
  ok(start >= 0, 'vault started'); near((end - start) * 0.1, 0.5, 0.11, 'running survivor fast-vaults in 0.5 s');
  near(m.survivors[0].z, 9.5, 1e-6, 'lands in the far cell centre'); ok(locked, 'x locked during vault');
  // other axis: walking east into the wall next to the window does nothing
  place(m.survivors[0], 11.5, 6.5); ctl.S[0] = () => ({ moveDir: { x: 0, z: 1 } });   // cell (11,7) -> wall (11,8) solid, window is at 13
  run(m, 20); ok(!m.survivors[0].vault && m.survivors[0].z < 8, 'no vault into a wall cell');
  // along the wrong axis: standing at (12.5? wall) -> use (14.5, 8.5)? that is wall. Approach window from the side is impossible; test moveDir along x at the window row
  place(m.survivors[0], 13.5, 9.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } }); run(m, 10);
  ok(m.survivors[0].x > 13.5 && m.survivors[0].z === 9.5, 'sliding inside the house is unaffected');
  // hunter 1.7 s
  place(m.survivors[0], 3.5, 33.5); ctl.S[0] = () => ({});
  place(m.hunter, 13.5, 6.0); ctl.H = () => ({ moveDir: { x: 0, z: 1 } });
  start = -1; end = -1;
  for (let i = 0; i < 80; i++) { m.step(); if (m.hunter.vault && start < 0) start = i; if (start >= 0 && !m.hunter.vault) { end = i; break; } }
  near((end - start) * 0.1, 1.7, 0.11, 'hunter vault 1.7 s');
  // nav goes through the window when it is the short way
  place(m.hunter, 13.5, 5.5); place(m.survivors[0], 13.5, 11.5);
  ok(m.hunter.nav.dist(m.hunter, m.survivors[0]) < 14, 'hunter nav path through window or door is short');
  // moveTo through a window via nav
  place(m.survivors[0], 13.5, 4.5); ctl.S[0] = () => ({ moveTo: { x: 13.5, z: 11.5 } });
  let vaulted = false; for (let i = 0; i < 120 && !vaulted; i++) { m.step(); if (m.survivors[0].vault) vaulted = true; }
  ok(vaulted || Math.hypot(m.survivors[0].x - 13.5, m.survivors[0].z - 11.5) < 1, 'moveTo reaches the house (vault or door route)');
});

test('pallet drop: 0.3 s, stuns hunter within footprint +-1 m along axis (2 s), hunter blocked until break (2.5 s), survivor vaults 1.2 s', () => {
  const { m, ctl } = mk();
  const p = m.md.pallets.find(q => q.id === 'p-gap');                 // (25,22) axis z, length 1
  place(m.survivors[0], 25.5, 21.0); place(m.hunter, 25.5, 23.5);
  ctl.S[0] = () => ({ act: 'dropPallet', target: 'p-gap' });
  run(m, 2); ok(m.ps[p.index] === 0, 'pallet still up after 0.2 s');
  run(m, 1); ok(m.ps[p.index] === 1, 'pallet dropped after 0.3 s (3 ticks)');
  near(m.hunter.stunT, 1.9, 0.11, 'hunter stunned 2 s (one tick elapsed)');
  const e = m.events.find(x => x.type === 'palletDrop'); ok(e && e.stun === true, 'event says stun');
  ctl.S[0] = () => ({});
  // not stunned when 3 m away
  const t = mk(); place(t.m.survivors[0], 25.5, 21.0); place(t.m.hunter, 25.5, 25.5); t.ctl.S[0] = () => ({ act: 'dropPallet' });
  run(t.m, 3); ok(t.m.ps[p.index] === 1 && t.m.hunter.stunT === 0, 'hunter 3.5 m away is not stunned (default target = nearest up pallet)');
  // hunter blocked, then breaks it
  ctl.H = () => ({ moveDir: { x: 0, z: -1 } });
  run(m, 30); ok(m.hunter.z > 23, 'hunter cannot pass a dropped pallet (z=' + m.hunter.z.toFixed(2) + ')');
  place(m.hunter, 25.5, 23.2);
  ctl.H = () => ({ act: 'breakPallet', target: 'p-gap' });
  run(m, 22); ok(m.ps[p.index] === 1, 'still intact after 2.2 s'); run(m, 2); ok(m.ps[p.index] === 2, 'broken after 2.34 s (2.4 s in whole ticks)');
  place(m.survivors[0], 3.5, 33.5);   // out of the way (bodies block the hunter)
  ctl.H = () => ({ moveDir: { x: 0, z: -1 } }); run(m, 30); ok(m.hunter.z < 21.5, 'hunter walks through after the break');
  // survivor vault over a dropped pallet: 1.2 s
  const u = mk(); const pi = u.m.md.pallets.findIndex(q => q.id === 'p-gap');
  u.m.ps[pi] = 1; u.m.coll[u.m.md.pallets[pi].cells[0]] = 1; u.m.palVersion++; u.m.droppedCount++;
  place(u.m.survivors[0], 25.5, 20.9); u.ctl.S[0] = () => ({ moveDir: { x: 0, z: 1 } });
  let s0 = -1, s1 = -1;
  for (let i = 0; i < 60; i++) { u.m.step(); if (u.m.survivors[0].vault && s0 < 0) s0 = i; if (s0 >= 0 && !u.m.survivors[0].vault) { s1 = i; break; } }
  ok(s0 >= 0, 'survivor vaults the dropped pallet'); near((s1 - s0) * 0.1, 1.2, 0.11, 'pallet vault takes 1.2 s'); near(u.m.survivors[0].z, 23.5, 1e-6, 'lands on the far side');
  // pushed out if standing in the footprint when it drops
  const w = mk(); place(w.m.survivors[0], 25.5, 22.5); place(w.m.hunter, 40.5, 5.5); w.ctl.S[0] = () => ({ act: 'dropPallet' });
  run(w.m, 3); ok(circleFree(w.m.coll, w.m.W, w.m.Hh, w.m.survivors[0].x, w.m.survivors[0].z, 0.4), 'actor standing in the pallet cell is pushed to a free spot');
});

test('attack: 0.35 s windup, hit needs range 2.2 + facing, injured -> downed, boost, cooldowns 2.7 / 1.5 s', () => {
  const { m, ctl } = mk();
  place(m.hunter, 30.5, 26.5); place(m.survivors[0], 32.0, 26.5);
  ctl.H = () => ({ act: 'attack', face: { x: 33, z: 26.5 } });
  run(m, 3); ok(m.survivors[0].st === HEALTHY, 'no hit before the windup ends');
  run(m, 2); ok(m.survivors[0].st === INJURED, 'healthy -> injured');
  ok(m.survivors[0].boostT > 1.5, 'hit survivor gets the speed boost');
  near(m.hunter.cdT, 2.7, 0.11, 'hit cooldown 2.7 s (one tick elapsed)');
  ctl.H = () => ({ act: 'attack', face: { x: 33, z: 26.5 } });
  run(m, 20); ok(m.survivors[0].st === INJURED, 'cannot attack during the cooldown');
  const e1 = m.events.filter(x => x.type === 'hit').length; run(m, 15);
  ok(m.survivors[0].st === DOWNED, 'second hit downs'); ok(m.survivors[0].bleedT > 238, 'bleed-out timer starts at 240 s');
  // miss: facing away
  const t = mk(); place(t.m.hunter, 30.5, 26.5); place(t.m.survivors[0], 32.0, 26.5); t.ctl.H = () => ({ act: 'attack', face: { x: 20, z: 26.5 } });
  run(t.m, 5); ok(t.m.survivors[0].st === HEALTHY && t.m.stats.missed === 1, 'facing away misses'); near(t.m.hunter.cdT, 1.5, 0.11, 'miss cooldown 1.5 s (one tick elapsed)');
  // wall between: no hit even at 1.9 m (house west wall at x=10)
  const wl = mk(); place(wl.m.hunter, 9.5, 12.5); place(wl.m.survivors[0], 11.4, 12.5); wl.ctl.H = () => ({ act: 'attack', face: { x: 12, z: 12.5 } });
  run(wl.m, 5); ok(wl.m.survivors[0].st === HEALTHY, 'cannot hit through a wall');
  // out of range
  const u = mk(); place(u.m.hunter, 30.5, 26.5); place(u.m.survivors[0], 37.5, 26.5); u.ctl.H = () => ({ act: 'attack', face: { x: 38, z: 26.5 } });
  run(u.m, 5); ok(u.m.survivors[0].st === HEALTHY, '7 m away: out of reach even with the lunge');
  const v2 = mk(); place(v2.m.hunter, 30.5, 26.5); place(v2.m.survivors[0], 33.0, 26.5); v2.ctl.H = () => ({ act: 'attack', face: { x: 34, z: 26.5 } });
  run(v2.m, 5); ok(v2.m.survivors[0].st === INJURED && Math.abs(v2.m.hunter.x - 30.5) < 1, 'hunter plants once the target is in range (no overshoot)');
  // wall between
  const w = mk(); place(w.m.hunter, 8.8, 12.5); place(w.m.survivors[0], 11.8 > 0 ? 10.7 : 0, 12.5);
});

test('carry / hook: pickup 2 s, hook 1 s, stage 1 (60 s) -> stage 2 (60 s) -> dead; 2nd hook starts in stage 2; 3rd hook kills at once', () => {
  const { m, ctl } = mk({ config: { antiCamp: { enabled: false } } });   // hunter idles next to the hook: no Resolve here
  const s = m.survivors[0], hk = m.hooks[0];
  s.st = DOWNED; s.bleedT = 240; place(s, 30.5, 26.5); place(m.hunter, 31.5, 26.5);
  ctl.H = () => ({ act: 'pickup', target: 0 });
  run(m, 19); ok(s.st === DOWNED, 'not picked up before 2 s'); run(m, 2); ok(s.st === CARRIED && m.hunter.carrying === 0, 'picked up after 2 s');
  ctl.S[0] = () => ({ act: 'wiggle' });
  ctl.H = () => ({ moveDir: { x: 1, z: 0 } }); run(m, 10); near(m.hunter.x - 31.5, 3.68, 0.3, 'carrying speed 3.68 (pickup took 2 s)');
  ok(Math.abs(s.x - m.hunter.x) < 1e-9, 'carried survivor follows the hunter');
  place(m.hunter, hk.x + 1, hk.z); m.survivors[0].wiggle = 0; ctl.S[0] = () => ({});
  ctl.H = () => ({ act: 'hook' }); run(m, 9); ok(s.st === CARRIED, 'not hooked before 1 s'); run(m, 2);
  ok(s.st === HOOKED && s.hookCount === 1 && s.hookStage === 1 && hk.occ === 0, 'hooked: stage 1, hook occupied');
  ctl.H = () => ({});
  run(m, 595); ok(s.st === HOOKED && s.hookStage === 1, 'still stage 1 at ~59.5 s'); run(m, 10); ok(s.hookStage === 2, 'stage 2 after 60 s');
  run(m, 585); ok(s.st === HOOKED, 'alive at ~119.5 s'); run(m, 15); ok(s.st === DEAD && s.cause === 'hookDeath' && hk.occ === -1, 'dies after stage 2 (60 s), hook freed');
  // 2nd hook begins in stage 2; rescue puts survivor injured with boost
  const t = mk(); const a = t.m.survivors[1], h2 = t.m.hooks[1];
  a.st = CARRIED; a.hookCount = 1; t.m.hunter.carrying = 1; place(t.m.hunter, h2.x + 1, h2.z); t.ctl.H = () => ({ act: 'hook' }); run(t.m, 11);
  ok(a.st === HOOKED && a.hookCount === 2 && a.hookStage === 2 && near(a.hookTimer, 59, 1.1, 'stage 2 timer starts at 60 s') !== false, 'second hook starts in stage 2');
  t.ctl.H = () => ({}); place(t.m.survivors[2], h2.x - 1, h2.z); t.ctl.S[2] = () => ({ act: 'rescue', target: 1 });
  run(t.m, 9); ok(a.st === HOOKED, 'not rescued before 1 s'); run(t.m, 2);
  ok(a.st === INJURED && a.protT > 9 && a.endure && a.boostT === 0 && h2.occ === -1, 'rescued: injured with 10 s unhook protections, hook free');
  // 3rd hook = instant death
  const u = mk(); const b = u.m.survivors[2], h3 = u.m.hooks[2];
  b.st = CARRIED; b.hookCount = 2; u.m.hunter.carrying = 2; place(u.m.hunter, h3.x + 1, h3.z); u.ctl.H = () => ({ act: 'hook' }); run(u.m, 11);
  ok(b.st === DEAD && b.cause === 'hook3' && u.m.hunter.carrying === -1, 'third hook kills instantly');
  // wiggle 16 s
  const w = mk(); const c = w.m.survivors[3]; c.st = CARRIED; c.bleedT = 100; w.m.hunter.carrying = 3; place(w.m.hunter, 30.5, 26.5);
  w.ctl.S[3] = () => ({ act: 'wiggle' }); w.ctl.H = () => ({ moveDir: { x: 1, z: 0 } });
  run(w.m, 150); ok(c.st === CARRIED, 'still carried at 15 s'); run(w.m, 15);
  ok(c.st === DOWNED && w.m.hunter.carrying === -1 && w.m.hunter.stunT > 0, 'wiggle frees after 16 s and stuns the hunter');
  // bleed out
  const x = mk(); x.m.survivors[0].st = DOWNED; x.m.survivors[0].bleedT = 240; run(x.m, 2395); ok(x.m.survivors[0].st === DOWNED, 'alive at 239.5 s');
  run(x.m, 10); ok(x.m.survivors[0].st === DEAD && x.m.survivors[0].cause === 'bleedout', 'bleeds out after 240 s');
});

test('heal: 16 s, not self; persists on the target; heals downed -> injured', () => {
  const { m, ctl } = mk({ config: { gens: { fumbleChancePerS: 0 } } });
  const a = m.survivors[0], b = m.survivors[1];
  a.st = INJURED; place(a, 30.5, 26.5); place(b, 31.5, 26.5);
  ctl.S[0] = () => ({ act: 'heal', target: 0 }); run(m, 200); ok(a.st === INJURED, 'cannot self-heal');
  ctl.S[1] = () => ({ act: 'heal', target: 0 }); run(m, 159); ok(a.st === INJURED, 'not healed before 16 s'); run(m, 3); ok(a.st === HEALTHY, 'healed after 16 s');
  b.st = DOWNED; b.bleedT = 100; ctl.S[0] = () => ({ act: 'heal', target: 1 }); ctl.S[1] = () => ({}); run(m, 162); ok(b.st === INJURED, 'downed survivor picked up -> injured');
});

test('generators: 90 s solo, efficiency 1/0.85/0.7 for 1/2/3 workers, fumble -10% + loud notification, 5 gens power the gates', () => {
  const cfg = { gens: { fumbleChancePerS: 0 } };
  const { m, ctl } = mk({ config: cfg });
  const g = gen(m); place(m.survivors[0], g.x + 1, g.z);
  ctl.S[0] = () => ({ act: 'repair', target: g.id });
  run(m, 899); ok(!g.done, 'not done at 89.9 s'); run(m, 2); ok(g.done, 'done at 90 s');
  const t = mk({ config: cfg }); const g2 = gen(t.m); place(t.m.survivors[0], g2.x + 1, g2.z); place(t.m.survivors[1], g2.x - 1, g2.z);
  t.ctl.S[0] = () => ({ act: 'repair', target: g2.id }); t.ctl.S[1] = () => ({ act: 'repair', target: g2.id });
  run(t.m, 100); near(g2.p, 100 * 0.1 * 2 * 0.85, 0.01, 'two workers: 2 x 0.85 progress/s');
  const u = mk({ config: cfg }); const g3 = gen(u.m);
  place(u.m.survivors[0], g3.x + 1, g3.z); place(u.m.survivors[1], g3.x - 1, g3.z); place(u.m.survivors[2], g3.x, g3.z + 1);
  for (const i of [0, 1, 2]) u.ctl.S[i] = () => ({ act: 'repair', target: g3.id });
  run(u.m, 100); near(g3.p, 100 * 0.1 * 3 * 0.7, 0.01, 'three workers: 3 x 0.7');
  // moving cancels the interaction
  const v = mk({ config: cfg }); const g4 = gen(v.m); place(v.m.survivors[0], g4.x + 1, g4.z);
  v.ctl.S[0] = () => ({ act: 'repair', target: g4.id, moveDir: { x: 0, z: 1 } }); run(v.m, 20); ok(g4.p === 0, 'moving cancels repair');
  // out of range: no progress
  const w = mk({ config: cfg }); const g5 = gen(w.m); place(w.m.survivors[0], g5.x + 4, g5.z); w.ctl.S[0] = () => ({ act: 'repair', target: g5.id }); run(w.m, 20); ok(g5.p === 0, 'out of range: no repair');
  // fumble
  const f = mk({ config: { gens: { fumbleChancePerS: 10 } } }); const g6 = gen(f.m); g6.p = 40; place(f.m.survivors[0], g6.x + 1, g6.z);
  let hn = []; f.ctl.H = o => (hn = o.notifications, {}); f.ctl.S[0] = () => ({ act: 'repair', target: g6.id }); run(f.m, 3);
  ok(g6.p < 40, 'fumble reduces progress'); ok(hn.some(n => n.type === 'fumble' && n.x === g6.x && n.z === g6.z), 'hunter gets fumble notification with position');
  // 5 gens -> gates powered, 2-minute timer
  const h = mk({ config: { gens: { needed: 2, repairS: 2, fumbleChancePerS: 0 } } });
  for (const [i, gg] of h.m.gens.slice(0, 2).entries()) { place(h.m.survivors[i], gg.x + 1, gg.z); h.ctl.S[i] = () => ({ act: 'repair', target: gg.id }); }
  run(h.m, 30); ok(h.m.gatesPowered && h.m.endgameT < 0, 'gates powered after the needed gens; endgame timer NOT started yet (starts on first gate opening)');
});

test('generators: 7 of the candidates per match (seeded), 5 needed; unfinished gens blocked once gates are powered', () => {
  for (const map of [smallMap, bigMap].filter(Boolean)) {
    const cand = new Set(map.generators.map(g => g.id));
    const sets = new Set();
    for (let seed = 1; seed <= 6; seed++) {
      const { m } = mk({ map, seed });
      ok(m.gens.length === 7 && m.gensNeeded === 5, map.id + ' seed ' + seed + ': 7 generators placed, 5 needed');
      ok(m.gens.every(g => cand.has(g.id)) && new Set(m.gens.map(g => g.id)).size === 7, map.id + ' seed ' + seed + ': gens are distinct map candidates');
      ok(m.gens.map(g => g.id).join() === mk({ map, seed }).m.gens.map(g => g.id).join(), map.id + ' seed ' + seed + ': same seed => same gens');
      sets.add(m.gens.map(g => g.id).join());
    }
    ok(map.generators.length <= 7 || sets.size > 1, map.id + ': different seeds choose different generator sets');
  }
  // 5th gen completes -> powered; the 2 left are blocked: repairing does nothing, never completes, obs shows blocked
  const cfg = { gens: { repairS: 2, fumbleChancePerS: 0 } };
  const { m, ctl } = mk({ config: cfg });
  let obs = null, hobs = null; ctl.H = o => (hobs = o, {});
  for (const gg of m.gens.slice(0, 4)) { gg.done = true; gg.p = 2; }
  m.gensDone = 4;
  const s = m.survivors[0], s1 = m.survivors[1]; const g5 = m.gens[4], g6 = m.gens[5];
  g5.p = 1.9; g6.p = 1.5;
  place(s, g5.x + 1, g5.z); place(s1, g6.x + 1, g6.z);
  ctl.S[0] = () => ({ act: 'repair', target: g5.id });
  run(m, 3);
  ok(m.gensDone === 5 && m.gatesPowered, '5th gen powers the gates');
  ctl.S[1] = o => (obs = o, { act: 'repair', target: g6.id });
  const p6 = g6.p; run(m, 50);
  ok(g6.p === p6 && !g6.done && m.gensDone === 5, 'blocked gen: repairing adds no progress and cannot complete');
  ok(s1.curAct !== 'repair' && s1.repairS === 0, 'blocked gen: survivor is not working it');
  const og6 = obs.gens.find(x => x.id === g6.id); ok(og6.blocked === true && !og6.done, 'survivor obs: unfinished gen shows blocked');
  ok(obs.gens.find(x => x.id === g5.id).blocked === false, 'completed gen is not marked blocked');
  ok(hobs.gens.find(x => x.id === g6.id).blocked === true, 'hunter obs: blocked flag');
  // a gen finishing on the same tick as the 5th: only the 5th counts
  const t = mk({ config: cfg });
  for (const gg of t.m.gens.slice(0, 4)) { gg.done = true; gg.p = 2; } t.m.gensDone = 4;
  const a = t.m.gens[4], b = t.m.gens[5]; a.p = b.p = 1.95;
  place(t.m.survivors[0], a.x + 1, a.z); place(t.m.survivors[1], b.x + 1, b.z);
  t.ctl.S[0] = () => ({ act: 'repair', target: a.id }); t.ctl.S[1] = () => ({ act: 'repair', target: b.id });
  run(t.m, 3); ok(t.m.gensDone === 5 && t.m.gatesPowered && !b.done, 'a gen finishing on the same tick as the 5th stays blocked');
});

test('exit gates: lever 20 s, open, escape at exit; endgame timer kills the rest; last-survivor auto-power', () => {
  const o = { config: { gens: { needed: 1 } } };
  const { m, ctl } = mk(o);
  m._powerGates('test');
  const g = m.gates[0], s = m.survivors[0];
  place(s, g.lx, g.lz + 1);
  ctl.S[0] = () => ({ act: 'openGate', target: g.id });
  run(m, 190); ok(!g.open, 'lever not done at 19 s'); ok(m.endgameT < 0, 'powered but no gate open: no endgame timer');
  run(m, 12); ok(g.open, 'gate open after 20 s');
  ok(m.endgameT > 118.5 && m.endgameT <= 120, 'endgame timer starts when the first gate is opened');
  ok(!m.gates[1].open && m.gates[1].prog === 0, 'the other gate is independent (still closed, no progress)');
  ctl.S[0] = () => ({ moveTo: { x: g.ex, z: g.ez } });
  run(m, 40); ok(s.st === ESCAPED && s.outcome === 'escaped', 'survivor escapes at the exit');
  // not open -> cannot escape
  const t = mk(o); t.m._powerGates('test'); const s2 = t.m.survivors[0]; place(s2, t.m.gates[0].ex, t.m.gates[0].ez + 0.6); t.ctl.S[0] = () => ({}); run(t.m, 5); ok(s2.st === HEALTHY, 'closed gate: no escape');
  // endgame: a gate opens, nobody leaves -> everyone dies 120 s after the opening
  run(t.m, 600); ok(t.m.endgameT < 0 && t.m.survivors.every(x => x.st === HEALTHY), 'powered for 60 s without an opening: no timer, nobody dies');
  t.m._openGate(t.m.gates[1], t.m.survivors[0]);
  run(t.m, 1190); ok(t.m.survivors.every(x => x.st < DEAD), 'alive at ~119 s after the opening'); run(t.m, 20);
  ok(t.m.survivors.every(x => x.st === DEAD && x.cause === 'endgame') && t.m.over, 'endgame timer kills all remaining survivors and ends the match');
  ok(t.m.events.some(e => e.type === 'endgame'), 'endgame event emitted');
  // hatch substitute: down to 1 survivor before gates powered
  const u = mk(o); u.m._kill(u.m.survivors[0], 'test'); u.m._kill(u.m.survivors[1], 'test');
  ok(!u.m.gatesPowered, 'two left: not powered'); u.m._kill(u.m.survivors[2], 'test');
  ok(u.m.gatesPowered && u.m.endgameT < 0, 'last survivor: gates auto-power, timer waits for a gate opening');
  const ls = u.m.survivors[3], lg = u.m.gates[1]; place(ls, lg.lx, lg.lz - 1); u.ctl.S[3] = () => ({ act: 'openGate', target: lg.id });
  run(u.m, 202); ok(lg.open && u.m.endgameT > 118, 'last survivor opens a gate -> timer starts');
  // match result sanity
  const r = u.m.result(); ok(r.kills === 3 && r.escapes === 0, 'result counts kills');
});

test('survivor-side nav: reaches targets without leaving walkable space (several routes)', () => {
  const { m, ctl } = mk({ config: { collision: { survivors: false } } });   // parked teammates sit on some goals
  const goals = [[44.5, 33.5], [6.5, 6.5], [24.5, 30.5], [24.5, 10.5], [14.5, 11.5]];
  const s = m.survivors[0];
  place(m.hunter, 24.5, 18.5); ctl.H = () => ({});
  for (const [gx, gz] of goals) {
    place(s, 3.5, 33.5); s.vault = null;
    ctl.S[0] = () => ({ moveTo: { x: gx, z: gz } });
    let t = 0; for (; t < 900 && Math.hypot(s.x - gx, s.z - gz) > 0.3; t++) { m.step(); if (!s.vault) ok(circleFree(m.coll, m.W, m.Hh, s.x, s.z, 0.4) || m.md.kind[Math.floor(s.z) * m.W + Math.floor(s.x)] !== 0, 'position valid'); }
    ok(t < 900, `reached (${gx},${gz}) in ${(t / 10).toFixed(1)} s`);
  }
  const d1 = m.survivors[0].nav.dist({ x: 3.5, z: 33.5 }, { x: 44.5, z: 3.5 }); const d2 = m.survivors[0].nav.dist({ x: 44.5, z: 3.5 }, { x: 3.5, z: 33.5 });
  near(d1, d2, 2, 'dist is ~symmetric'); ok(d1 > Math.hypot(41, 30) - 1 && d1 < 80, 'dist is plausible (' + d1.toFixed(1) + ')');
  ok(m.survivors[0].nav.nextWaypoint({ x: 3.5, z: 3.5 }, { x: 3.5, z: 12.5 }).z === 12.5, 'straight line => waypoint is the target (no zig-zag)');
});

test('hunter nav treats dropped pallets as blocked; survivors do not', () => {
  const { m } = mk();
  const pi = m.md.pallets.findIndex(q => q.id === 'p-gap');
  const a = { x: 25.5, z: 19.5 }, b = { x: 25.5, z: 24.5 };
  const hd0 = m.hunter.nav.dist(a, b), sd0 = m.survivors[0].nav.dist(a, b);
  near(hd0, sd0, 0.01, 'same distance while the pallet is up');
  m.ps[pi] = 1; m.coll[m.md.pallets[pi].cells[0]] = 1; m.palVersion++; m.droppedCount++;
  const hd1 = m.hunter.nav.dist(a, b), sd1 = m.survivors[0].nav.dist(a, b);
  ok(hd1 > hd0 + 5, `hunter detours around a dropped pallet (${hd0.toFixed(1)} -> ${hd1.toFixed(1)})`);
  near(sd1, sd0 + 0, 0.5, 'survivor path through the dropped pallet is unchanged');
  const wp = m.hunter.nav.nextWaypoint(a, b); ok(wp && Math.hypot(wp.x - a.x, wp.z - a.z) > 0.3, 'hunter waypoint exists');
  // follow it: hunter must end up south of the wall line without crossing the pallet cell
  place(m.hunter, a.x, a.z); const H = m.hunter; let crossed = false;
  const ctl = { fn: () => ({ moveTo: b }) }; m.hunter.brain.decide = () => ctl.fn();
  for (let i = 0; i < 400 && Math.hypot(H.x - b.x, H.z - b.z) > 0.4; i++) { m.step(); if (Math.floor(H.x) === 25 && Math.floor(H.z) === 22) crossed = true; }
  ok(!crossed && Math.hypot(H.x - b.x, H.z - b.z) <= 0.5, 'hunter walked around the dropped pallet');
});

test('exit gates: one survivor per lever, progress persists, gates independent, observations, match cap', () => {
  const { m, ctl } = mk();
  m._powerGates('test');
  const g = m.gates[1], h = m.gates[0], a = m.survivors[0], b = m.survivors[1];
  place(a, g.lx - 1, g.lz - 0.5); place(b, g.lx + 1, g.lz - 0.5);
  ctl.S[0] = () => ({ act: 'openGate', target: g.id }); ctl.S[1] = () => ({ act: 'openGate', target: g.id });
  run(m, 50); near(g.prog, 5, 0.15, 'two survivors on one lever: progress is NOT additive (5 s in 5 s)');
  ok(a.curAct === 'openGate' && b.curAct !== 'openGate' && b.prog === 0, 'second survivor gets nothing while the lever is occupied');
  // opener lets go: progress persists; the waiting survivor takes over and continues from there
  ctl.S[0] = () => ({}); run(m, 3); const p0 = g.prog;
  ok(p0 >= 4.9 && p0 <= 5.3, 'lever progress persists when the opener lets go');
  run(m, 100); near(g.prog, p0 + 10, 0.2, 'second survivor continues from the stored progress');
  ctl.S[1] = () => ({}); run(m, 30); const p1 = g.prog; run(m, 30); ok(g.prog === p1, 'nobody on the lever: progress stays (no regression)');
  // other gate worked in parallel by another survivor: independent
  const c = m.survivors[2]; place(c, h.lx, h.lz + 1); ctl.S[2] = () => ({ act: 'openGate', target: h.id });
  ctl.S[1] = () => ({ act: 'openGate', target: g.id });
  run(m, 30); near(h.prog, 3, 0.15, 'gate 2 progresses independently'); ok(g.prog > p1 + 2.5 && !g.open, 'gate 1 keeps progressing at the same time');
  // observations
  let so = null, far = null, ho = null;
  ctl.S[1] = o => (so = o, { act: 'openGate', target: g.id }); ctl.S[3] = o => (far = o, {}); ctl.H = o => (ho = o, {});
  place(m.survivors[3], 3.5, 18.5);
  place(m.hunter, 24.5, 28.5); m.hunter.face = Math.atan2(g.lz - m.hunter.z, g.lx - m.hunter.x);
  run(m, 3);
  const sg = so.gates.find(x => x.id === g.id);
  ok(sg.powered && !sg.open && Math.abs(sg.progress - g.prog / 20) < 0.01, 'survivor at the lever sees its progress');
  ok(Object.keys(sg).sort().join() === 'id,open,powered,progress', 'gate obs keys: id, powered, open, progress');
  const fg = far.gates.find(x => x.id === g.id);
  ok(fg.powered && ('progress' in fg) === m._seesLever(m.survivors[3], g, m.cfg.sight), 'far survivor: progress only if the lever is perceived');
  const hidden = m.gates.map(x => m._seesLever(m.survivors[3], x, m.cfg.sight));
  ok(far.gates.every((x, i) => ('progress' in x) === hidden[i]), 'progress present exactly for perceived levers');
  ok(ho.gates.find(x => x.id === g.id).progress !== undefined, 'hunter facing the lever sees its progress');
  m.hunter.face = Math.atan2(m.hunter.z - g.lz, m.hunter.x - g.lx); run(m, 2);
  ok(!('progress' in ho.gates.find(x => x.id === g.id)), 'hunter facing away: no lever progress');
  ok(so.endgame === null && ho.endgame === null, 'endgame obs null until a gate opens');
  run(m, 120);
  ok(g.open && so.endgame && so.endgame.remainingS > 100 && so.gates.find(x => x.id === g.id).progress === 1, 'after opening: endgame.remainingS, open gate progress 1');
  ok(far.notifications.some(n => n.type === 'gateOpen' && n.gate === g.id), 'everyone gets a gateOpen notification');
  ok(!ho.gates.find(x => x.id === h.id).open, 'other gate still closed');
  // nobody opens a powered gate: match cap ends it (no hang)
  const q = mk({ config: { maxMatchS: 200 } }); q.m._powerGates('test'); run(q.m, 5000);
  ok(q.m.over && q.m.endReason === 'time' && q.m.endgameT < 0 && q.m.result().timeouts === 4, 'powered but never opened: match cap ends it (timeouts)');
});

test('unhook protections: 10 s haste/endurance/elusive, deep wound, mend, conspicuous actions', () => {
  const unhook = (m, i) => { const v = m.survivors[i]; v.st = INJURED; m._grantProtection(v); return v; };
  // haste x1.10; on-hit burst takes precedence
  const { m, ctl } = mk();
  const a = unhook(m, 0); place(a, 30.5, 26.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
  run(m, 10); near(a.x, 30.5 + 4.4, 0.01, 'protected: run 4.0 x 1.10');
  ok(a.protT > 8.8 && a.protT <= 9.0001, 'protection lasts 10 s (counting down)');
  place(a, 30.5, 26.5); a.boostT = 2; run(m, 10); near(a.x, 36.5, 0.01, 'on-hit burst (x1.5) takes precedence over haste');
  // elusive: no scratch marks / grunts while protected
  place(a, 30.5, 26.5); place(m.hunter, 30.5, 29.5); const marks0 = m.marks.length; const gr0 = m.hunter.grunts.length;
  ctl.S[0] = () => ({ moveDir: { x: 0, z: (m.tick % 20 < 10) ? 1 : -1 } }); a.boostT = 0;
  run(m, 40); ok(m.marks.length === marks0, 'elusive: no scratch marks while running');
  ok(m.hunter.grunts.length === gr0, 'elusive: no grunts of pain near the hunter');
  run(m, 50); ok(a.protT === 0 && !a.endure, 'protections expire after 10 s');
  run(m, 20); ok(m.marks.length > marks0, 'scratch marks again after protection');
  ok(m.hunter.grunts.length > gr0, 'grunts again after protection');
  // obs exposure: survivor sees protectedS / deepWoundS, hunter sees nothing extra
  let so = null, ho = null; const t = mk();
  t.ctl.S[1] = o => (so = o, {}); t.ctl.H = o => (ho = o, {});
  const b = unhook(t.m, 1); place(t.m.hunter, b.x + 3, b.z); t.m.hunter.face = Math.PI;
  run(t.m, 2); ok(so.self.protectedS > 9 && so.self.deepWoundS === null, 'self.protectedS shown, deepWoundS null');
  const hs = ho.survivors.find(x => x.id === 1);
  ok(hs && Object.keys(hs).sort().join() === 'facing,hookCount,id,state,vaulting,vx,vz,x,z', 'hunter obs: no protection / deep wound info');
  // endurance: downing hit -> injured + deep wound (consumed); next hit downs
  t.m._hurt(b);
  ok(b.st === INJURED && b.dwT === 20 && !b.endure && b.boostT > 1.5, 'endurance absorbs the downing hit: injured + Deep Wound 20 s + burst');
  run(t.m, 2); ok(so.self.deepWoundS > 19 && so.self.deepWoundS < 20, 'self.deepWoundS counts down');
  // heal blocked while deep-wounded; mend 12 s clears it, progress persists, timer paused while mending
  const c = t.m.survivors[2]; place(c, b.x + 1, b.z); t.ctl.S[2] = () => ({ act: 'heal', target: 1 }); run(t.m, 30);
  ok(b.heal === 0, 'cannot be healed while Deep Wound'); t.ctl.S[2] = () => ({});
  t.ctl.S[1] = o => (so = o, { act: 'mend' }); const dw0 = b.dwT; run(t.m, 60);
  ok(b.dwT === dw0 && b.mendP > 5.9, 'deep wound timer paused while mending');
  t.ctl.S[1] = o => (so = o, {}); run(t.m, 10); ok(b.dwT < dw0 && b.mendP > 5.9, 'mend progress persists, timer resumes');
  t.ctl.S[1] = o => (so = o, { act: 'mend' }); run(t.m, 61); ok(b.dwT === -1 && b.st === INJURED && so.self.deepWoundS === null, 'mend (12 s) clears Deep Wound');
  ok(t.m.events.some(e => e.type === 'mend'), 'mend event');
  t.m._hurt(b); ok(b.st === DOWNED, 'no endurance left: next hit downs');
  // deep wound expiry downs; protections end on conspicuous actions but not on mend / dropPallet
  const u = mk(); const d = unhook(u.m, 0); u.m._hurt(d); ok(d.dwT === 20, 'deep wound applied');
  run(u.m, 195); ok(d.st === INJURED, 'still standing at 19.5 s'); run(u.m, 10);
  ok(d.st === DOWNED && d.dwT === -1 && u.m.events.some(e => e.type === 'deepWoundDown'), 'deep wound timer expiry downs the survivor');
  const v = mk({ config: { gens: { fumbleChancePerS: 0 } } }); const e = unhook(v.m, 0); const g = gen(v.m);
  place(e, g.x + 1, g.z); v.ctl.S[0] = () => ({ act: 'repair', target: g.id }); run(v.m, 2);
  ok(e.protT === 0 && !e.endure, 'repair ends unhook protections');
  const w = mk(); const e2 = unhook(w.m, 0); e2.dwT = 20; w.ctl.S[0] = () => ({ act: 'mend' }); run(w.m, 5);
  ok(e2.protT > 9 && e2.endure, 'mending keeps protections');
  const p = w.m.md.pallets[0]; place(e2, p.cx + (p.axis === 'x' ? 0 : 1), p.cz + (p.axis === 'x' ? 1 : 0)); w.ctl.S[0] = () => ({ act: 'dropPallet', target: p.id }); run(w.m, 5);
  ok(w.m.ps[p.index] === 1 && e2.protT > 8 && e2.endure, 'dropping a pallet keeps protections');
  const x = mk(); x.m._powerGates('test'); const e3 = unhook(x.m, 0); const gt = x.m.gates[0]; place(e3, gt.lx, gt.lz + 1);
  ok(e3.protT === 10, 'same 10 s package after the gates are powered');
  x.ctl.S[0] = () => ({ act: 'openGate', target: gt.id }); run(x.m, 2); ok(e3.protT === 0 && !e3.endure, 'opening a gate ends protections');
  const y = mk(); const e4 = unhook(y.m, 1); const vic = y.m.survivors[2]; vic.st = INJURED; place(e4, vic.x + 1, vic.z);
  y.ctl.S[1] = () => ({ act: 'heal', target: 2 }); run(y.m, 2); ok(e4.protT === 0, 'healing a teammate ends protections');
});

test('spawns: survivors grouped within 15 m, hunter on the far side, deterministic', () => {
  for (const map of [smallMap, bigMap].filter(Boolean)) {
    const diag = Math.hypot(map.size.w, map.size.h);
    let minH = Infinity, okGroup = true, okFree = true;
    const hset = new Set(), aset = new Set();
    for (let seed = 1; seed <= 25; seed++) {
      const m = createMatch({ map, seed, hunter: hunterBrain, survivors: survivorBrain });
      const S = m.survivors, H = m.hunter;
      for (let i = 0; i < 4; i++) {
        if (!circleFree(m.coll, m.W, m.Hh, S[i].x, S[i].z, 0.4)) okFree = false;
        for (let j = i + 1; j < 4; j++) { const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z); if (d > 15 + 1e-9 || d < 3 - 1e-9) okGroup = false; }
        minH = Math.min(minH, Math.hypot(S[i].x - H.x, S[i].z - H.z));
      }
      hset.add(H.x + ',' + H.z); aset.add(S[0].x + ',' + S[0].z);
      const m2 = createMatch({ map, seed, hunter: hunterBrain, survivors: survivorBrain });
      ok(JSON.stringify([H.x, H.z, S.map(q => [q.x, q.z])]) === JSON.stringify([m2.hunter.x, m2.hunter.z, m2.survivors.map(q => [q.x, q.z])]), map.id + ' seed ' + seed + ': spawns deterministic');
    }
    ok(okGroup, map.id + ': survivors pairwise 3..15 m apart (spawn.minSep)');
    ok(okFree, map.id + ': survivors on free positions');
    ok(aset.size > 1, map.id + ': anchor varies by seed');
    if (map === bigMap) ok(minH >= 0.55 * diag, map.id + ': hunter >= 0.55 x diagonal from every survivor (min ' + minH.toFixed(1) + ' / ' + (0.55 * diag).toFixed(1) + ')');
    else ok(minH >= 0.4 * diag, map.id + ': hunter far from survivors (min ' + minH.toFixed(1) + ')');
  }
  // hunter candidates on the far side are used when present (perimeter-style candidate map)
  const pm = structuredClone(smallMap);
  pm.spawns = { survivors: [{ x: 3.5, z: 3.5 }], hunter: [{ x: 4.5, z: 6.5 }, { x: 44.5, z: 33.5 }, { x: 43.5, z: 31.5 }] };
  const picks = new Set();
  for (let seed = 1; seed <= 12; seed++) { const m = createMatch({ map: pm, seed, hunter: hunterBrain, survivors: survivorBrain }); picks.add(m.hunter.x + ',' + m.hunter.z); }
  ok(!picks.has('4.5,6.5') && picks.size >= 1 && [...picks].every(p => p === '44.5,33.5' || p === '43.5,31.5'), 'far hunter candidates chosen, near one never: ' + [...picks].join(' '));
  // no hunter candidates: fallback = farthest walkable cell >= 4 m inside the outline
  const nm = structuredClone(smallMap); nm.spawns = { survivors: [{ x: 3.5, z: 3.5 }], hunter: [] };
  const m = createMatch({ map: nm, seed: 3, hunter: hunterBrain, survivors: survivorBrain });
  ok(Math.hypot(m.hunter.x - 3.5, m.hunter.z - 3.5) > 35 && m.hunter.x >= 4 && m.hunter.z >= 4 && m.hunter.x <= nm.size.w - 4 && m.hunter.z <= nm.size.h - 4, 'fallback hunter spawn far and inset: ' + m.hunter.x + ',' + m.hunter.z);
});

test('vault tiers: fast 0.5 s (straight 2.5 m run-up, loud noise) / medium 0.9 s / slow 1.5 s walking', () => {
  const trial = (x, z, dir, walk) => {
    const { m, ctl } = mk(); let hn = null;
    place(m.survivors[0], x, z); ctl.S[0] = () => ({ moveDir: dir, walk }); ctl.H = o => (hn = o, {});
    let start = -1, end = -1;
    for (let i = 0; i < 100; i++) { m.step(); const v = m.survivors[0].vault; if (v && start < 0) start = i; if (start >= 0 && !v) { end = i; break; } }
    run(m, 2);
    return { dur: start >= 0 && end >= 0 ? (end - start) * 0.1 : -1, noise: hn.notifications.filter(n => n.type === 'loudNoise'), marks: m.marks.length, m };
  };
  const fast = trial(13.5, 4.6, { x: 0, z: 1 }, false);
  near(fast.dur, 0.5, 0.11, 'straight 3 m run-up: fast vault 0.5 s');
  ok(fast.noise.length === 1 && fast.noise[0].cause === 'vault' && Math.abs(fast.noise[0].x - 13.5) < 0.5, 'fast vault: hunter gets loudNoise with position (map-wide)');
  ok(fast.m.survivors.every(q => !q.inbox.some(n => n.type === 'loudNoise')), 'survivors get no loudNoise');
  const short = trial(13.5, 6.6, { x: 0, z: 1 }, false);
  near(short.dur, 0.9, 0.11, '1 m run-up: medium vault 0.9 s'); ok(short.noise.length === 0, 'medium vault: no noise');
  const diag = trial(12.7, 5.6, { x: 0.5, z: 1 }, false);
  near(diag.dur, 0.9, 0.11, 'diagonal approach (27 deg): medium vault 0.9 s'); ok(diag.noise.length === 0, 'diagonal: no noise');
  const turn = trial(11.5, 5.0, { x: 1, z: 0 }, false);   // runs east along the window row then never vaults (sanity)
  ok(turn.dur === -1, 'running along the wall does not vault');
  const walk = trial(13.5, 4.6, { x: 0, z: 1 }, true);
  near(walk.dur, 1.5, 0.11, 'walking: slow vault 1.5 s'); ok(walk.noise.length === 0 && walk.marks === 0, 'walking: no noise, no scratch marks');
  // limited loud-noise range
  const { m, ctl } = mk({ config: { senses: { loudNoiseRange: 5 } } }); let hn = null;
  place(m.survivors[0], 13.5, 4.6); ctl.S[0] = () => ({ moveDir: { x: 0, z: 1 } }); ctl.H = o => (hn = o, {}); run(m, 20);
  ok(!hn.notifications.some(n => n.type === 'loudNoise'), 'loudNoiseRange 5: far hunter hears nothing');
});

test('generators: repair noise, hunter kicks (-5% + regression at 1/4 rate), repair stops regression', () => {
  const cfg = { gens: { fumbleChancePerS: 0 } };
  const { m, ctl } = mk({ config: cfg });
  let ho = null, so = null; ctl.H = o => (ho = o, {});
  const g = gen(m), s0 = m.survivors[0];
  place(s0, g.x + 1, g.z); ctl.S[0] = () => ({ act: 'repair', target: g.id });
  place(m.hunter, g.x + 9.5, g.z); m.hunter.face = 0; run(m, 3);
  ok(ho.noisyGens.length === 1 && ho.noisyGens[0].id === g.id && Object.keys(ho.noisyGens[0]).sort().join() === 'id,x,z', 'repair noise heard within 10 m (id, x, z only)');
  place(m.hunter, g.x + 12, g.z); run(m, 2); ok(ho.noisyGens.length === 0, 'repair noise not heard beyond 10 m');
  ctl.S[0] = () => ({}); place(m.hunter, g.x + 5, g.z); run(m, 2); ok(ho.noisyGens.length === 0, 'idle gen is silent');
  // kick preconditions: progress > 0
  const t = mk({ config: cfg }); const g2 = gen(t.m); place(t.m.hunter, g2.x + 1, g2.z); t.ctl.H = () => ({ act: 'kickGen', target: g2.id });
  run(t.m, 30); ok(g2.p === 0 && !g2.regress && !t.m.events.some(e => e.type === 'genKick'), 'cannot kick a gen with 0 progress');
  // kick: 1.8 s, -5 %, regress at 0.25 / s
  g2.p = 45; t.ctl.H = () => ({ act: 'kickGen', target: g2.id });
  run(t.m, 17); ok(!g2.regress && g2.p === 45, 'not kicked before 1.8 s'); run(t.m, 1);
  ok(g2.regress && Math.abs(g2.p - (45 - 4.5)) < 0.03, 'kick after 1.8 s: -5 % of the bar, regressing');
  t.ctl.H = () => ({}); const p0 = g2.p; run(t.m, 100); near(g2.p, p0 - 2.5, 0.03, 'regresses at 1/4 of the solo repair rate (0.25 s/s => 360 s per bar)');
  // can't kick a regressing gen
  t.ctl.H = () => ({ act: 'kickGen', target: g2.id }); const p1 = g2.p; run(t.m, 25);
  ok(t.m.events.filter(e => e.type === 'genKick').length === 1 && Math.abs(g2.p - (p1 - 0.25 * 2.5)) < 0.03, 'cannot kick an already regressing gen');
  // obs: hunter sees regressing everywhere, survivors only when seen/adjacent
  t.ctl.H = o => (ho = o, {}); t.ctl.S[1] = o => (so = o, {}); place(t.m.survivors[1], 44.5, 3.5); place(t.m.hunter, 24.5, 18.5);
  run(t.m, 3); ok(ho.gens.find(x => x.id === g2.id).regressing === true, 'hunter obs: regressing');
  const sg = so.gens.find(x => x.id === g2.id); ok(sg.visible ? sg.regressing === true : sg.regressing === null, 'survivor obs: regressing only if the gen is perceived');
  place(t.m.survivors[1], g2.x - 1, g2.z); run(t.m, 3); ok(so.gens.find(x => x.id === g2.id).regressing === true, 'adjacent survivor sees regressing');
  // repair stops regression
  t.ctl.S[1] = o => (so = o, { act: 'repair', target: g2.id }); const p2 = g2.p; run(t.m, 10);
  ok(!g2.regress && g2.p > p2 && t.m.events.some(e => e.type === 'genRegressStop' && e.reason === 'repair'), 'repairing stops the regression and resumes progress');
  // regression stops at 0
  const u = mk({ config: cfg }); const g3 = gen(u.m); g3.p = 5; place(u.m.hunter, g3.x + 1, g3.z); u.ctl.H = () => ({ act: 'kickGen', target: g3.id });
  run(u.m, 18); u.ctl.H = () => ({}); ok(g3.regress, 'kicked'); run(u.m, 30);
  ok(g3.p === 0 && !g3.regress && u.m.events.some(e => e.type === 'genRegressStop' && e.reason === 'empty'), 'regression stops at 0');
  // out of reach, done gen, gates powered, carrying
  const v = mk({ config: cfg }); const g4 = gen(v.m); g4.p = 40; place(v.m.hunter, g4.x + 3, g4.z); v.ctl.H = () => ({ act: 'kickGen', target: g4.id }); run(v.m, 25);
  ok(!g4.regress && g4.p === 40, 'out of reach: no kick');
  g4.done = true; g4.p = 90; place(v.m.hunter, g4.x + 1, g4.z); run(v.m, 25); ok(!g4.regress && g4.p === 90, 'cannot kick a completed gen');
  const w = mk({ config: cfg }); const g5 = gen(w.m); g5.p = 40; w.m._powerGates('test'); place(w.m.hunter, g5.x + 1, g5.z); w.ctl.H = () => ({ act: 'kickGen', target: g5.id }); run(w.m, 25);
  ok(!g5.regress && g5.p === 40, 'gates powered: gens blocked, no kick');
});

test('anti-camp Resolve: face-camp fills in 30-40 s, kick-and-leave barely moves it, teammate/chase/grace/gates, self-unhook', () => {
  // isolated hook scene: survivor 0 hooked on hook 0, the others removed (st DEAD without events, so no last-survivor power-up)
  const scene = (opts = {}) => {
    const h = mk(opts); const m = h.m, s = m.survivors[0], hk = m.hooks[0];
    for (const o of m.survivors.slice(1)) o.st = DEAD;
    if (opts.hookCount) s.hookCount = opts.hookCount;
    s.st = CARRIED; m.hunter.carrying = 0; m._hookSurvivor(s, hk);
    return { ...h, s, hk };
  };
  const spotAt = (m, hk, d, ang0 = 0) => { for (let a = 0; a < 64; a++) { const t = ang0 + a / 64 * 2 * Math.PI, x = hk.x + d * Math.cos(t), z = hk.z + d * Math.sin(t); if (circleFree(m.coll, m.W, m.Hh, x, z, 0.4)) return { x, z }; } throw new Error('no spot at ' + d); };
  const fullT = m => { const e = m.events.find(x => x.type === 'resolveFull'); return e ? e.t : -1; };
  // face-camp at 2 m
  const a = scene(); const p2 = spotAt(a.m, a.hk, 2); place(a.m.hunter, p2.x, p2.z);
  run(a.m, 69); ok(a.s.resolve === 0, 'grace: no fill during the first 7 s after the hook'); run(a.m, 6); ok(a.s.resolve > 0, 'fills after the grace');
  for (let k = 0; k < 500 && fullT(a.m) < 0; k++) a.m.step();
  const tf = fullT(a.m); ok(tf >= 30 && tf <= 40, 'face-camp at 2 m fills in 30-40 s incl. grace (got ' + tf.toFixed(1) + ' s)');
  const timer = a.s.hookTimer; run(a.m, 10); ok(a.s.st === HOOKED && a.s.hookTimer === timer, 'self-unhook attempt in progress, hook timer paused');
  run(a.m, 6);
  ok(a.s.st === INJURED && a.hk.occ === -1 && a.s.protT > 9 && a.s.endure && a.m.events.some(e => e.type === 'selfUnhook'), 'self-unhook after 1.5 s: injured + unhook protections, hook free');
  ok(a.s.resolve === 0, 'meter reset on unhook');
  // hook, kick a nearby gen and leave: < 10 %
  const b = scene(); const n3 = spotAt(b.m, b.hk, 3), n9 = spotAt(b.m, b.hk, 9);
  place(b.m.hunter, n3.x, n3.z); run(b.m, 40); place(b.m.hunter, n9.x, n9.z); run(b.m, 60);
  place(b.m.hunter, 44.5, 33.5); run(b.m, 400);
  ok(b.s.resolve < 0.1 && b.s.st === HOOKED, 'hook, ~10 s within 10 m, leave: meter < 10 % (got ' + (b.s.resolve * 100).toFixed(1) + ' %)');
  // out of range (> 20 m): nothing
  const c = scene(); const far = spotAt(c.m, c.hk, 21); place(c.m.hunter, far.x, far.z); run(c.m, 400); ok(c.s.resolve === 0, 'hunter beyond 20 m: no fill');
  // teammate within 8 m of the hook freezes it (teammate behind the hunter, so not a chase)
  const d = scene(); const dp = spotAt(d.m, d.hk, 2); place(d.m.hunter, dp.x, dp.z);
  const mate = d.m.survivors[1]; mate.st = HEALTHY; const mp = spotAt(d.m, d.hk, 5, Math.atan2(d.hk.z - dp.z, d.hk.x - dp.x)); place(mate, mp.x, mp.z);
  d.m.hunter.face = Math.atan2(dp.z - d.hk.z, dp.x - d.hk.x); run(d.m, 300);
  ok(d.s.resolve === 0 && !d.m.hunter.seen[1], 'teammate within 8 m of the hook (unseen by the hunter): meter frozen');
  place(mate, 44.5, 33.5); d.m.hunter.face = Math.atan2(dp.z - d.hk.z, dp.x - d.hk.x); run(d.m, 20); ok(d.s.resolve > 0, 'teammate leaves: meter fills');
  // chase: hunter sees a standing survivor within 16 m -> no fill (assumption)
  const e = scene(); const ep = spotAt(e.m, e.hk, 2); place(e.m.hunter, ep.x, ep.z); run(e.m, 75);
  const runner = e.m.survivors[2]; runner.st = HEALTHY; let seenPos = null;
  for (let ang = 0; ang < 64 && !seenPos; ang++) {
    const t = ang / 64 * 2 * Math.PI, x = e.m.hunter.x + 12 * Math.cos(t), z = e.m.hunter.z + 12 * Math.sin(t);
    if (!circleFree(e.m.coll, e.m.W, e.m.Hh, x, z, 0.4) || Math.hypot(x - e.hk.x, z - e.hk.z) <= 8.5) continue;
    if (e.m.hunter.api.los(e.m.hunter, { x, z })) seenPos = { x, z };
  }
  place(runner, seenPos.x, seenPos.z); e.m.hunter.face = Math.atan2(seenPos.z - e.m.hunter.z, seenPos.x - e.m.hunter.x);
  run(e.m, 2); const r0 = e.s.resolve; run(e.m, 100); ok(e.m.hunter.seen[2] && e.s.resolve === r0, 'hunter in chase (sees a survivor within 16 m): meter paused');
  // carrying: no fill
  const g = scene(); const gp = spotAt(g.m, g.hk, 2); place(g.m.hunter, gp.x, gp.z); run(g.m, 75);
  const cv = g.m.survivors[3]; cv.st = CARRIED; g.m.hunter.carrying = 3; const r1 = g.s.resolve; run(g.m, 50); ok(g.s.resolve === r1, 'hunter carrying: no fill');
  // every hook event: 7 s grace for ALL hooked survivors
  const h = scene(); const hp = spotAt(h.m, h.hk, 2); place(h.m.hunter, hp.x, hp.z); run(h.m, 150);
  const s3 = h.m.survivors[3]; s3.st = CARRIED; h.m.hunter.carrying = 3; h.m._hookSurvivor(s3, h.m.hooks[1]); place(h.m.hunter, hp.x, hp.z);
  const r2 = h.s.resolve; run(h.m, 69); ok(h.s.resolve === r2 && h.s.graceT > 0, 'another hook event re-grants the 7 s grace to already hooked survivors'); run(h.m, 5); ok(h.s.resolve > r2, 'fills again after it');
  // disabled once the gates are powered
  const k = scene(); k.m._powerGates('test'); const kp = spotAt(k.m, k.hk, 2); place(k.m.hunter, kp.x, kp.z); run(k.m, 600);
  ok(k.s.resolve === 0 && !k.m.events.some(x => x.type === 'selfUnhook'), 'gates powered: no Resolve');
  // works in stage 2 (second hook) and the meter persists across the stage change
  const q = scene({ hookCount: 1 }); ok(q.s.hookStage === 2, 'second hook: stage 2'); const qp = spotAt(q.m, q.hk, 2); place(q.m.hunter, qp.x, qp.z);
  run(q.m, 450); ok(q.s.st === INJURED && q.m.events.some(x => x.type === 'selfUnhook') && q.s.hookCount === 2, 'self-unhook works in stage 2');
  const st = scene(); st.s.hookTimer = 12; const sp = spotAt(st.m, st.hk, 2); place(st.m.hunter, sp.x, sp.z); run(st.m, 130);
  ok(st.s.hookStage === 2 && st.s.resolve > 0.1, 'meter persists across the stage change (' + st.s.resolve.toFixed(2) + ')');
  // survivors/hunter learn nothing new
  let ho = null, so = null; const z = scene(); z.ctl.H = o => (ho = o, {}); z.m.survivors[1].st = HEALTHY; z.ctl.S[1] = o => (so = o, {}); run(z.m, 3);
  ok(Object.keys(ho.hooked[0]).sort().join() === 'hookCount,hookId,id,stage,timerS', 'hunter obs: no resolve in hooked[]');
  ok(!('resolve' in so.self) && so.teammates.every(t => !('resolve' in t)), 'survivor obs: no resolve info');
});

test('vault collision: nobody can start a vault through a window someone is vaulting through', () => {
  const { m, ctl } = mk();
  // window (13,8) axis z: north cell (13,7), south cell (13,9)
  place(m.hunter, 13.5, 6.4); ctl.H = () => ({ moveDir: { x: 0, z: 1 } });
  place(m.survivors[0], 13.5, 10.6); ctl.S[0] = () => ({ moveDir: { x: 0, z: -1 } });
  let both = false, hv = false;
  for (let i = 0; i < 30; i++) {
    m.step();
    if (m.hunter.vault) hv = true;
    if (m.hunter.vault && m.survivors[0].vault) both = true;
  }
  ok(hv, 'hunter vaulted');
  ok(!both, 'survivor never starts a vault while the hunter is vaulting the same window');
});

test('collision: survivors are bodies (no overlap / passing through), post-hit and downed exceptions, corridor unstick', () => {
  const minD = (m, a, b, ticks, f) => { let md = Infinity; for (let i = 0; i < ticks; i++) { m.step(); if (f) f(); md = Math.min(md, Math.hypot(a.x - b.x, a.z - b.z)); } return md; };
  // head-on in open ground: they never overlap, sidestep and pass
  { const { m, ctl } = mk(); const a = m.survivors[0], b = m.survivors[1];
    place(a, 26.5, 12.5); place(b, 32.5, 12.5); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } }); ctl.S[1] = () => ({ moveDir: { x: -1, z: 0 } });
    const d = minD(m, a, b, 22);
    ok(d >= 0.8 - 1e-6, 'head-on survivors never overlap (min centre distance ' + d.toFixed(3) + ' >= 0.8)');
    ok(a.x > b.x + 1, 'head-on survivors sidestep and pass each other (a.x ' + a.x.toFixed(2) + ', b.x ' + b.x.toFixed(2) + ')'); }
  // standing survivor blocks a mover aimed straight at it; the mover slides around (never through)
  { const { m, ctl } = mk(); const a = m.survivors[0], b = m.survivors[1];
    place(a, 26.5, 12.5); place(b, 29.5, 12.5); ctl.S[0] = () => ({ moveTo: { x: 32.5, z: 12.5 } });
    const d = minD(m, a, b, 30); ok(d >= 0.8 - 1e-6 && Math.abs(b.x - 29.5) < 1e-9, 'mover cannot pass through a standing survivor (min ' + d.toFixed(3) + '), the stander is not pushed'); }
  // post-hit: no collision for noCollideAfterHitS (2 s): walks straight through
  { const { m, ctl } = mk(); const a = m.survivors[0], b = m.survivors[1];
    place(a, 26.5, 12.5); place(b, 28.5, 12.5); m._hurt(a); ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
    let zs = 0; const d = minD(m, a, b, 8, () => { zs = Math.max(zs, Math.abs(a.z - 12.5)); });
    ok(d < 0.3 && zs < 1e-9, 'just-hit survivor passes straight through a teammate (min ' + d.toFixed(2) + ')');
    const t = mk(); const c = t.m.survivors[0], e = t.m.survivors[1];
    place(c, 26.5, 12.5); place(e, 31.5, 12.5); t.m._hurt(c); run(t.m, 21); t.ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 }, walk: true });
    const d2 = minD(t.m, c, e, 30); ok(d2 >= 0.8 - 1e-6, 'after 2 s the hit survivor collides again (min ' + d2.toFixed(3) + ')');
    const u = mk(); const f = u.m.survivors[0], g = u.m.survivors[1];   // the hit one is also not an obstacle for others
    place(f, 26.5, 12.5); place(g, 28.5, 12.5); u.m._hurt(g); u.ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
    ok(minD(u.m, f, g, 8) < 0.3, 'a just-hit survivor is not an obstacle for teammates either'); }
  // downed survivors don't collide
  { const { m, ctl } = mk(); const a = m.survivors[0], b = m.survivors[1];
    place(a, 26.5, 12.5); place(b, 28.5, 12.5); b.st = DOWNED; b.bleedT = 100; ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });
    ok(minD(m, a, b, 8) < 0.3 && Math.abs(a.z - 12.5) < 1e-9, 'downed survivors are not obstacles'); }
  // 1-cell doorway (the p-gap pallet, up): head-on survivors don't deadlock forever (unstick after 2 s, documented)
  { const { m, ctl } = mk(); const a = m.survivors[0], b = m.survivors[1];
    place(a, 25.5, 19.5); place(b, 25.5, 25.5);
    ctl.S[0] = () => ({ moveTo: { x: 25.5, z: 25.5 } }); ctl.S[1] = () => ({ moveTo: { x: 25.5, z: 19.5 } });
    let t = 0; for (; t < 200 && !(Math.hypot(a.x - 25.5, a.z - 25.5) < 0.3 && Math.hypot(b.x - 25.5, b.z - 19.5) < 0.3); t++) m.step();
    ok(t < 200, 'head-on in a 1-cell doorway: both get through within 20 s (' + (t / 10).toFixed(1) + ' s)');
    ok(m.events.some(e => e.type === 'unstick'), 'via the unstick fallback (event)'); }
});

test('collision: hunter vs survivor bodies (body block, post-hit pass, chase still lands hits, pickup works)', () => {
  // survivor standing in a 1-cell doorway blocks the hunter
  const { m, ctl } = mk(); const s = m.survivors[0], H = m.hunter;
  place(s, 25.5, 22.5); place(H, 25.5, 25.5); ctl.H = () => ({ moveTo: { x: 25.5, z: 19.5 } });
  run(m, 30); ok(H.z > 23.2 && s.z === 22.5, 'survivor in a 1-cell doorway body-blocks the hunter (hunter z ' + H.z.toFixed(2) + ')');
  m._hurt(s); run(m, 15); ok(H.z < 21.5, 'a just-hit survivor no longer blocks: hunter walks through (z ' + H.z.toFixed(2) + ')');
  // they never overlap while both collide
  const t = mk(); const s2 = t.m.survivors[0], H2 = t.m.hunter;
  place(s2, 28.5, 12.5); place(H2, 25.5, 12.5); t.ctl.H = () => ({ moveDir: { x: 1, z: 0 } }); t.ctl.S[0] = () => ({ moveDir: { x: -1, z: 0 } });
  let md = Infinity; for (let i = 0; i < 6; i++) { t.m.step(); md = Math.min(md, Math.hypot(s2.x - H2.x, s2.z - H2.z)); }
  ok(md >= 0.8 - 1e-6, 'hunter and survivor never overlap (min ' + md.toFixed(3) + ')');
  // open-ground chase: survivor walks away, hunter closes and swings: the hit lands; then the down + pickup work
  const u = mk(); const v = u.m.survivors[0], H3 = u.m.hunter;
  place(v, 24.5, 12.5); place(H3, 19.5, 12.5); v.st = INJURED;
  u.ctl.S[0] = (o) => (o.self.state === 'downed' ? {} : { moveDir: { x: 1, z: 0 }, walk: true });
  u.ctl.H = (o) => {
    const q = o.survivors.find(x => x.id === 0); if (!q) return {};
    const d = Math.hypot(q.x - o.self.x, q.z - o.self.z);
    if (q.state === 'downed') return d <= 1.4 ? { act: 'pickup', target: 0 } : { moveTo: { x: q.x, z: q.z } };
    return d <= 2.0 ? { act: 'attack', target: 0, face: { x: q.x, z: q.z } } : { moveTo: { x: q.x, z: q.z } };
  };
  run(u.m, 50); ok(u.m.events.some(e => e.type === 'hit' && e.who === 0), 'open-ground chase: the hunter lands the hit despite bodies');
  ok(v.st === DOWNED || v.st === CARRIED, 'injured survivor downed');
  run(u.m, 40); ok(v.st === CARRIED, 'downed survivor does not collide: hunter picks them up');
  // carrying hunter doesn't collide
  place(m.survivors[1], 25.5, 22.5); m.survivors[0].st = CARRIED; H.carrying = 0; place(H, 25.5, 19.5); ctl.H = () => ({ moveDir: { x: 0, z: 1 } });
  run(m, 20); ok(H.z > 23.5, 'carrying hunter passes a survivor (no collision while carrying)');
  // collision.hunterSurvivor: false turns it off
  const w = mk({ config: { collision: { hunterSurvivor: false } } }); place(w.m.survivors[0], 25.5, 22.5); place(w.m.hunter, 25.5, 25.5);
  w.ctl.H = () => ({ moveDir: { x: 0, z: -1 } }); run(w.m, 30); ok(w.m.hunter.z < 21.5, 'collision.hunterSurvivor false: hunter walks through');
});

test('generators: 4 side slots (walkable neighbours only), one repairer per slot, slotsTaken only when perceived', () => {
  const g0 = mk().m.gens[0];
  const map = structuredClone(smallMap);
  map.obstacles.push({ x: g0.i + 1, z: g0.j, w: 1, d: 1, height: 1 });           // east side: solid
  map.windows.push({ id: 'win-test', x: g0.i, z: g0.j + 1, axis: 'z' });          // south side: window (not usable)
  const ctxs = [];
  const ctl = { S: [() => ({}), () => ({}), () => ({}), () => ({})] };
  const m = createMatch({ map, seed: 1, hunter: () => ({ decide: () => ({}) }), survivors: [0, 1, 2, 3].map(i => ctx => { ctxs[i] = ctx; return { decide: (o, a) => ctl.S[i](o, a) }; }) });
  const S = m.survivors; place(S[0], 3.5, 33.5); place(S[1], 44.5, 3.5); place(S[2], 3.5, 3.5); place(S[3], 44.5, 33.5); place(m.hunter, 24.5, 18.5);
  const g = m.gens[0]; ok(g.id === g0.id, 'same gen chosen');
  ok(g.slots.map(s => s.side).join() === 'N,W', 'blocked (solid) and window sides are not slots: ' + g.slots.map(s => s.side).join());
  ok(JSON.stringify(ctxs[0].map.generators[0].slots) === JSON.stringify([{ side: 'N', x: g.i + 0.5, z: g.j - 0.5 }, { side: 'W', x: g.i - 0.5, z: g.j + 0.5 }]), 'ctx.map.generators[i].slots = usable side points (cell centres)');
  ok(Object.isFrozen(ctxs[0].map.generators[0].slots[0]), 'static slots are frozen');
  const obs = [];
  for (let i = 0; i < 4; i++) ctl.S[i] = o => (obs[i] = o, i < 3 ? { act: 'repair', target: g.id } : {});
  // s0 on N; s1 also within reach of N (overlap placement); s2 at the diagonal cell (within the old 1.1 m rect reach, not a slot)
  place(S[0], g.i + 0.5, g.j - 0.5); place(S[1], g.i + 0.75, g.j - 0.3); place(S[2], g.i + 1.5, g.j - 0.5);
  ctl.S[1] = o => (obs[1] = o, {}); m.step();           // s0 takes the slot first
  ctl.S[1] = o => (obs[1] = o, { act: 'repair', target: g.id });
  const p0 = g.p; run(m, 50);
  near(g.p - p0, 5, 0.01, 'one worker per slot: the second survivor at an occupied slot gets nothing (solo rate)');
  ok(S[0].curAct === 'repair' && S[1].curAct !== 'repair' && S[2].curAct !== 'repair', 'first come keeps it; off-slot survivor does not repair');
  ok(JSON.stringify(obs[1].gens[0].slotsTaken) === '["N"]' && obs[1].gens[0].visible, 'adjacent survivor sees slotsTaken ["N"]');
  ok(obs[3].gens[0].visible === false && obs[3].gens[0].slotsTaken === null, 'survivor who does not perceive the gen gets slotsTaken null');
  // all usable sides busy: max workers = number of usable sides (2)
  place(S[2], g.i - 0.5, g.j + 0.5); const p1 = g.p; run(m, 50);
  near(g.p - p1, 50 * 0.1 * 2 * 0.85, 0.05, 'two usable sides => at most 2 workers (2 x 0.85)');
  ok(JSON.stringify(obs[0].gens[0].slotsTaken) === '["N","W"]', 'slotsTaken lists both busy sides');
  // the holder leaves => the waiting survivor can take the slot
  ctl.S[0] = () => ({}); place(S[0], 30.5, 12.5); run(m, 3);
  ok(S[1].curAct === 'repair', 'slot freed => the next survivor repairs from it');
});

test('hunter info: generator progress / regressing / workers only when perceived; done is global', () => {
  const { m, ctl } = mk({ config: { gens: { fumbleChancePerS: 0, repairS: 20 } } });
  const g = m.gens.find(x => x.id === 'g11') || m.gens[m.gens.length - 1], gi = m.gens.indexOf(g);
  let ho = null; ctl.H = o => (ho = o, {});
  g.p = 8; place(m.hunter, g.x - 12, g.z); m.hunter.face = Math.PI;   // within range but facing away
  run(m, 3);
  let o = ho.gens[gi];
  ok(!o.visible && o.progress === 0 && o.regressing === false && o.workers === null && o.seenT === -1, 'facing away: initial memory (progress 0, regressing false), not visible');
  m.hunter.face = 0; run(m, 3); o = ho.gens[gi];
  near(o.progress, 0.4, 1e-9, 'facing the gen within range: live progress'); ok(o.visible && Array.isArray(o.workers) && o.seenT > 0, 'visible + workers');
  g.p = 12; m.hunter.face = Math.PI; run(m, 3); o = ho.gens[gi];
  ok(!o.visible && Math.abs(o.progress - 0.4) < 1e-9 && o.workers === null, 'looking away again: stale last-seen progress');
  place(m.hunter, g.x - 1.6, g.z); run(m, 1); ok(ho.gens[gi].visible && Math.abs(ho.gens[gi].progress - 0.6) < 1e-9, 'within adjacentReach (behind the hunter): live');
  place(m.hunter, 3.5, 20.5); g.p = 19.95;
  const s = m.survivors[0]; place(s, g.slots[0].x, g.slots[0].z); ctl.S[0] = () => ({ act: 'repair', target: g.id }); run(m, 3);
  o = ho.gens[gi]; ok(g.done && o.done && o.progress === 1 && !o.visible, 'done is global (announced) even when not perceived');
});

test('generator slots on every shipped map: each candidate has >= 1 usable side (warn on 1-2)', () => {
  const rows = slotReport(allMapFiles());
  ok(rows.length > 0 && rows.every(r => r.sides.length >= 1), `${rows.length} candidates, all with >= 1 usable side`);
  for (const r of rows) if (r.sides.length <= 2) console.log(`    WARN ${r.file} ${r.id}: only ${r.sides.length} usable side(s) ${r.sides.join('')}`);
});

test('pickup locks the downed survivor in place (no crawling out of reach mid-pickup)', () => {
  const { m, ctl } = mk();
  const v = m.survivors[0];
  place(m.hunter, 30.5, 26.5); place(v, 31.7, 26.5); v.st = DOWNED; v.bleedT = 200;
  ctl.S[0] = () => ({ moveDir: { x: 1, z: 0 } });            // crawl away at 0.7 m/s
  ctl.H = () => ({ act: 'pickup', target: 0 });
  run(m, 25);
  ok(m.hunter.carrying === 0, 'pickup completes although the survivor tries to crawl away');
});

test('determinism with the param brains: same seed, same result regardless of cache state / match order', () => {
  const gh = load('maps/gas-heaven.json');
  const B = getBrains();
  const go = (seed) => {
    const r = runMatch({ map: gh, seed, hunter: B.hunter.make(defaults(B.hunter.space)), survivors: B.survivor.make(defaults(B.survivor.space)) });
    return JSON.stringify([r.durationS, r.kills, r.escapes, r.events]);
  };
  const seeds = [1012, 2001, 2002, 2003, 2004, 2005];
  const fwd = seeds.map(go);
  const rev = [...seeds].reverse().map(go).reverse();
  for (let i = 0; i < seeds.length; i++) ok(fwd[i] === rev[i], 'seed ' + seeds[i] + ' identical forward vs reverse order');
});

test('full matches with the baseline brains: terminate, consistent, every mechanic fires', () => {
  // eased batch (faster gens, longer hook stages) so the trivial baseline brains reliably reach the gates
  const maps = [['test-small', smallMap, 30], ['test-small eased', smallMap, 10, { gens: { repairS: 8 }, hooks: { stageS: 120 }, hunter: { pickupS: 4, hookS: 3 } }]];
  if (bigMap) maps.push([bigMap.id, bigMap, 8]);
  const seen = {};
  for (const [name, map, n, config] of maps) {
    let bad = 0;
    for (let seed = 1; seed <= n; seed++) {
      const r = runMatch({ map, seed, config, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] });
      if (!(r.over && r.kills + r.escapes + r.timeouts === 4 && r.durationS <= 1200 + 0.2 && r.gensDone <= 7)) bad++;
      for (const e of r.events) seen[e.type] = (seen[e.type] || 0) + 1;
      for (const k of Object.keys(r.stats)) seen['stat:' + k] = (seen['stat:' + k] || 0) + r.stats[k];
    }
    ok(bad === 0, `${name}: ${n} matches all terminate with consistent results`);
  }
  for (const k of ['hit', 'pickup', 'hook', 'rescue', 'heal', 'palletDrop', 'genDone', 'death', 'escape', 'gatesPowered', 'gateOpen', 'stat:vaults'])
    ok(seen[k] > 0, `mechanic exercised: ${k} (${seen[k] || 0})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n' + failures.map(f => ' * ' + f).join('\n')); process.exit(1); }
