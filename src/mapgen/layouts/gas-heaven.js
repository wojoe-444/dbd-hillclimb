// Gas Heaven layout spec: 112 x 96 m outline on an 8 m tile grid (14 x 12 cells, 156 playable).
// Landmarks sit at fixed slots read off docs/ref/gas-heaven-tiles-overview.png; everything else is rolled
// from weighted pools. "ring" = 8 m cells touching the outline (the lighter outer band in the reference).

export const gasHeavenLayout = {
  id: 'gas-heaven',
  name: 'Gas Heaven (tiles)',
  generator: 'mapgen/gas-heaven@3',
  size: { w: 112, h: 96 },
  cell: 8,
  outline: [[16, 0], [112, 0], [112, 64], [96, 64], [96, 96], [0, 96], [0, 16], [16, 16]],
  refCells: 156,   // playable 8 m cells of this outline; shaped variants scale pallet/hook budgets by their area / refCells
  // shaped variants (scripts/gen-maps.js gives every odd variant a seeded stepped outline, src/mapgen/outline.js):
  // 144-153 tiles (9216-9792 m²), aspect <= 1.6, min width 4 tiles; fixed pieces are refit by fitLayoutToOutline
  shapes: { minCells: 144, maxCells: 153, maxAspect: 1.6, minWidth: 4 },
  eyeHeight: 1.6,

  // landmarks: placed at a random free inner (non-ring) slot per seed (user 2026-11-16: the earlier owner-fixed
  // shack / T+L / jungle gym spots and the walled MID enclosure were scaffolding, retired with the tile generator).
  // One shack per map (any rotation, never mirrored, like DBD); one deliberately broken infinite-loop probe per map
  // (kept as the "do survivors find the obvious loop" canary); maze / car-pile pools keep the reference map's density.
  landmarks: [
    { tile: 'shack', random: true, mirror: false, label: 'S' },
    { tile: 'infinite-loop', random: true, label: 'BITIC' },
    { pool: 'maze', random: true },
    { pool: 'maze', random: true },
    { pool: 'maze', random: true },
    { pool: 'carpile', random: true },
  ],
  overlays: [],

  pools: {
    maze: { decay: 0.35, tiles: { 'pallet-gym': 1, 'four-lane-open': 1, 'four-lane-closed': 1 } },
    carpile: { decay: 0.6, tiles: { 'carpile-long': 1, 'carpile-short': 1 } },
    inner16: {
      decay: 0.6,
      tiles: { jgv1: 3, jgv2: 1.5, 'tl-wall': 3, 'filler-wallcar': 2, 'filler-rock': 2, 'variant-gym': 1.5, 'filler-junk': 1.5 },
    },
    inner8: {
      decay: 1,
      tiles: { 'dead-empty': 2, 'dead-gen': 1.5, 'dead-tree': 2, 'dead-rocks': 1.5, 'dead-car': 1, 'dead-tallrock': 4, 'dead-tallrock2': 2,   // user: more sight-blocking, non-loopable rocks
        'small-junk': 0.7, 'small-rock': 0.7, 'small-tires': 0.7, 'small-car': 0.7 },
    },
    ring8: {
      decay: 0.95,
      tiles: { 'dead-empty': 3, 'dead-gen': 1.5, 'dead-tree': 3, 'dead-rocks': 2, 'dead-car': 2, 'dead-tallrock': 4, 'dead-tallrock2': 2,
        'small-junk': 0.35, 'small-tires': 0.35, 'small-rock': 0.35 },
    },
  },
  bigTileChance: 0.55,

  pallets: { min: 14, max: 24 },
  gates: { minDistance: 75 },
  // Numeric spread limits are our single-floor approximation, not published BHVR constants.
  gens: { count: [11, 12], minSpacing: 20, require: [], minEdgeM: 6,
    selection: { minSpacingM: 24, minThreeGenTourM: 80, maxCoverageM: 40 } },
  hooks: { min: 16, max: 20, radius: 26, slotBonus: 25, jitter: 15 },   // radius was 20; the walled MID enclosure lengthens walks
  // perimeter spawns: survivor anchors (engine scatters 4 survivors within 15 m) + hunter points
  spawns: { survivorAnchors: 10, hunter: 10, inset: [4, 8], anchorOpenRadius: 15, anchorOpenFraction: 0.75 },
  deadZoneDistance: 12,

  labels: [],
};
