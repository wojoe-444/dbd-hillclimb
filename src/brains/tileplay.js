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

// Is a standing pallet's crossing c (side P = my entry) on the hunter's side? The pallet sits between the two side
// points; if the hunter is nearer (path) to my entry P than I am and not farther from P than from the far side Q,
// running to P meets it there: don't start that crossing (pick another entry / the other direction).
export function entryOnHunterSide(dMeP, dHP, dHQ, lungeM) {
  return dHP <= dHQ && dHP < dMeP + lungeM;
}
