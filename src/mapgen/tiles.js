// Tile library for the tile-based map generator.
//
// Every tile is drawn as ASCII art on its own local 1 m grid (8x8 or 16x16).
// Row 0 / last row / column 0 / last column are kept walkable so neighbouring tiles always connect.
// Tiles are rotated (90° steps) and mirrored when placed; window/pallet axes are inferred AFTER placement
// from the surrounding solid cells, so transforms never need special handling.
//
// Legend
//   .  floor                        W  window (in a wall line)
//   #  tall wall      (3.0 m)       P  guaranteed pallet (2 adjacent P = one length-2 pallet)
//   B  building wall  (3.5 m)       p  optional pallet: each group spawns with tile.optionalChance
//   =  low wall       (1.0 m)       1-4 "choice" pallet spots: with tile.choiceChance exactly ONE digit spawns
//   c  low car        (1.1 m)       G  generator slot (floor unless chosen as a candidate)
//   C  car stack      (2.4 m, tall) H  hook slot (floor; preferred hook location)
//   R  tall rock      (2.6 m)
//   r  low rock       (1.0 m)
//   T  tree           (5.0 m)
//   k  crate          (1.0 m)
//
// Loop rating (`rate`) and palletSafety are design judgments, not engine rules. Safety describes the
// dropped pallet against an ordinary M1 killer in isolation, not whether a whole tile is strong.
// Dimensions are 1 m collision approximations of reference layouts, not extracted game assets.
// See docs/research/tile-accuracy.md for sources, measurements and owner-preserved exceptions.

export const SOLID_CHARS = {
  '#': { kind: 'wall', height: 3.0 },
  B: { kind: 'building', height: 3.5 },
  '=': { kind: 'wall', height: 1.0 },
  c: { kind: 'car', height: 1.1 },
  C: { kind: 'car', height: 2.4 },
  R: { kind: 'rock', height: 2.6 },
  r: { kind: 'rock', height: 1.0 },
  T: { kind: 'tree', height: 5.0 },
  k: { kind: 'crate', height: 1.0 },
};

export const isSolidChar = ch => ch in SOLID_CHARS;
export const isPalletChar = ch => ch === 'P' || ch === 'p' || (ch >= '1' && ch <= '9');

// Build a tile's rows with drawing helpers where ASCII gets unwieldy.
function draw(size, fn) {
  const g = Array.from({ length: size }, () => Array(size).fill('.'));
  const set = (x, z, ch) => { g[z][x] = ch; };
  const fill = (x, z, w, d, ch) => { for (let j = z; j < z + d; j++) for (let i = x; i < x + w; i++) g[j][i] = ch; };
  fn({ set, fill });
  return g.map(r => r.join(''));
}

const filled = (size, ch = '.') => Array.from({ length: size }, () => ch.repeat(size));
const withSlots = (rows, slots) => {
  const g = rows.map(r => r.split(''));
  for (const [ch, x, z] of slots) g[z][x] = ch;
  return g.map(r => r.join(''));
};

const rateBy = (strongIf, weakIf = r => r.pallets + r.windows > 0) => r => (strongIf(r) ? 'strong' : weakIf(r) ? 'weak' : 'none');

const T = [];
const tile = def => { T.push({ optionalChance: 0.7, choiceChance: 0.75, palletSafety: 'unsafe', ...def }); };

// ---------------------------------------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------------------------------------

tile({
  id: 'shack', name: 'Shack', size: 16, category: 'landmark', palletSafety: 'god',
  // Override the old outside G marker without changing owner-protected collision geometry.
  // An optional indoor spawn, never a guaranteed match generator.
  genSlots: [[7, 8]],
  notes: 'Square 10x10 m tall-walled shack: north door, east window, south-east pallet door. Loop: in the north door, out the window, around the outside, back in through the pallet. Hunter has to play reactively and force the pallet.',
  rate: () => 'strong',
  rows: [
    '................',
    '................',
    '................',
    '...##..######...',
    '...#........#...',
    '...#........#...',
    '...#........W...',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '...#........#...',
    '...######PP##...',
    '................',
    '.H............G.',
    '................',
  ],
});

// Standard maze families. One guaranteed pallet, and zero (pallet gym) or one (four-lane) window.
// No optional pallets embedded in arbitrary multi-room mazes. The unused four-lane vault is a hole.
tile({
  id: 'pallet-gym', name: 'Pallet gym (C + L walls)', size: 16, category: 'maze',
  palletSafety: 'safe', rate: rateBy(r => r.pallets > 0),
  notes: 'Long C wall and short L joined by one 2 m pallet gap; separate rear C and straight wall. No window. Walls span 10 m / 6 m in this grid approximation.',
  rows: draw(16, ({ set, fill }) => {
    fill(2, 3, 7, 1, '#'); fill(2, 3, 1, 10, '#'); fill(2, 12, 7, 1, '#');
    fill(11, 7, 1, 6, '#'); fill(11, 12, 4, 1, '#'); fill(9, 12, 2, 1, 'P');
    fill(11, 2, 4, 1, '#'); fill(14, 2, 1, 3, '#'); fill(11, 4, 4, 1, '#');
    fill(6, 6, 3, 1, '#'); set(7, 9, 'G'); set(13, 6, 'H');
  }),
});
tile({
  id: 'four-lane-open', name: 'Four-lane gym (outside window)', size: 16, category: 'maze',
  palletSafety: 'safe', rate: rateBy(r => r.windows > 0 || r.pallets > 0),
  notes: 'Four parallel 11 m walls, outside window and hole in the adjacent inside wall. One 2 m pallet between the opposite pair of windowless walls.',
  rows: draw(16, ({ set, fill }) => {
    for (const x of [2, 5, 9, 12]) fill(x, 2, 1, 11, '#');
    set(2, 5, 'W'); set(5, 5, '.'); fill(10, 10, 2, 1, 'P');
    set(7, 7, 'G'); set(14, 14, 'H');
  }),
});
tile({
  id: 'four-lane-closed', name: 'Four-lane gym (inside window)', size: 16, category: 'maze',
  palletSafety: 'safe', rate: rateBy(r => r.pallets > 0),
  notes: 'Same four-lane footprint; inside window, outside hole. Window alone is more mindgameable than the open variant.',
  rows: draw(16, ({ set, fill }) => {
    for (const x of [2, 5, 9, 12]) fill(x, 2, 1, 11, '#');
    set(2, 5, '.'); set(5, 5, 'W'); fill(10, 10, 2, 1, 'P');
    set(7, 7, 'G'); set(14, 14, 'H');
  }),
});

// Navigable single-tile car piles, following the Gas Heaven 6.7 rework. Two mutually exclusive
// pallet locations, not a car enclosure. Low cars use approximately 2 x 5 m collision footprints.
tile({
  id: 'carpile-long', name: 'Car pile: long stack + wreck', size: 16, category: 'carpile', choiceChance: 0.8,
  palletSafety: 'safe', rate: rateBy(r => r.pallets > 0),
  notes: 'Two separated 2x8 m stacks, one 2x5 m wreck. One of two 2 m pallet gaps (80%); open routes through and around the piles.',
  rows: draw(16, ({ set, fill }) => {
    fill(3, 3, 2, 8, 'C'); fill(7, 3, 2, 8, 'C'); fill(11, 5, 2, 5, 'c');
    fill(5, 6, 2, 1, '1'); fill(9, 7, 2, 1, '2');
    set(5, 13, 'G'); set(14, 2, 'H');
  }),
});
tile({
  id: 'carpile-short', name: 'Car pile: scattered wrecks', size: 16, category: 'carpile', choiceChance: 0.75,
  rate: rateBy(() => false),
  notes: 'Three 2x5 m wrecks, one tall. One of two 2 m pallet gaps (75%). Shorter, visible loops; no free-standing pallet or one-cell car posts.',
  rows: draw(16, ({ set, fill }) => {
    fill(2, 3, 2, 5, 'c'); fill(6, 3, 2, 5, 'C'); fill(10, 5, 2, 5, 'c');
    fill(4, 5, 2, 1, '1'); fill(8, 6, 2, 1, '2');
    set(6, 12, 'G'); set(13, 12, 'H');
  }),
});

// ---------------------------------------------------------------------------------------------------------
// Loop tiles (16x16) from the user's tile library + filler loops
// ---------------------------------------------------------------------------------------------------------

tile({
  id: 'tl-wall', name: 'T + L wall', size: 16, category: 'loop', rate: () => 'weak',
  notes: 'T wall (window high in the stem) diagonal from an L wall (window low in the upright). Relatively unsafe alone: hunter double-backs on the T, the L is weaker. Strong when chained with neighbours.',
  rows: [
    '................',
    '................',
    '.......#######..',
    '..........#.....',
    '..........W.....',
    '..........#.....',
    '......G...#.....',
    '..........#.....',
    '..........#.....',
    '................',
    '..#.............',
    '..#.............',
    '..W..........H..',
    '..#.............',
    '..######........',
    '................',
  ],
});

tile({
  id: 'jgv1', name: 'Jungle Gym v1', size: 16, category: 'loop', palletSafety: 'safe', rate: () => 'strong',
  notes: 'L wall with window in the top run, corner pieces on the right, sideways-T inner wall ending in a pallet gap against the right wall. Hunter wants to force the pallet counter-clockwise; window stays strong-ish without the pallet.',
  rows: [
    '................',
    '................',
    '............###.',
    '..............#.',
    '..##W####.....#.',
    '..#...........#.',
    '..#...........#.',
    '..#......G......',
    '..#.............',
    '..#..#........#.',
    '.....#.....#..#.',
    '.....#######PP#.',
    '.....#.....#..#.',
    '.....##.........',
    '.H..............',
    '................',
  ],
});

tile({
  id: 'jgv2', name: 'Long-wall Jungle Gym v2', size: 16, category: 'loop', palletSafety: 'safe', rate: () => 'strong',
  notes: '13 m long wall with a window, bracket + short wall on the left, sideways-T with the pallet between the bracket and the T upright. "Good luck": hard to deal with without a power, crazier when chained.',
  rows: [
    '................',
    '............###.',
    '..............#.',
    '..............#.',
    '..##..####....#.',
    '..#...........#.',
    '..#.....G.....#.',
    '..#...........W.',
    '..#..#........#.',
    '..#PP#........#.',
    '..#..#........#.',
    '.....#.....#..#.',
    '.....#######..#.',
    '.....##....#..#.',
    '........H.......',
    '................',
  ],
});

tile({
  id: 'filler-wallcar', name: 'Filler: stack + car pallet', size: 16, category: 'filler', optionalChance: 0.65,
  palletSafety: 'safe', rate: rateBy(r => r.pallets > 0),
  notes: '2x7 m tall scrap stack beside a 2x5 m low car; optional 2 m pallet between their long sides. Autohaven long filler rather than an 8 m wall ending in a tiny car.',
  rows: draw(16, ({ set, fill }) => {
    fill(3, 4, 2, 7, 'C'); fill(7, 4, 2, 5, 'c'); fill(5, 7, 2, 1, 'p');
    fill(11, 11, 2, 2, 'k'); set(6, 12, 'G'); set(2, 13, 'H');
  }),
});

tile({
  id: 'filler-rock', name: 'Filler: paired rock pallet', size: 16, category: 'filler', optionalChance: 0.65,
  rate: rateBy(() => false),
  notes: '4x4 m and 3x4 m LOS-blocking rock clusters joined by an optional 2 m pallet; no window invented in natural rock. Unsafe alone but can chain into a nearby gym.',
  rows: draw(16, ({ set, fill }) => {
    fill(3, 4, 4, 4, 'R'); fill(9, 4, 3, 4, 'R'); fill(7, 6, 2, 1, 'p');
    fill(4, 11, 2, 2, 'r'); set(12, 11, 'G'); set(12, 13, 'H');
  }),
});

tile({
  id: 'variant-gym', name: 'Variant jungle gym', size: 16, category: 'maze',
  palletSafety: 'safe', rate: rateBy(r => r.pallets > 0),
  notes: 'Five separate wall segments: 10 m left wall with window near its front, central and right walls with a 2 m pallet at the front, two rear segments. One window and one guaranteed pallet.',
  rows: draw(16, ({ set, fill }) => {
    fill(2, 3, 1, 10, '#'); set(2, 10, 'W');
    fill(7, 5, 1, 8, '#'); fill(10, 7, 1, 6, '#'); fill(8, 11, 2, 1, 'P');
    fill(4, 2, 4, 1, '#'); fill(10, 3, 4, 1, '#');
    set(5, 7, 'G'); set(13, 13, 'H');
  }),
});

tile({
  id: 'filler-junk', name: 'Filler: tires + scrap pallet', size: 16, category: 'filler', optionalChance: 0.6,
  rate: rateBy(() => false),
  notes: 'Two low 3x4 m junk/tyre islands with a 2 m pallet gap. Short visible filler; no zig-zag low-wall maze.',
  rows: draw(16, ({ set, fill }) => {
    fill(3, 5, 3, 4, '='); fill(8, 5, 3, 4, 'k'); fill(6, 7, 2, 1, 'p');
    set(9, 12, 'G'); set(3, 13, 'H');
  }),
});

// ---------------------------------------------------------------------------------------------------------
// Small 8x8 filler + dead zones
// ---------------------------------------------------------------------------------------------------------

const smallRate = rateBy(() => false);
const SMALL_OPT = 0.55;
tile({
  id: 'small-junk', name: 'Small: crate + tires pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  notes: 'Two 2x3 m low prop groups, 2 m gap; unsafe edge filler.',
  rows: ['........', '........', '.kk..==.', '.kkpp==.', '.kk..==.', '........', '.....H..', '........'],
});
tile({
  id: 'small-rock', name: 'Small: paired rock pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  notes: 'Two 2x3 m rocks with a 2 m pallet gap; unsafe, not a rock against a one-cell post.',
  rows: ['........', '........', '.RR..RR.', '.RRppRR.', '.RR..RR.', '........', '.H......', '........'],
});
tile({
  id: 'small-tires', name: 'Small: tire stacks pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  notes: 'Two 2x3 m tyre/scrap groups, one tall and one low; unsafe, not an isolated tree pallet.',
  rows: ['........', '........', '.CC..==.', '.CCpp==.', '.CC..==.', '........', '......H.', '........'],
});
tile({
  id: 'small-car', name: 'Small: car pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  notes: 'Two 2x5 m low cars with a 2 m pallet gap, a visible and mindgameable Autohaven filler.',
  rows: ['........', '.cc..cc.', '.cc..cc.', '.ccppcc.', '.cc..cc.', '.cc..cc.', '...H....', '........'],
});

const deadRate = () => 'none';
tile({ id: 'dead-empty', name: 'Dead zone: empty', size: 8, category: 'dead', rate: deadRate, rows: withSlots(filled(8), [['H', 4, 3]]) });
tile({ id: 'dead-gen', name: 'Dead zone: open (gen spot)', size: 8, category: 'dead', rate: deadRate, rows: withSlots(filled(8), [['G', 4, 4], ['H', 1, 1]]) });
tile({
  id: 'dead-tree', name: 'Dead zone: tree', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '..TT....', '..TT....', '........', '........', '.....G..', '.H......', '........'],
});
tile({
  id: 'dead-rocks', name: 'Dead zone: low rocks', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '.r....r.', '........', '....H...', '..r.....', '......r.', '........', '........'],
});
tile({
  id: 'dead-car', name: 'Dead zone: lone car', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '........', '.ccccc..', '.ccccc..', '........', '.....G..', '.H......', '........'],
});
tile({
  id: 'dead-tallrock', name: 'Dead zone: tall rock (no pallet)', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '........', '...RR...', '...RR...', '........', '......H.', '........', '........'],
});
tile({
  id: 'dead-tallrock2', name: 'Dead zone: two small tall rocks (no pallet, set apart)', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '.RR.....', '.RR.....', '........', '......H.', '.....RR.', '.....RR.', '........'],
});
tile({
  id: 'infinite-loop', name: 'Infinite loop (deliberately game-breaking)', size: 16, category: 'landmark', rate: () => 'strong',
  notes: 'User probe tile: two sealed 12 m corridors between three tall walls, a window in each end wall (4 windows). Survivors fast-vault (0.5 s) vs the hunter (1.7 s) and gain more per vault than the hunter gains per corridor run. Tests whether survivors learn to exploit it.',
  rows: [
    '................',
    '.###W#####W###..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.#.....#.....#..',
    '.###W#####W###..',
    '................',
  ],
});
tile({ id: 'gate', name: 'Exit gate area', size: 8, category: 'gate', rate: deadRate, rows: filled(8) });

export const TILES = Object.fromEntries(T.map(t => [t.id, t]));
export const TILE_LIST = T;

// ---------------------------------------------------------------------------------------------------------
// Transforms + resolution
// ---------------------------------------------------------------------------------------------------------

// mirror flips x first, then rotate `rot` quarter turns clockwise (x east, z south).
export function transformRows(rows, rot = 0, mirror = false) {
  let g = rows.map(r => r.split(''));
  if (mirror) g = g.map(r => r.slice().reverse());
  for (let k = 0; k < ((rot % 4) + 4) % 4; k++) {
    const n = g.length;
    g = Array.from({ length: n }, (_, z) => Array.from({ length: n }, (_, x) => g[n - 1 - x][z]));
  }
  return g.map(r => r.join(''));
}

// Roll optional / choice pallets. Returns the concrete tile grid (only . solids W P remain) plus slots.
// mode: 'roll' (normal), 'all' (every optional pallet spawns), 'none' (only guaranteed ones).
export function resolveTile(tileDef, rng, { rot = 0, mirror = false, mode = 'roll' } = {}) {
  const rows = transformRows(tileDef.rows, rot, mirror);
  const n = rows.length;
  const g = rows.map(r => r.split(''));
  const seen = new Uint8Array(n * n);
  const groups = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const ch = g[z][x];
    if (!isPalletChar(ch) || seen[z * n + x]) continue;
    const cells = [], stack = [[x, z]];
    seen[z * n + x] = 1;
    while (stack.length) {
      const [cx, cz] = stack.pop();
      cells.push([cx, cz]);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n || seen[nz * n + nx] || g[nz][nx] !== ch) continue;
        seen[nz * n + nx] = 1; stack.push([nx, nz]);
      }
    }
    groups.push({ ch, cells });
  }
  const digits = [...new Set(groups.filter(gr => gr.ch >= '1' && gr.ch <= '9').map(gr => gr.ch))].sort();
  let chosenDigit = null;
  if (digits.length) {
    if (mode === 'all') chosenDigit = '*';
    else if (mode === 'roll' && rng.chance(tileDef.choiceChance)) chosenDigit = rng.pick(digits);
  }
  const pallets = [];
  for (const gr of groups) {
    let on;
    if (gr.ch === 'P') on = true;
    else if (gr.ch === 'p') on = mode === 'all' ? true : mode === 'none' ? false : rng.chance(tileDef.optionalChance);
    else on = chosenDigit === '*' || gr.ch === chosenDigit;
    for (const [x, z] of gr.cells) g[z][x] = on ? 'P' : '.';
    if (on) pallets.push({ cells: gr.cells, optional: gr.ch !== 'P' });
  }
  const genSlots = [], hookSlots = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    if (g[z][x] === 'G') { genSlots.push([x, z]); g[z][x] = '.'; }
    else if (g[z][x] === 'H') { hookSlots.push([x, z]); g[z][x] = '.'; }
  }
  if (tileDef.genSlots) {
    genSlots.length = 0;
    for (const slot of tileDef.genSlots) {
      let [x, z] = slot;
      if (mirror) x = n - 1 - x;
      for (let k = 0; k < ((rot % 4) + 4) % 4; k++) [x, z] = [n - 1 - z, x];
      genSlots.push([x, z]);
    }
  }
  return { rows: g.map(r => r.join('')), pallets, genSlots, hookSlots };
}
