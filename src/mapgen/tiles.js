// Tile library for the tile-based map generator.
//
// Every tile is drawn as ASCII art on its own local 1 m grid (8x8, 16x16, or 32x32 for the main building).
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
// Loop rating (`rate`) is a design judgment used for stats only: 'strong' | 'weak' | 'none', computed from
// what actually spawned (realised pallets / windows inside the tile instance).

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

// Build a tile's rows with drawing helpers (used for the big main building where ASCII gets unwieldy).
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
const tile = def => { T.push({ optionalChance: 0.7, choiceChance: 0.75, ...def }); };

// ---------------------------------------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------------------------------------

tile({
  id: 'main', name: 'Main building (Gas Heaven style)', size: 32, category: 'landmark', optionalChance: 0.6,
  notes: 'Roofless 24x20 m building. Interior N-S wall with the "incredibly safe" window: survivors vault in 0.5 s, the hunter detours ~18 m around the wall end. Complementary pallets: south pallet door (guaranteed), west door + east corridor + east-room pallets (optional), and a low-wall pallet outside the south wall. Two more windows (north, east) chain with the outside walls.',
  rate: () => 'strong',
  rows: draw(32, ({ set, fill }) => {
    fill(4, 6, 24, 1, 'B'); fill(4, 25, 24, 1, 'B'); fill(4, 6, 1, 20, 'B'); fill(27, 6, 1, 20, 'B');
    set(22, 6, 'W');                          // north window, loops with the exterior wall stub
    set(27, 9, '.'); set(27, 10, '.');        // east door
    set(27, 18, 'W');                         // east window
    set(4, 13, 'p'); set(4, 14, 'p');         // west door pallet (optional)
    set(9, 25, '.'); set(10, 25, '.');        // south open door
    set(20, 25, 'P'); set(21, 25, 'P');       // south pallet door
    fill(16, 7, 1, 11, 'B'); set(16, 11, 'W');// interior safe window
    fill(19, 15, 6, 1, '#'); set(25, 15, 'p'); set(26, 15, 'p'); // east-room pallet (optional)
    fill(18, 2, 9, 1, '#');                   // exterior north wall stub
    fill(5, 28, 5, 1, '='); set(10, 28, 'P'); set(11, 28, 'P'); fill(12, 28, 4, 1, '='); // south low-wall pallet
    fill(30, 18, 1, 7, '#'); set(28, 22, 'p'); set(29, 22, 'p'); // east corridor pallet (optional)
    set(10, 20, 'G'); set(22, 10, 'G'); set(7, 30, 'G');
    set(13, 30, 'H'); set(2, 2, 'H'); set(29, 29, 'H'); set(10, 10, 'H');
  }),
});

tile({
  id: 'shack', name: 'Shack', size: 16, category: 'landmark',
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

// Mazetiles: tall wall clusters with several gaps; pallets are optional so safety is unpredictable.
const mazeRate = rateBy(r => r.windows + r.pallets >= 3);
tile({
  id: 'maze-a', name: 'Mazetile A (box-in-box)', size: 16, category: 'maze', optionalChance: 0.4, rate: mazeRate,
  notes: 'Outer broken box with an inner C; one window, up to three optional pallets.',
  rows: [
    '................',
    '.######..######.',
    '.#............#.',
    '.#..######....#.',
    '.#..#.........W.',
    '.#..#.........#.',
    '.p..#...####..#.',
    '.#..#......#..#.',
    '.#.........#....',
    '.#.........#..#.',
    '.#..####...#..p.',
    '.#.........#..#.',
    '.#....G.......#.',
    '.##p##..#######.',
    '...........H....',
    '................',
  ],
});
tile({
  id: 'maze-b', name: 'Mazetile B (zig-zag)', size: 16, category: 'maze', optionalChance: 0.45, rate: mazeRate,
  notes: 'Staggered tall walls; two windows, two optional pallets.',
  rows: [
    '................',
    '................',
    '..#####.####....',
    '..#.......#.....',
    '..#.......#..##.',
    '..W...##..p..#..',
    '..#....#..#..#..',
    '..#....#..#.....',
    '.......#........',
    '..####.#####....',
    '.....#.....#..#.',
    '.....p.....W..#.',
    '.....#.....#..#.',
    '..####..####..#.',
    '.H.........G....',
    '................',
  ],
});
tile({
  id: 'maze-c', name: 'Mazetile C (corridors)', size: 16, category: 'maze', optionalChance: 0.45, rate: mazeRate,
  notes: 'Long corridors and a pocket room; one window, two optional pallets.',
  rows: [
    '................',
    '................',
    '..##########....',
    '...........#....',
    '..########.#.##.',
    '..#......#.W..#.',
    '..#......#.#..#.',
    '..p......#.#..#.',
    '..#.##p###.#..#.',
    '..#.#......#..#.',
    '..#.#...........',
    '..#.#..#######..',
    '..#.............',
    '..#####..####...',
    '.......G.....H..',
    '................',
  ],
});

// Car piles: rings of low cars and tall car stacks; exactly one of the numbered pallet spots spawns
// (or none) -> "inconsistent pallet generation".
const carRate = rateBy(() => false);
tile({
  id: 'carpile-a', name: 'Car pile A (ring)', size: 16, category: 'carpile', choiceChance: 0.75, rate: carRate,
  notes: 'Broken ring of low cars / tall stacks around a central stack. One of three pallet spots (75%).',
  rows: [
    '................',
    '................',
    '...cccc1CCCC....',
    '...c........C...',
    '...c........C...',
    '...c...CC...2...',
    '...c...CC...C...',
    '...3...cc...C...',
    '...c........C...',
    '...c............',
    '...c............',
    '...cccc..CCCcc..',
    '................',
    '.............G..',
    '.H..............',
    '................',
  ],
});
tile({
  id: 'carpile-b', name: 'Car pile B (scattered stacks)', size: 16, category: 'carpile', choiceChance: 0.7, rate: carRate,
  notes: 'Scattered rows and stacks; one of three pallet spots (70%).',
  rows: [
    '................',
    '................',
    '..CCCC1cccc.....',
    '................',
    '..........CC....',
    '...cc.....CC....',
    '...cc.....2.....',
    '..........CC....',
    '...CCC....CC.H..',
    '...CCC..........',
    '................',
    '....cccc3CCC....',
    '................',
    '......G....cc...',
    '...........cc...',
    '................',
  ],
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
  id: 'jgv1', name: 'Jungle Gym v1', size: 16, category: 'loop', rate: () => 'strong',
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
    '.....#........#.',
    '.....#######PP#.',
    '.....#........#.',
    '.....#..........',
    '.H..............',
    '................',
  ],
});

tile({
  id: 'jgv2', name: 'Long-wall Jungle Gym v2', size: 16, category: 'loop', rate: () => 'strong',
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
    '.....#........#.',
    '.....#######..#.',
    '.....#........#.',
    '........H.......',
    '................',
  ],
});

tile({
  id: 'filler-wallcar', name: 'Filler: wall + car stack pallet', size: 16, category: 'filler', optionalChance: 0.6,
  rate: rateBy(() => false),
  notes: '8 m tall wall, pallet gap against a low car, low wall nearby. Weak filler loop.',
  rows: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.............cc.',
    '...########ppcc.',
    '.............cc.',
    '................',
    '................',
    '.....G..........',
    '................',
    '......=====.....',
    '..H.............',
    '................',
    '................',
  ],
});

tile({
  id: 'filler-rock', name: 'Filler: rock island', size: 16, category: 'filler', optionalChance: 0.6,
  rate: rateBy(() => false),
  notes: 'Tall rock + short tall wall with a pallet between, low rocks and a tree pair. Weak filler loop.',
  rows: [
    '................',
    '................',
    '................',
    '....RRRR........',
    '....RRRR........',
    '....RRRRp#......',
    '.........#......',
    '.........#......',
    '.........#......',
    '................',
    '.......rr.......',
    '...TT..rr...G...',
    '...TT...........',
    '................',
    '...........H....',
    '................',
  ],
});

tile({
  id: 'filler-windowl', name: 'Filler: window L wall', size: 16, category: 'filler', optionalChance: 0.6,
  rate: rateBy(r => r.windows >= 1 && r.pallets >= 1),
  notes: 'Tall L with a window in the top run and an optional pallet in the upright. Strong when the pallet spawns ("strong filler loops" critique).',
  rows: [
    '................',
    '................',
    '................',
    '...######W###...',
    '...#............',
    '...#............',
    '...#.......G....',
    '...p............',
    '...#............',
    '...#............',
    '...#....rrr.....',
    '........rrr.....',
    '................',
    '.............H..',
    '................',
    '................',
  ],
});

tile({
  id: 'filler-junk', name: 'Filler: low-wall junk', size: 16, category: 'filler', optionalChance: 0.55,
  rate: rateBy(() => false),
  notes: 'Low walls and crates (all see-through), one optional pallet. Weak.',
  rows: [
    '................',
    '................',
    '................',
    '..=====..=====..',
    '......=.........',
    '......=.........',
    '......p.........',
    '......=.....kk..',
    '......=.....kk..',
    '..=====.........',
    '................',
    '................',
    '.........G......',
    '................',
    '...H............',
    '................',
  ],
});

// ---------------------------------------------------------------------------------------------------------
// Small 8x8 filler + dead zones
// ---------------------------------------------------------------------------------------------------------

const smallRate = rateBy(() => false);
const SMALL_OPT = 0.55;
tile({
  id: 'small-lowl', name: 'Small: low L + pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  rows: ['........', '.===p==.', '.=......', '.=......', '.=......', '........', '.....H..', '........'],
});
tile({
  id: 'small-rock', name: 'Small: rock + wall pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  rows: ['........', '........', '..RRR...', '..RRRp#.', '..RRR.#.', '......#.', '.H......', '........'],
});
tile({
  id: 'small-tree', name: 'Small: tree pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  rows: ['........', '........', '.TT.....', '.TTpTT..', '....TT..', '........', '......H.', '........'],
});
tile({
  id: 'small-car', name: 'Small: car pallet', size: 8, category: 'filler', optionalChance: SMALL_OPT, rate: smallRate,
  rows: ['........', '........', '.cc..cc.', '.ccppcc.', '.cc..cc.', '........', '...H....', '........'],
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
  rows: ['........', '........', '..ccc...', '..ccc...', '........', '.....G..', '.H......', '........'],
});
tile({
  id: 'dead-tallrock', name: 'Dead zone: tall rock (no pallet)', size: 8, category: 'dead', rate: deadRate,
  rows: ['........', '........', '...RR...', '...RR...', '........', '......H.', '........', '........'],
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
  return { rows: g.map(r => r.join('')), pallets, genSlots, hookSlots };
}
