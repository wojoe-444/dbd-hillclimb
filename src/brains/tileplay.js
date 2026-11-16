// Survivor chase helpers for playing a tile (pallet / window) well. Pure functions over obs + static map info; no state
// (solo-queue rule: brains keep their memory in their own closure). Used by survivor.js `chase()`.

// The visible hunter is breaking a dropped pallet (engine obs.hunter.act, only while I perceive it): which pallet
// (index into obs.pallets) and how long the break still takes (s). null otherwise.
export function palletBreakInfo(obs, map, cfg) {
  const h = obs.hunter;
  if (!h || h.act !== 'breakPallet' || h.actTarget === null || h.actTarget === undefined) return null;
  const i = map.pallets.findIndex((p) => p.id === h.actTarget);
  if (i < 0) return null;
  const dur = (cfg.hunter && cfg.hunter.breakPalletS) || 2.34;
  return { i, remainS: Math.max(0, (1 - (h.actProgress || 0)) * dur) };
}

// A view of obs in which the pallet being broken already counts as broken: loops through it stop being plans (no
// waiting behind it for the break to finish), and route scoring treats its cells as open.
export function withPalletGone(obs, i) {
  const pallets = obs.pallets.slice(); pallets[i] = 'broken';
  return { ...obs, pallets };
}

// Would a crossing land me on the hunter's side? Its landing point Q: the hunter (path distance, incl. its busy time
// as metres) gets there no later than I do plus its swing reach. Running a loop the other way / picking a crossing
// into the hunter (shack: the pallet door when the hunter comes from the south) ends in a hit at the pallet.
export function landingOnHunterSide(dMeQ, dHQ, reachM) {
  return dHQ < dMeQ + reachM;
}

// The hunter's body (circle r 0.4, + my 0.4) blocks a crossing lane: it stands on the crossing axis within the anchor's
// side points (centre +-1.6 m) and less than 0.9 m off the axis. Pushing into it gets nowhere (seen: a survivor kept
// walking into the hunter in front of its dropped pallet for 2 s until it was hit).
export function laneBlockedBy(h, a) {
  const s0 = a.s[0], s1 = a.s[1], ax = s1.x - s0.x, az = s1.z - s0.z, L = Math.hypot(ax, az) || 1;
  const ux = ax / L, uz = az / L, dx = h.x - a.c.x, dz = h.z - a.c.z;
  const along = dx * ux + dz * uz, lat = Math.abs(-dx * uz + dz * ux);
  return Math.abs(along) <= L / 2 + 0.2 && lat < 0.9;
}
