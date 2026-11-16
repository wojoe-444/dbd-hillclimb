// Gas Heaven layout spec: 112 x 96 m outline on an 8 m tile grid (14 x 12 cells, 156 playable).
// Landmarks sit at fixed slots read off docs/ref/gas-heaven-tiles-overview.png; everything else is rolled
// from weighted pools. "ring" = 8 m cells touching the outline (the lighter outer band in the reference).

export const gasHeavenLayout = {
  id: 'gas-heaven',
  name: 'Gas Heaven (tiles)',
  generator: 'mapgen/gas-heaven@1',
  size: { w: 112, h: 96 },
  cell: 8,
  outline: [[16, 0], [112, 0], [112, 64], [96, 64], [96, 96], [0, 96], [0, 16], [16, 16]],
  eyeHeight: 1.6,

  landmarks: [
    { tile: 'tl-wall', x: 48, z: 16 },        // user: T + L in place of the old main building (centred in its 32 m slot; the rest is rolled)
    { tile: 'shack', x: 8, z: 72, mirror: false },   // S: user-fixed spot (bottom-left between 8 and 7); any of 4 rotations, never mirrored
    { pool: 'maze', x: 88, z: 8 },            // mazetile NE (between 1 and 2)
    { pool: 'maze', x: 8, z: 24 },            // mazetile W (10)
    { pool: 'maze', x: 72, z: 72 },           // mazetile S (5)
    { tile: 'infinite-loop', x: 24, z: 40 },  // user probe: deliberately game-breaking infinite loop (was car pile BITIC)
    { pool: 'jg', x: 56, z: 56 },             // user: one jungle gym v1 + one v2 on every variant (was car pile MID)
    { pool: 'jg', x: 88, z: 40 },             // ...second jungle gym (was car pile 3/4)
    { pool: 'carpile', x: 8, z: 56 },         // car pile (8/9)
  ],

  // user-drawn walled enclosure around MID (doorways: NW corner, SW corner, east side z 45-48)
  overlays: [
    { x: 44, z: 35, w: 1, d: 32 }, { x: 49, z: 35, w: 33, d: 1 }, { x: 81, z: 36, w: 1, d: 9 }, { x: 81, z: 49, w: 1, d: 8 },
    { x: 75, z: 57, w: 7, d: 1 }, { x: 75, z: 58, w: 1, d: 9 }, { x: 48, z: 67, w: 28, d: 1 },
  ],

  pools: {
    maze: { decay: 0.35, tiles: { 'maze-a': 1, 'maze-b': 1, 'maze-c': 1 } },
    carpile: { decay: 0.6, tiles: { 'carpile-a': 1, 'carpile-b': 1 } },
    jg: { decay: 0, tiles: { jgv1: 1, jgv2: 1 } },   // decay 0: the second slot always gets the other variation
    inner16: {
      decay: 0.6,
      tiles: { jgv1: 3, jgv2: 1.5, 'tl-wall': 3, 'filler-wallcar': 2, 'filler-rock': 2, 'filler-windowl': 1.5, 'filler-junk': 1.5 },
    },
    inner8: {
      decay: 1,
      tiles: { 'dead-empty': 2, 'dead-gen': 1.5, 'dead-tree': 2, 'dead-rocks': 1.5, 'dead-car': 1, 'dead-tallrock': 4, 'dead-tallrock2': 2,   // user: more sight-blocking, non-loopable rocks
        'small-lowl': 0.7, 'small-rock': 0.7, 'small-tree': 0.7, 'small-car': 0.7 },
    },
    ring8: {
      decay: 0.95,
      tiles: { 'dead-empty': 3, 'dead-gen': 1.5, 'dead-tree': 3, 'dead-rocks': 2, 'dead-car': 2, 'dead-tallrock': 4, 'dead-tallrock2': 2,
        'small-lowl': 0.35, 'small-tree': 0.35, 'small-rock': 0.35 },
    },
  },
  bigTileChance: 0.55,

  pallets: { min: 14, max: 24 },
  gates: { minDistance: 75 },
  gens: { count: [11, 12], minSpacing: 20, require: [] },
  hooks: { min: 16, max: 20, radius: 26, slotBonus: 25, jitter: 15 },   // radius was 20; the walled MID enclosure lengthens walks
  // perimeter spawns: survivor anchors (engine scatters 4 survivors within 15 m) + hunter points
  spawns: { survivorAnchors: 10, hunter: 10, inset: [4, 8], anchorOpenRadius: 15, anchorOpenFraction: 0.75 },
  deadZoneDistance: 12,

  labels: [
    { text: '1', x: 91, z: 8 }, { text: '2', x: 106, z: 20 }, { text: '3', x: 107, z: 42 }, { text: '4', x: 91, z: 62 },
    { text: '5', x: 78, z: 92 }, { text: '6', x: 50, z: 92 }, { text: '7', x: 22, z: 92 }, { text: '8', x: 5, z: 74 },
    { text: '9', x: 5, z: 52 }, { text: '10', x: 6, z: 21 }, { text: '11', x: 36, z: 10 }, { text: '12', x: 62, z: 7 },
    { text: 'M', x: 56, z: 22 }, { text: 'S', x: 16, z: 81 }, { text: 'MID', x: 56, z: 54 }, { text: 'BITIC', x: 19, z: 41 },
  ],
};
