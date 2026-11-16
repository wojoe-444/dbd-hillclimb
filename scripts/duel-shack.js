// 1 hunter vs 1 survivor DUEL on maps/duel-shack.json (only the standard "killer shack" tile), to see how the bots
// play that loop. KPI = seconds the survivor stays alive (until its first down; capped). No engine/brain edits:
//   * the engine always runs 4 survivors and ends the match when <= 1 is left / all are down, so survivors 1-3 are
//     idle dummies ({}), parked in the sealed 1-cell pocket strip x = 38 behind a 6 m block (unreachable, never visible);
//   * spawns are overridden by placing the actors directly after createMatch (like scripts/test-sim.js `place()`);
//   * per-tick traces come from the live match state + events, and from a thin wrapper around the survivor brain's
//     decide() (actions only; obs are not altered).
//
// node scripts/duel-shack.js [--n 64] [--cap 120] [--champ runs/evo-v13/champions.json] [--compare]
//        [--sp knob=v,knob=v]                       (survivor knob overrides, e.g. --sp stunSeek=0,holdMaxS=0)
//        [--hp knob=v,knob=v]                       (hunter knob overrides, e.g. --hp reverseChance=0.5,predictLeadS=0.5)
//        [--mix]                                    (2x2: default/champ hunter x default/champ survivor)
//        [--seed0 1000] [--spot inside|northDoor|palletDoor|window|outside] [--health healthy|injured]
//        [--hunter strong|assist|brain] [--assistAfter 3]   (default strong = assist + breaks the dropped pallet; see duel())
//        [--jitter 0.5]                             (seeded start-position jitter, m)
//        [--noNeutralize]                           (keep the gen-cluster leash of the hunter; pocket artifact)
//        [--noPushFix]                              (don't push a pallet-overlapping hunter out; engine gap)
//        [--src <dir>]                              (sim + brains from another src/ tree, e.g. a HEAD snapshot)
//        [--out file.json] [--list]                 (--list prints every duel row)
//        [--trace <duelIndex>] [--every 0.5]        (prints a per-tick narrative for one duel; same --n/--seed0 grid)
// Report: docs/research/shack-duel.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; } }
// --src <dir>: import sim + brains from another checkout of src/ (e.g. a `git archive HEAD src` snapshot), so results
// don't move while someone edits the working tree. Default: this repo's src/.
const SRC = a.src ? resolve(a.src) : fileURLToPath(new URL('../src/', import.meta.url));
const imp = (rel) => import(pathToFileURL(resolve(SRC, rel)).href);
const { createMatch } = await imp('sim/index.js');
const { getBrains } = await imp('brains/index.js');
const { defaults, clampParams } = await imp('hillclimb/params.js');
const N = +(a.n ?? 64), CAP = +(a.cap ?? 120), SEED0 = +(a.seed0 ?? 1000);
const HUNTER_MODE = a.hunter ?? 'strong';   // strong | assist | brain (see duel())
const ASSIST_AFTER = +(a.assistAfter ?? 3);
const PUSH_FIX = !a.noPushFix;              // harness push-out of a hunter overlapping the dropped pallet (engine gap, see duel())  // assist: take over once the hunter hasn't seen the survivor for this long (s)
if (!['assist', 'strong', 'brain'].includes(HUNTER_MODE)) throw new Error('--hunter assist|strong|brain');
const JITTER = a.jitter === undefined ? 0.5 : +a.jitter;   // seeded start-position jitter (m), hunter; survivor gets 0.6x
const map = JSON.parse(readFileSync(a.map ?? 'maps/duel-shack.json', 'utf8'));

// ---------------------------------------------------------------- geometry of the shack (see maps/duel-shack.json)
const BOX = { x0: 11, z0: 11, x1: 21, z1: 21 };           // outer walls (cells 11..20)
const inside = (x, z) => x > 12 && x < 20 && z > 12 && z < 20;   // interior cells 12..19 (body centre)
const OPEN = {
  northDoor: { x: 14.0, z: 11.5 },
  window: { x: 20.5, z: 14.5 },
  palletDoor: { x: 18.0, z: 20.5 },
};
const nearestOpening = (x, z) => { let best = null, bd = Infinity; for (const [k, p] of Object.entries(OPEN)) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = k; } } return { k: best, d: bd }; };
const boxDist = (x, z) => { const dx = Math.max(BOX.x0 - x, 0, x - BOX.x1), dz = Math.max(BOX.z0 - z, 0, z - BOX.z1); return Math.hypot(dx, dz); };

const SPOTS = {
  inside: { x: 15.5, z: 16.5 },         // middle of the shack
  northDoor: { x: 14.0, z: 11.5 },      // standing in the open north doorway
  palletDoor: { x: 18.0, z: 21.6 },     // just outside the south pallet door
  window: { x: 21.6, z: 14.5 },         // outside, next to the east window
  outside: { x: 7.5, z: 16.5 },         // open ground 3.5 m west of the shack
};
const DUMMY_POS = [{ x: 38.5, z: 12.5 }, { x: 38.5, z: 18.5 }, { x: 38.5, z: 24.5 }];   // pocket strip x = 38
const dummy = () => ({ decide() { return {}; } });

// ---------------------------------------------------------------- brains
const B = getBrains('param', 'param');
// Duel neutralisation of generator-driven hunter knobs: the gens sit in the unreachable pocket, and with
// clusterActivate >= 5 (default 5) the hunter's cluster leash sees an Infinity path distance to the gen cluster and
// abandons every chase where the survivor is farther from the pocket than itself (ignored for 15 s). --noNeutralize keeps it.
// --hp key=val,key=val: hunter knob overrides (on top of the neutralisation), e.g. --hp reverseChance=0.5,predictLeadS=0.5
const HP_OVERRIDES = Object.fromEntries((a.hp ? String(a.hp).split(',') : []).map((kv) => { const [k, v] = kv.split('='); if (!(k in B.hunter.space)) throw new Error('unknown hunter knob ' + k); return [k, +v]; }));
const HUNTER_OVERRIDES = { ...(a.noNeutralize ? {} : { clusterActivate: 0 }), ...HP_OVERRIDES };
// --sp key=val,key=val: survivor knob overrides on top of default / champion knobs (sensitivity checks)
const SP_OVERRIDES = Object.fromEntries((a.sp ? String(a.sp).split(',') : []).map((kv) => { const [k, v] = kv.split('='); if (!(k in B.survivor.space)) throw new Error('unknown survivor knob ' + k); return [k, +v]; }));
const loadParams = (champ) => {
  if (!champ) return { name: 'default', hp: { ...defaults(B.hunter.space), ...HUNTER_OVERRIDES }, sp: { ...defaults(B.survivor.space), ...SP_OVERRIDES } };
  const c = JSON.parse(readFileSync(champ, 'utf8')).champ;
  return { name: champ, hp: { ...clampParams(B.hunter.space, c.hunter), ...HUNTER_OVERRIDES }, sp: { ...clampParams(B.survivor.space, c.survivor), ...SP_OVERRIDES } };
};

// ---------------------------------------------------------------- setup grid
const place = (o, x, z, face) => { o.x = x; o.z = z; o.vx = o.vz = 0; if (face !== undefined) o.face = face; };
function hunterSpots(spot) {
  // candidate hunter positions 8 / 12 / 16 m away at 8 angles, on free open ground, with line of sight to the survivor
  const m = createMatch({ map, seed: 1, hunter: dummy, survivors: dummy });
  const out = [];
  for (const r of [8, 12, 16]) for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4 + (r === 12 ? Math.PI / 8 : 0);
    const x = Math.floor(spot.x + r * Math.cos(ang)) + 0.5;     // cell centres
    const z = Math.floor(spot.z + r * Math.sin(ang)) + 0.5;
    if (x < 1.5 || z < 1.5 || x > 30.5 || z > 30.5) continue;
    if (boxDist(x, z) < 1.5) continue;                                       // not inside / hugging the shack
    const c = Math.floor(z) * m.W + Math.floor(x);
    if (m.md.kind[c] !== 0) continue;
    if (!m.hunter.api.los({ x, z }, spot)) continue;
    out.push({ x, z, r, deg: Math.round((ang * 180) / Math.PI) });
  }
  return out;
}
function buildGrid() {
  const grid = [];
  for (const [spotName, spot] of Object.entries(SPOTS)) {
    if (a.spot && a.spot !== spotName) continue;
    const hs = hunterSpots(spot);
    // up to 4 hunter positions spread over the valid ones (by angle), mixing distances
    hs.sort((p, q) => p.deg - q.deg || p.r - q.r);
    const pick = [];
    const want = Math.min(4, hs.length);
    for (let i = 0; i < want; i++) pick.push(hs[Math.floor((i * hs.length) / want + (i % 3) * 0.34 * (hs.length / want)) % hs.length]);
    for (const health of ['healthy', 'injured']) {
      if (a.health && a.health !== health) continue;
      for (const h of pick) grid.push({ spot: spotName, s: spot, h, health, id: `${spotName}/${health}/h${h.r}m@${h.deg}` });
    }
  }
  return grid;
}

// ---------------------------------------------------------------- one duel
function duel(setup, seed, P, opts = {}) {
  const trace = [];
  const sBrainFactory = B.survivor.make(P.sp);
  const acts = [];   // survivor actions (decide calls)
  const wrapped = (ctx) => {
    const br = sBrainFactory(ctx);
    return { ...br, decide(obs, api) { const act = br.decide(obs, api); acts.push({ t: obs.t, act }); if (acts.length > 400) acts.splice(0, 200); return act; }, get stats() { return br.stats; } };
  };
  // hunter: the param brain always decides (its state stays consistent); in 'assist' mode, once it has NOT seen the
  // real survivor for ASSIST_AFTER s, its action is replaced by "path to the survivor's true position" (a stand-in for
  // perfect scratch-mark tracking; short occlusions stay the brain's own): the brain's search / belief patrol stalls
  // next to the shack on this tiny map (see docs/research/shack-duel.md).
  const hFactory = B.hunter.make(P.hp);
  let hAct = {}, S = null, assistTicks = 0, lastSeenT = 0, breakAssists = 0;
  const hWrapped = (ctx) => {
    const br = hFactory(ctx);
    return { ...br, decide(obs, api) {
      hAct = br.decide(obs, api) || {};
      const sees = obs.survivors.some((s) => s.id === 0 && (s.state === 'healthy' || s.state === 'injured'));
      if (sees) lastSeenT = obs.t;
      if (HUNTER_MODE !== 'brain' && S && S.st <= 1 && !sees && obs.t - lastSeenT >= ASSIST_AFTER) {
        hAct = { moveTo: { x: S.x, z: S.z }, assisted: true }; assistTicks++;
      }
      // 'strong' adds pallet discipline: a dropped shack pallet within 3 m gets broken (walk up + break), unless the
      // survivor is in swing range on my side (the brain's attack wins then)
      if (HUNTER_MODE === 'strong' && obs.pallets[0] === 'dropped' && !obs.self.carrying && !(hAct.act === 'attack')) {
        const pl = ctx.map.pallets[0], dp = Math.hypot(pl.cx - obs.self.x, pl.cz - obs.self.z);
        if (dp <= 3) { hAct = { moveTo: { x: pl.cx, z: pl.cz }, act: 'breakPallet', target: pl.id, assisted: true }; breakAssists++; }
      }
      return hAct;
    } };
  };
  const m = createMatch({ map, seed, hunter: hWrapped, survivors: [wrapped, dummy, dummy, dummy] });
  S = m.survivors[0];
  const H = m.hunter;
  for (let i = 0; i < 3; i++) place(m.survivors[i + 1], DUMMY_POS[i].x, DUMMY_POS[i].z);
  // seeded jitter of both start positions (kept on free cells with line of sight; else unjittered)
  let js = (seed * 2654435761) >>> 0;
  const jr = () => { js = (js * 1664525 + 1013904223) >>> 0; return js / 4294967296 - 0.5; };
  let hx = setup.h.x, hz = setup.h.z, sx = setup.s.x, sz = setup.s.z;
  if (JITTER > 0) {
    const free = (x, z) => m.md.kind[Math.floor(z) * m.W + Math.floor(x)] === 0 && m.md.kind[Math.floor(z - 0.4) * m.W + Math.floor(x)] !== 1 && m.md.kind[Math.floor(z + 0.4) * m.W + Math.floor(x)] !== 1 && m.md.kind[Math.floor(z) * m.W + Math.floor(x - 0.4)] !== 1 && m.md.kind[Math.floor(z) * m.W + Math.floor(x + 0.4)] !== 1;
    const hx2 = hx + 2 * JITTER * jr(), hz2 = hz + 2 * JITTER * jr(), sx2 = sx + 1.2 * JITTER * jr(), sz2 = sz + 1.2 * JITTER * jr();
    if (free(hx2, hz2) && free(sx2, sz2) && H.api.los({ x: hx2, z: hz2 }, { x: sx2, z: sz2 })) { hx = hx2; hz = hz2; sx = sx2; sz = sz2; }
  }
  place(H, hx, hz, Math.atan2(sz - hz, sx - hx));
  place(S, sx, sz, Math.atan2(hz - sz, hx - sx));              // survivor (body + camera) faces the hunter
  S.camYaw = S.face; S.camX = sx; S.camZ = sz; S.camTick = -1;
  if (setup.health === 'injured') S.st = 1;

  const r = {
    id: setup.id, spot: setup.spot, health: setup.health, hunterR: setup.h.r, hunterDeg: setup.h.deg, seed,
    tHit1: null, tDown: null, aliveS: CAP, capped: false, gapAtHit1: null, gapAfterHit1: null,
    winVaults: { fast: 0, medium: 0, slow: 0 }, palletVaults: 0, hunterVaults: 0,
    palletDropT: null, palletStun: null, palletBreakT: null, palletState: 'up',
    passes: [], laps: 0, enteredShack: inside(sx, sz), insideS: 0, maxBloodlust: 0,
    windowBlockedT: null, windowBlockedAtEnd: false, chases: 0, chaseEnds: [],
    hunterBlindS: 0, hunterStuckS: 0, pushOverlap: 0, survStillNearS: 0, hits: [], cause: null,
  };
  const hPos = [];
  let evI = 0, prevIn = inside(sx, sz), prevVault = null, prevHVault = null, prevSX = sx, prevSZ = sz, lastOpening = null;
  const wasVaulting = [];   // survivor vault state over the last 2 ticks
  const cell = (x, z) => Math.floor(z) * m.W + Math.floor(x);
  const every = Math.max(1, Math.round((+(a.every ?? 0.5)) * 10));
  const classify = (t) => {
    const midVault = !!S.vault || wasVaulting.some(Boolean);
    const op = nearestOpening(S.x, S.z);
    const pal = m.ps[0];
    const recentBreak = r.palletBreakT !== null && t - r.palletBreakT < 8;
    let c;
    if (midVault) c = 'mid-vault';
    else if (recentBreak) c = 'after-pallet-break';
    else if (op.d < 2.2 && op.k === 'window') c = 'at-window';
    else if (op.d < 2.2 && op.k === 'palletDoor') c = pal === 0 ? 'at-pallet-up' : 'at-pallet-door';
    else if (op.d < 2.2) c = 'at-north-door';
    else if (inside(S.x, S.z)) c = 'inside-shack';
    else if (boxDist(S.x, S.z) < 2.5) c = 'along-wall';
    else c = 'open-ground';
    return { t, c, x: +S.x.toFixed(1), z: +S.z.toFixed(1), hx: +H.x.toFixed(1), hz: +H.z.toFixed(1), d: +Math.hypot(H.x - S.x, H.z - S.z).toFixed(2),
      bloodlust: m.blTier, pallet: ['up', 'dropped', 'broken'][pal], winBlocked: m.winBlockT[0] > m.t, opening: op.k, opD: +op.d.toFixed(1) };
  };

  while (!m.over && m.t < CAP - 1e-9) {
    m.step();
    const t = +m.t.toFixed(2);
    // events
    for (; evI < m.events.length; evI++) {
      const e = m.events[evI];
      if (e.type === 'hit' && e.who === 0) {
        const cl = classify(t);
        r.hits.push({ ...cl, state: e.state });
        if (r.tHit1 === null) { r.tHit1 = t; r.gapAtHit1 = cl.d; }
        if (e.state === 'downed') { r.tDown = t; r.aliveS = t; r.cause = cl.c; }
      } else if (e.type === 'palletDrop' && e.by === 0) {
        r.palletDropT = t; r.palletStun = !!e.stun;
        // engine gap: the push-out only moves actors whose CENTRE is inside the footprint; a hunter whose body circle
        // overlaps it (centre within R of the footprint edge) is left overlapping a solid cell and can then get stuck
        // for good along the shack wall. PUSH_FIX applies the intended push-out to the hunter here.
        const pl = m.md.pallets[0], R = m.R;
        const ov = pl.axis === 'z' ? (H.x > pl.x0 - R && H.x < pl.x1 + R && H.z > pl.z0 - R && H.z < pl.z1 + R)
                                   : (H.z > pl.z0 - R && H.z < pl.z1 + R && H.x > pl.x0 - R && H.x < pl.x1 + R);
        if (ov) { r.pushOverlap = (r.pushOverlap || 0) + 1; if (PUSH_FIX && !H.vault) { if (pl.axis === 'z') H.z = H.z < pl.cz ? pl.z0 - 0.5 : pl.z1 + 0.5; else H.x = H.x < pl.cx ? pl.x0 - 0.5 : pl.x1 + 0.5; } }
      }
      else if (e.type === 'palletBreak') { r.palletBreakT = t; const pl = m.md.pallets[0]; r.survDistAtBreak = +Math.hypot(S.x - pl.cx, S.z - pl.cz).toFixed(2); r.windowDistAtBreak = +Math.hypot(S.x - OPEN.window.x, S.z - OPEN.window.z).toFixed(2); }
      else if (e.type === 'bloodlust') r.maxBloodlust = Math.max(r.maxBloodlust, e.tier);
      else if (e.type === 'windowBlocked' && e.who === 0 && r.windowBlockedT === null) r.windowBlockedT = t;
      else if (e.type === 'chaseStart' && e.who === 0) r.chases++;
      else if (e.type === 'chaseEnd' && e.who === 0) r.chaseEnds.push({ t, reason: e.reason });
    }
    // vaults
    if (S.vault && S.vault !== prevVault) {
      const k = m.md.kind[S.vault.cell];
      if (k === 2 || k === 3) { const d = S.vault.dur; if (d <= m.cfg.survivor.vaultFastS + 1e-9) r.winVaults.fast++; else if (d <= m.cfg.survivor.vaultMediumS + 1e-9) r.winVaults.medium++; else r.winVaults.slow++; }
      else r.palletVaults++;
    }
    prevVault = S.vault;
    if (H.vault && H.vault !== prevHVault) r.hunterVaults++;
    prevHVault = H.vault;
    wasVaulting.push(!!S.vault); if (wasVaulting.length > 2) wasVaulting.shift();
    // passes through the shack's openings (interior <-> exterior transitions)
    const nowIn = inside(S.x, S.z);
    const op = nearestOpening(S.x, S.z);
    if (op.d < 1.6) lastOpening = op.k;
    if (nowIn !== prevIn) { r.passes.push({ t, via: lastOpening ?? nearestOpening(prevSX, prevSZ).k, dir: nowIn ? 'in' : 'out' }); if (nowIn) r.enteredShack = true; }
    if (nowIn) r.insideS += m.dt;
    prevIn = nowIn;
    // hunter lost sight / survivor standing still near the hunter
    if (!H.seen[0]) r.hunterBlindS += m.dt;
    // hunter stuck: wants to move (moveTo), free to move, but has not moved 0.5 m over the last 3 s
    const hFree = hAct.moveTo && !hAct.act && !H.vault && !(H.stunT > 0) && !(H.cdT > 0) && !(H.windT > 0);
    hPos.push(hFree ? [H.x, H.z] : null); if (hPos.length > 30) hPos.shift();
    if (hPos.length === 30 && hPos.every(Boolean) && Math.hypot(H.x - hPos[0][0], H.z - hPos[0][1]) < 0.5) r.hunterStuckS += m.dt;
    const sp = Math.hypot(S.x - prevSX, S.z - prevSZ) / m.dt;
    if (sp < 0.5 && !S.vault && Math.hypot(H.x - S.x, H.z - S.z) < 8 && S.st <= 1) r.survStillNearS += m.dt;
    prevSX = S.x; prevSZ = S.z;
    r.maxBloodlust = Math.max(r.maxBloodlust, m.blTier);
    if (r.tHit1 !== null && r.gapAfterHit1 === null && r.tDown === null && t >= r.tHit1 + 2.7 - 1e-6) r.gapAfterHit1 = +Math.hypot(H.x - S.x, H.z - S.z).toFixed(2);   // after the hunter's hit cooldown

    if (opts.trace && (m.tick % every === 0 || m.events.length && m.events[m.events.length - 1].t === t)) {
      const la = acts.length ? acts[acts.length - 1].act : {};
      const mv = la.moveTo ? `->(${la.moveTo.x.toFixed(1)},${la.moveTo.z.toFixed(1)})` : la.moveDir ? `dir(${la.moveDir.x.toFixed(2)},${la.moveDir.z.toFixed(2)})` : 'stand';
      const evs = m.events.filter(e => e.t === t && e.type !== 'start').map(e => e.type + (e.who !== undefined ? ':' + e.who : '') + (e.state ? ':' + e.state : '') + (e.stun ? ':STUN' : '') + (e.tier ? ':' + e.tier : '') + (e.reason ? ':' + e.reason : '')).join(' ');
      trace.push(`${t.toFixed(1).padStart(5)}  S(${S.x.toFixed(1)},${S.z.toFixed(1)}) ${['H', 'I', 'D'][S.st] ?? S.st}${S.vault ? ' VAULT' + S.vault.dur : ''}${nowIn ? ' in' : ''}  ${mv}${la.walk ? ' walk' : ''}${la.act ? ' ' + la.act : ''}` +
        `   H(${H.x.toFixed(1)},${H.z.toFixed(1)})${hAct.assisted ? ' A' : ''}${hAct.moveTo ? '->(' + hAct.moveTo.x.toFixed(1) + ',' + hAct.moveTo.z.toFixed(1) + ')' : ''}${hAct.act ? ' ' + hAct.act : ''}${H.vault ? ' VAULT' : ''}${H.stunT > 0 ? ' STUN' : ''}${H.windT > 0 ? ' WINDUP' : ''}${H.cdT > 0 ? ' cd' : ''}${H.seen[0] ? '' : ' blind'}  d=${Math.hypot(H.x - S.x, H.z - S.z).toFixed(1)} bl${m.blTier} pal=${'udb'[m.ps[0]]}${m.winBlockT[0] > m.t ? ' WINBLOCK' : ''}  ${evs}`);
    }
    if (r.tDown !== null) break;
  }
  if (r.tDown === null) r.capped = true;
  r.palletState = ['up', 'dropped', 'broken'][m.ps[0]];
  r.windowBlockedAtEnd = m.winBlockT[0] > m.t;
  r.laps = +(r.passes.length / 2).toFixed(1);
  r.passVia = r.passes.reduce((o, p) => { o[p.via] = (o[p.via] || 0) + 1; return o; }, {});
  r.hunterBlindS = +r.hunterBlindS.toFixed(1); r.hunterStuckS = +r.hunterStuckS.toFixed(1); r.insideS = +r.insideS.toFixed(1); r.survStillNearS = +r.survStillNearS.toFixed(1);
  r.assistS = +(assistTicks * m.dt).toFixed(1); r.breakAssistS = +(breakAssists * m.dt).toFixed(1);
  r.hunterEndPos = { x: +H.x.toFixed(1), z: +H.z.toFixed(1) };
  r.overEarly = m.over ? m.result().endReason : null;   // should stay null (dummies keep the match alive)
  return { r, trace };
}

// ---------------------------------------------------------------- summary
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((p, q) => p - q); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '  - ');
function summarize(rows, label) {
  const groups = new Map();
  for (const r of rows) { const k = `${r.spot}/${r.health}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const line = (k, rs) => {
    const alive = rs.map(r => r.aliveS), hit1 = rs.filter(r => r.tHit1 !== null).map(r => r.tHit1);
    const wv = rs.reduce((s, r) => s + r.winVaults.fast + r.winVaults.medium + r.winVaults.slow, 0) / rs.length;
    const fastShare = rs.reduce((s, r) => s + r.winVaults.fast, 0) / Math.max(1, rs.reduce((s, r) => s + r.winVaults.fast + r.winVaults.medium + r.winVaults.slow, 0));
    const drops = rs.filter(r => r.palletDropT !== null).length, stuns = rs.filter(r => r.palletStun).length;
    return `${k.padEnd(22)} n=${String(rs.length).padStart(3)}  alive mean ${f1(mean(alive)).padStart(5)} med ${f1(median(alive)).padStart(5)} capped ${String(rs.filter(r => r.capped).length).padStart(2)}` +
      `  hit1 ${f1(mean(hit1)).padStart(5)}  winV ${wv.toFixed(1)} (fast ${(100 * fastShare).toFixed(0)}%)  drop ${drops}/${rs.length} stun ${stuns}  laps ${mean(rs.map(r => r.laps)).toFixed(1)}  in ${rs.filter(r => r.enteredShack).length}/${rs.length}  BL ${mean(rs.map(r => r.maxBloodlust)).toFixed(1)}  blk ${rs.filter(r => r.windowBlockedT !== null).length}`;
  };
  console.log(`\n=== ${label} [hunter mode ${HUNTER_MODE}]: ${rows.length} duels, cap ${CAP} s ===`);
  for (const [k, rs] of [...groups.entries()].sort()) console.log(line(k, rs));
  console.log(line('ALL', rows));
  const causes = {}; for (const r of rows) { const c = r.cause ?? 'survived-cap'; causes[c] = (causes[c] || 0) + 1; }
  console.log('down causes:', Object.entries(causes).sort((p, q) => q[1] - p[1]).map(([c, n]) => `${c} ${n}`).join(', '));
  const h1 = {}; for (const r of rows) if (r.hits[0]) { const c = r.hits[0].c; h1[c] = (h1[c] || 0) + 1; }
  console.log('first-hit causes:', Object.entries(h1).sort((p, q) => q[1] - p[1]).map(([c, n]) => `${c} ${n}`).join(', '));
  const early = rows.filter(r => r.overEarly); if (early.length) console.log('WARNING: match ended by an engine rule in', early.length, 'duels');
}

// ---------------------------------------------------------------- main
const grid = buildGrid();
if (!grid.length) { console.error('empty setup grid'); process.exit(1); }
// --compare: default knobs vs the champion (hunter + survivor); --mix: all four hunter x survivor combinations
const CH = a.champ ?? 'runs/evo-v13/champions.json';
const mixed = (h, s) => { const H0 = loadParams(h ? CH : null), S0 = loadParams(s ? CH : null); return { name: `hunter:${h ? 'champ' : 'default'} survivor:${s ? 'champ' : 'default'}`, hp: H0.hp, sp: S0.sp }; };
const runs = a.mix ? [mixed(0, 0), mixed(0, 1), mixed(1, 0), mixed(1, 1)]
  : a.compare ? [loadParams(null), loadParams(CH)] : [loadParams(a.champ)];
if (a.trace !== undefined) {
  const i = +a.trace, setup = grid[i % grid.length], seed = SEED0 + i;
  for (const P of runs) {
    const { r, trace } = duel(setup, seed, P, { trace: true });
    console.log(`# duel ${i} [${P.name}] ${setup.id} seed ${seed}: hunter (${setup.h.x},${setup.h.z}) survivor (${setup.s.x},${setup.s.z})`);
    console.log(trace.join('\n'));
    console.log(JSON.stringify({ ...r, passes: r.passes }, null, 0));
  }
  process.exit(0);
}
const out = {};
const t0 = Date.now();
for (const P of runs) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    const setup = grid[i % grid.length];
    const { r } = duel(setup, SEED0 + i, P);
    r.index = i;
    rows.push(r);
    if (a.list) console.log(`#${i} ${r.id} seed ${r.seed}: alive ${r.aliveS}s hit1 ${r.tHit1} cause ${r.cause} | winV f${r.winVaults.fast}/m${r.winVaults.medium}/s${r.winVaults.slow} palV ${r.palletVaults} hV ${r.hunterVaults} drop ${r.palletDropT}${r.palletStun ? ' STUN' : ''} brk ${r.palletBreakT} laps ${r.laps} ${JSON.stringify(r.passVia)} in ${r.enteredShack} BL ${r.maxBloodlust} blk ${r.windowBlockedT} blind ${r.hunterBlindS}s still ${r.survStillNearS}s assist ${r.assistS}s stuck ${r.hunterStuckS}s ovl ${r.pushOverlap}`);
  }
  summarize(rows, P.name);
  out[P.name] = rows;
}
console.log(`\n${grid.length} setups, ${N} duels per brain set, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (a.out) writeFileSync(a.out, JSON.stringify({ map: map.id, cap: CAP, seed0: SEED0, grid: grid.map(g => ({ id: g.id, s: g.s, h: g.h })), results: out }, null, 1));
