// Shared setup for the 1 hunter vs 1 survivor shack DUEL (maps/duel-shack.json), used by scripts/duel-shack.js (batch
// KPIs / traces) and viewer/duel.html (watch one duel). No imports on purpose: the sim + brains are passed in, so the
// script's --src option (sim + brains from another src/ tree) keeps working and the browser can load it as-is.
//
// The engine always runs 4 survivors and ends the match when <= 1 is left / all are down, so survivors 1-3 are idle
// dummies ({}), parked in the sealed 1-cell pocket strip x = 38 behind a 6 m block (unreachable, never visible). Spawns
// are overridden by placing the actors directly after createMatch.

// ---------------------------------------------------------------- geometry of the shack (see maps/duel-shack.json)
export const BOX = { x0: 11, z0: 11, x1: 21, z1: 21 };           // outer walls (cells 11..20)
export const inside = (x, z) => x > 12 && x < 20 && z > 12 && z < 20;   // interior cells 12..19 (body centre)
export const OPEN = {
  northDoor: { x: 14.0, z: 11.5 },
  window: { x: 20.5, z: 14.5 },
  palletDoor: { x: 18.0, z: 20.5 },
};
export const nearestOpening = (x, z) => { let best = null, bd = Infinity; for (const [k, p] of Object.entries(OPEN)) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = k; } } return { k: best, d: bd }; };
export const boxDist = (x, z) => { const dx = Math.max(BOX.x0 - x, 0, x - BOX.x1), dz = Math.max(BOX.z0 - z, 0, z - BOX.z1); return Math.hypot(dx, dz); };
/** Where the survivor is, as the duel report's hit / down "cause" categories. */
export function situation(x, z, { midVault = false, recentBreak = false, palletUp = true } = {}) {
  const op = nearestOpening(x, z);
  if (midVault) return 'mid-vault';
  if (recentBreak) return 'after-pallet-break';
  if (op.d < 2.2 && op.k === 'window') return 'at-window';
  if (op.d < 2.2 && op.k === 'palletDoor') return palletUp ? 'at-pallet-up' : 'at-pallet-door';
  if (op.d < 2.2) return 'at-north-door';
  if (inside(x, z)) return 'inside-shack';
  if (boxDist(x, z) < 2.5) return 'along-wall';
  return 'open-ground';
}

export const SPOTS = {
  inside: { x: 15.5, z: 16.5 },         // middle of the shack
  northDoor: { x: 14.0, z: 11.5 },      // standing in the open north doorway
  palletDoor: { x: 18.0, z: 21.6 },     // just outside the south pallet door
  window: { x: 21.6, z: 14.5 },         // outside, next to the east window
  outside: { x: 7.5, z: 16.5 },         // open ground 3.5 m west of the shack
};
export const DUMMY_POS = [{ x: 38.5, z: 12.5 }, { x: 38.5, z: 18.5 }, { x: 38.5, z: 24.5 }];   // pocket strip x = 38
export const dummy = () => ({ decide() { return {}; } });
export const HUNTER_MODES = ['strong', 'assist', 'brain'];

// ---------------------------------------------------------------- params
// Duel neutralisation of generator-driven hunter knobs: the gens sit in the unreachable pocket, and with
// clusterActivate >= 5 (default 5) the hunter's cluster leash sees an Infinity path distance to the gen cluster and
// abandons every chase where the survivor is farther from the pocket than itself (ignored for 15 s).
export const NEUTRALIZE = { clusterActivate: 0 };
/** champ = a champions.json `champ` object ({ hunter, survivor }) or null for defaults. */
export function duelParams(B, { defaults, clampParams }, { champ = null, hunterOverrides = NEUTRALIZE, survivorOverrides = {}, name } = {}) {
  if (!champ) return { name: name ?? 'default', hp: { ...defaults(B.hunter.space), ...hunterOverrides }, sp: { ...defaults(B.survivor.space), ...survivorOverrides } };
  return { name: name ?? 'champ', hp: { ...clampParams(B.hunter.space, champ.hunter), ...hunterOverrides }, sp: { ...clampParams(B.survivor.space, champ.survivor), ...survivorOverrides } };
}

// ---------------------------------------------------------------- setup grid
export const place = (o, x, z, face) => { o.x = x; o.z = z; o.vx = o.vz = 0; if (face !== undefined) o.face = face; };
export function hunterSpots(map, createMatch, spot) {
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
/** Setup grid: per spot, up to 4 hunter positions x healthy/injured. filter = { spot, health } (optional). */
export function buildGrid(map, createMatch, filter = {}) {
  const grid = [];
  for (const [spotName, spot] of Object.entries(SPOTS)) {
    if (filter.spot && filter.spot !== spotName) continue;
    const hs = hunterSpots(map, createMatch, spot);
    // up to 4 hunter positions spread over the valid ones (by angle), mixing distances
    hs.sort((p, q) => p.deg - q.deg || p.r - q.r);
    const pick = [];
    const want = Math.min(4, hs.length);
    for (let i = 0; i < want; i++) pick.push(hs[Math.floor((i * hs.length) / want + (i % 3) * 0.34 * (hs.length / want)) % hs.length]);
    for (const health of ['healthy', 'injured']) {
      if (filter.health && filter.health !== health) continue;
      for (const h of pick) grid.push({ spot: spotName, s: spot, h, health, id: `${spotName}/${health}/h${h.r}m@${h.deg}` });
    }
  }
  return grid;
}

// ---------------------------------------------------------------- one duel (match + harness), stepped by the caller
/**
 * Build one duel. opts: { map, createMatch, B (getBrains result), setup (grid row), seed, P ({ hp, sp }),
 *   hunterMode 'strong'|'assist'|'brain', assistAfter (s), jitter (m) }.
 * Hunter: the param brain always decides (its state stays consistent); in 'assist' mode, once it has NOT seen the
 * real survivor for assistAfter s, its action is replaced by "path to the survivor's true position" (a stand-in for
 * perfect scratch-mark tracking; short occlusions stay the brain's own): the brain's search / belief patrol stalls
 * next to the shack on this tiny map (see docs/research/shack-duel.md). 'strong' = assist + pallet discipline.
 * Returns { m, S, H, acts (recent survivor decide() actions), hAct() (hunter's last action, incl. harness overrides),
 *   counters { assistTicks, breakAssists }, start { hx, hz, sx, sz } }. The caller steps m and calls pushFix() on
 *   each survivor palletDrop event (see below).
 */
export function createDuel({ map, createMatch, B, setup, seed, P, hunterMode = 'strong', assistAfter = 3, jitter = 0.5 }) {
  const sBrainFactory = B.survivor.make(P.sp);
  const acts = [];   // survivor actions (decide calls)
  const wrapped = (ctx) => {
    const br = sBrainFactory(ctx);
    return { ...br, decide(obs, api) { const act = br.decide(obs, api); acts.push({ t: obs.t, act }); if (acts.length > 400) acts.splice(0, 200); return act; }, get stats() { return br.stats; }, get debug() { return br.debug; } };
  };
  const hFactory = B.hunter.make(P.hp);
  let hAct = {}, S = null, lastSeenT = 0;
  const counters = { assistTicks: 0, breakAssists: 0 };
  const hWrapped = (ctx) => {
    const br = hFactory(ctx);
    return { ...br, decide(obs, api) {
      hAct = br.decide(obs, api) || {};
      const sees = obs.survivors.some((s) => s.id === 0 && (s.state === 'healthy' || s.state === 'injured'));
      if (sees) lastSeenT = obs.t;
      if (hunterMode !== 'brain' && S && S.st <= 1 && !sees && obs.t - lastSeenT >= assistAfter) {
        hAct = { moveTo: { x: S.x, z: S.z }, assisted: true }; counters.assistTicks++;
      }
      // 'strong' adds pallet discipline: a dropped shack pallet within 3 m gets broken (walk up + break), unless the
      // survivor is in swing range on my side (the brain's attack wins then)
      if (hunterMode === 'strong' && obs.pallets[0] === 'dropped' && !obs.self.carrying && !(hAct.act === 'attack')) {
        const pl = ctx.map.pallets[0], dp = Math.hypot(pl.cx - obs.self.x, pl.cz - obs.self.z);
        if (dp <= 3) { hAct = { moveTo: { x: pl.cx, z: pl.cz }, act: 'breakPallet', target: pl.id, assisted: true }; counters.breakAssists++; }
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
  if (jitter > 0) {
    const free = (x, z) => m.md.kind[Math.floor(z) * m.W + Math.floor(x)] === 0 && m.md.kind[Math.floor(z - 0.4) * m.W + Math.floor(x)] !== 1 && m.md.kind[Math.floor(z + 0.4) * m.W + Math.floor(x)] !== 1 && m.md.kind[Math.floor(z) * m.W + Math.floor(x - 0.4)] !== 1 && m.md.kind[Math.floor(z) * m.W + Math.floor(x + 0.4)] !== 1;
    const hx2 = hx + 2 * jitter * jr(), hz2 = hz + 2 * jitter * jr(), sx2 = sx + 1.2 * jitter * jr(), sz2 = sz + 1.2 * jitter * jr();
    if (free(hx2, hz2) && free(sx2, sz2) && H.api.los({ x: hx2, z: hz2 }, { x: sx2, z: sz2 })) { hx = hx2; hz = hz2; sx = sx2; sz = sz2; }
  }
  place(H, hx, hz, Math.atan2(sz - hz, sx - hx));
  place(S, sx, sz, Math.atan2(hz - sz, hx - sx));              // survivor (body + camera) faces the hunter
  S.camYaw = S.face; S.camX = sx; S.camZ = sz; S.camTick = -1;
  if (setup.health === 'injured') S.st = 1;
  return { m, S, H, acts, hAct: () => hAct, counters, start: { hx, hz, sx, sz } };
}

/**
 * Engine gap: the pallet-drop push-out only moves actors whose CENTRE is inside the footprint; a hunter whose body
 * circle overlaps it (centre within R of the footprint edge) is left overlapping a solid cell and can then get stuck
 * for good along the shack wall. Call on each survivor palletDrop event: returns true if the hunter overlapped; with
 * apply, moves it out (the intended push-out).
 */
export function pushFix(m, apply = true) {
  const H = m.hunter, pl = m.md.pallets[0], R = m.R;
  const ov = pl.axis === 'z' ? (H.x > pl.x0 - R && H.x < pl.x1 + R && H.z > pl.z0 - R && H.z < pl.z1 + R)
                             : (H.z > pl.z0 - R && H.z < pl.z1 + R && H.x > pl.x0 - R && H.x < pl.x1 + R);
  if (ov && apply && !H.vault) { if (pl.axis === 'z') H.z = H.z < pl.cz ? pl.z0 - 0.5 : pl.z1 + 0.5; else H.x = H.x < pl.cx ? pl.x0 - 0.5 : pl.x1 + 0.5; }
  return ov;
}
