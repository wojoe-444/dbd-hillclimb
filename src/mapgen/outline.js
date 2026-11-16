// Seeded map-outline generator. Outlines are unions of 8 m map tiles ("cells"): stepped, axis-aligned edges,
// like real DBD map footprints. Zero deps, Node + browser.
//
// generateOutline(rng, opts) -> { family, cw, ch, cells: Uint8Array(cw*ch), area, outline: [[x,z],...] (metres) }
//
// Rules every outline satisfies (see checkOutlineCells):
//   - area in [minCells, maxCells] (default 144-153 cells = 9216-9792 m²)
//   - bounding-box aspect ratio long/short <= maxAspect (default 1.6), each side <= maxSide cells
//   - min width >= minWidth cells everywhere: every cell lies in some minWidth x minWidth square fully inside the
//     shape, and those squares form one 4-connected chain (a square can slide between any two), so there are no
//     necks or thin corridors
//   - connected, no holes, no corner-only (pinch) contacts -> the boundary is one simple stepped polygon
//
// Families: 'notched' (near-square with rectangular / two-step notches cut from corners), 'circlish' (stepped
// superellipse: corners cut in staircases), 'blob' (union of overlapping chunky rectangles: irregular, sharp
// right angles), 'chunky' (L / T / offset-stack shapes built from two or three big rectangles).

export const OUTLINE_DEFAULTS = { minCells: 144, maxCells: 153, maxAspect: 1.6, minWidth: 4, maxSide: 16, cell: 8 };
export const OUTLINE_FAMILIES = ['notched', 'circlish', 'blob', 'chunky'];

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---- cell-set helpers (a shape = Set of "i,j" keys while building, normalised to a grid at the end) -------
const key = (i, j) => `${i},${j}`;
const parse = k => k.split(',').map(Number);
function rect(set, i0, j0, w, h, on = true) {
  for (let j = j0; j < j0 + h; j++) for (let i = i0; i < i0 + w; i++) on ? set.add(key(i, j)) : set.delete(key(i, j));
  return set;
}
function toGrid(set) {
  let mi = Infinity, mj = Infinity, xi = -Infinity, xj = -Infinity;
  for (const k of set) { const [i, j] = parse(k); mi = Math.min(mi, i); mj = Math.min(mj, j); xi = Math.max(xi, i); xj = Math.max(xj, j); }
  if (!set.size) return { cw: 0, ch: 0, cells: new Uint8Array(0) };
  const cw = xi - mi + 1, ch = xj - mj + 1, cells = new Uint8Array(cw * ch);
  for (const k of set) { const [i, j] = parse(k); cells[(j - mj) * cw + (i - mi)] = 1; }
  return { cw, ch, cells };
}
function fromGrid({ cw, ch, cells }) {
  const s = new Set();
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (cells[j * cw + i]) s.add(key(i, j));
  return s;
}

// ---- validity --------------------------------------------------------------------------------------------
// Returns null if the cell grid is a valid outline, else a short reason string.
export function checkOutlineCells({ cw, ch, cells }, o = {}) {
  const { minCells, maxCells, maxAspect, minWidth: K, maxSide } = { ...OUTLINE_DEFAULTS, ...o };
  const at = (i, j) => (i >= 0 && j >= 0 && i < cw && j < ch ? cells[j * cw + i] : 0);
  let area = 0;
  for (let n = 0; n < cells.length; n++) area += cells[n];
  if (area < minCells || area > maxCells) return `area ${area}`;
  if (Math.max(cw, ch) > maxSide) return 'too long';
  if (Math.max(cw, ch) / Math.min(cw, ch) > maxAspect + 1e-9) return 'aspect';
  // bbox must be tight (every row and column used)
  for (let j = 0; j < ch; j++) { let any = 0; for (let i = 0; i < cw; i++) any |= at(i, j); if (!any) return 'empty row'; }
  for (let i = 0; i < cw; i++) { let any = 0; for (let j = 0; j < ch; j++) any |= at(i, j); if (!any) return 'empty col'; }
  // min width: K x K squares (top-left anchors) fully inside
  const aw = cw - K + 1, ah = ch - K + 1;
  if (aw <= 0 || ah <= 0) return 'too small';
  const sq = new Uint8Array(aw * ah);
  const covered = new Uint8Array(cw * ch);
  let first = -1;
  for (let j = 0; j < ah; j++) for (let i = 0; i < aw; i++) {
    let ok = 1;
    for (let b = 0; b < K && ok; b++) for (let a = 0; a < K; a++) if (!at(i + a, j + b)) { ok = 0; break; }
    if (!ok) continue;
    sq[j * aw + i] = 1; if (first < 0) first = j * aw + i;
    for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) covered[(j + b) * cw + i + a] = 1;
  }
  for (let n = 0; n < cells.length; n++) if (cells[n] && !covered[n]) return 'thin part';
  // squares 4-connected
  {
    const seen = new Uint8Array(aw * ah), q = [first]; seen[first] = 1; let cnt = 0, tot = 0;
    for (let n = 0; n < sq.length; n++) tot += sq[n];
    while (q.length) {
      const c = q.pop(); cnt++;
      const i = c % aw, j = (c - i) / aw;
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= aw || nj >= ah) continue;
        const nn = nj * aw + ni;
        if (sq[nn] && !seen[nn]) { seen[nn] = 1; q.push(nn); }
      }
    }
    if (cnt !== tot) return 'neck';
  }
  // holes: flood the outside from a 1-cell padding ring
  {
    const W = cw + 2, H = ch + 2, seen = new Uint8Array(W * H), q = [0]; seen[0] = 1;
    while (q.length) {
      const c = q.pop(), i = c % W, j = (c - i) / W;
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nn = nj * W + ni;
        if (!seen[nn] && !at(ni - 1, nj - 1)) { seen[nn] = 1; q.push(nn); }
      }
    }
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (!cells[j * cw + i] && !seen[(j + 1) * W + i + 1]) return 'hole';
  }
  // pinch: 2x2 window with only a diagonal pair inside (or only a diagonal pair outside)
  for (let j = -1; j < ch; j++) for (let i = -1; i < cw; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    if (a === d && b === c && a !== b) return 'pinch';
  }
  return null;
}

// Boundary of a valid cell grid as a clockwise (x right, z down) polygon in metres, collinear points merged,
// starting at the top-most then left-most vertex.
export function cellsToOutline({ cw, ch, cells }, cell = 8) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < cw && j < ch ? cells[j * cw + i] : 0);
  const next = new Map();   // "x,z" -> [x2,z2], directed boundary edges with the inside on the right
  const add = (x0, z0, x1, z1) => next.set(key(x0, z0), [x1, z1]);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) add(i, j, i + 1, j);
    if (!at(i + 1, j)) add(i + 1, j, i + 1, j + 1);
    if (!at(i, j + 1)) add(i + 1, j + 1, i, j + 1);
    if (!at(i - 1, j)) add(i, j + 1, i, j);
  }
  let start = null;
  for (const k of next.keys()) { const [x, z] = parse(k); if (!start || z < start[1] || (z === start[1] && x < start[0])) start = [x, z]; }
  const pts = [start];
  let cur = next.get(key(...start));
  while (!(cur[0] === start[0] && cur[1] === start[1])) { pts.push(cur); cur = next.get(key(...cur)); if (pts.length > 4 * cells.length + 8) throw new Error('outline trace failed'); }
  const out = [];
  for (let n = 0; n < pts.length; n++) {
    const p = pts[(n + pts.length - 1) % pts.length], c = pts[n], q = pts[(n + 1) % pts.length];
    if ((p[0] === c[0] && c[0] === q[0]) || (p[1] === c[1] && c[1] === q[1])) continue;
    out.push([c[0] * cell, c[1] * cell]);
  }
  return out;
}

// Cell-grid membership from a stepped outline (cell centres).
export function outlineToCells(outline, cell = 8) {
  const xs = outline.map(p => p[0]), zs = outline.map(p => p[1]);
  const cw = Math.round(Math.max(...xs) / cell), ch = Math.round(Math.max(...zs) / cell);
  const cells = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const px = i * cell + cell / 2, pz = j * cell + cell / 2;
    let inside = false;
    for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
      const [xa, za] = outline[a], [xb, zb] = outline[b];
      if ((za > pz) !== (zb > pz) && px < ((xb - xa) * (pz - za)) / (zb - za) + xa) inside = !inside;
    }
    cells[j * cw + i] = inside ? 1 : 0;
  }
  return { cw, ch, cells };
}

// ---- families (each returns a raw Set; area is fixed up afterwards) ----------------------------------------
const between = (rng, a, b) => a + rng.int(b - a + 1);

function famNotched(rng) {
  // base rectangle a little larger than the target, then 2-4 corners notched (some as two-step staircases)
  const aspect = 1 + rng.next() * 0.45;
  const baseArea = 158 + rng.int(30);
  let w = Math.round(Math.sqrt(baseArea / aspect)), h = Math.round(w * aspect);
  if (rng.chance(0.5)) [w, h] = [h, w];
  const s = rect(new Set(), 0, 0, w, h);
  const corners = rng.shuffle([[0, 0], [1, 0], [0, 1], [1, 1]]).slice(0, between(rng, 2, 4));
  for (const [cx, cz] of corners) {
    const nw = between(rng, 1, Math.min(4, w - 5)), nh = between(rng, 1, Math.min(4, h - 5));
    const cut = (ww, hh) => rect(s, cx ? w - ww : 0, cz ? h - hh : 0, ww, hh, false);
    cut(nw, nh);
    if (nw >= 2 && rng.chance(0.4)) cut(between(rng, 1, nw - 1), Math.min(h - 5, nh + between(rng, 1, 3)));   // second step (staircase)
  }
  return s;
}

function famCirclish(rng) {
  // stepped superellipse |x/a|^p + |z/b|^p <= 1; p ~2 is a stepped ellipse, ~3.5 a rounded square
  const p = 2 + rng.next() * 1.6, ratio = 1 + rng.next() * 0.4, target = 148;
  const build = r => {
    const a = r * Math.sqrt(ratio), b = r / Math.sqrt(ratio), s = new Set();
    const R = Math.ceil(Math.max(a, b)) + 1;
    // grid offset: even or odd spans so the shape is not always symmetric about a cell centre
    const ox = rng2.offX, oz = rng2.offZ;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const x = i + 0.5 - ox, z = j + 0.5 - oz;
      if (Math.abs(x / a) ** p + Math.abs(z / b) ** p <= 1) s.add(key(i, j));
    }
    return s;
  };
  const rng2 = { offX: rng.chance(0.5) ? 0.5 : 0, offZ: rng.chance(0.5) ? 0.5 : 0 };
  let lo = 4, hi = 12, best = null;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2, s = build(mid);
    if (!best || Math.abs(s.size - target) < Math.abs(best.size - target)) best = s;
    if (s.size < target) lo = mid; else hi = mid;
  }
  if (rng.chance(0.5)) {   // flip the long axis
    const t = new Set(); for (const k of best) { const [i, j] = parse(k); t.add(key(j, i)); } best = t;
  }
  return best;
}

function famBlob(rng) {
  // union of 3-5 chunky rectangles, each overlapping the union so a 4x4 square can slide between them
  const s = new Set();
  const n = between(rng, 3, 5);
  const w0 = between(rng, 6, 9), h0 = between(rng, 6, 9);
  rect(s, 0, 0, w0, h0);
  let bx0 = 0, bz0 = 0, bx1 = w0, bz1 = h0;
  for (let k = 1; k < n || s.size < 120; k++) {
    if (k > 12) break;
    const w = between(rng, 4, 8), h = between(rng, 4, 8);
    // anchor so the new rect overlaps the current bbox by >= 4 along both axes
    const x = between(rng, bx0 - w + 4, bx1 - 4), z = between(rng, bz0 - h + 4, bz1 - 4);
    rect(s, x, z, w, h);
    bx0 = Math.min(bx0, x); bz0 = Math.min(bz0, z); bx1 = Math.max(bx1, x + w); bz1 = Math.max(bz1, z + h);
  }
  // fill concave gaps narrower than 4 cells (they would only become necks / slivers)
  return closeGaps(s);
}

function famChunky(rng) {
  // L / T / offset stack from big rectangles
  const kind = rng.pick(['L', 'T', 'stack', 'stack3']);
  const s = new Set();
  if (kind === 'stack' || kind === 'stack3') {
    // vertical stack of 2-3 wide bands, each shifted sideways (like a stepped Greenville-style outline)
    const bands = kind === 'stack' ? 2 : 3;
    let z = 0, x = 0;
    for (let b = 0; b < bands; b++) {
      const w = between(rng, 8, 11), h = bands === 2 ? between(rng, 6, 8) : between(rng, 4, 6);
      rect(s, x, z, w, h);
      z += h; x += between(rng, -3, 3);
    }
  } else {
    const W = between(rng, 9, 12), H = between(rng, 8, 10);
    rect(s, 0, 0, W, H);
    const aw = between(rng, 5, 7), ah = between(rng, 3, 5);   // arm width (>= 5 so it is never a corridor) and reach
    const at = kind === 'L' ? (rng.chance(0.5) ? 0 : W - aw) : Math.floor((W - aw) / 2) + between(rng, -1, 1);
    rect(s, at, H, aw, ah);
  }
  // random rotation / mirror
  const rot = rng.int(4), mir = rng.chance(0.5);
  const t = new Set();
  for (const k of s) {
    let [i, j] = parse(k);
    if (mir) i = -i;
    for (let r = 0; r < rot; r++) [i, j] = [-j, i];
    t.add(key(i, j));
  }
  return closeGaps(t);
}

// Fill outside cells that sit in a gap narrower than 4 cells between two inside cells on the same row/column
// (keeps blobs from developing slivers and pinches); iterates to a fixed point.
function closeGaps(s, gap = 3) {
  let changed = true;
  while (changed) {
    changed = false;
    const g = toGrid(s), { cw, ch, cells } = g;
    const at = (i, j) => (i >= 0 && j >= 0 && i < cw && j < ch ? cells[j * cw + i] : 0);
    const fill = [];
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      if (cells[j * cw + i]) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        let a = 0, b = 0;
        for (let d = 1; d <= gap; d++) if (at(i - di * d, j - dj * d)) { a = d; break; }
        for (let d = 1; d <= gap; d++) if (at(i + di * d, j + dj * d)) { b = d; break; }
        if (a && b && a + b - 1 <= gap) { fill.push([i, j]); break; }
      }
    }
    if (fill.length) { changed = true; const t = fromGrid(g); for (const [i, j] of fill) t.add(key(i, j)); s = t; }
  }
  return s;
}

// ---- area fix-up: add / remove straight strips (length >= minWidth) along the boundary ----------------------
function strips(g, adding, K) {
  const { cw, ch, cells } = g;
  const at = (i, j) => (i >= 0 && j >= 0 && i < cw && j < ch ? cells[j * cw + i] : 0);
  const out = [];
  for (const [di, dj] of DIRS) {
    // candidate cells: adding -> outside cells whose (-d) neighbour is inside; removing -> inside cells whose (+d) neighbour is outside
    const ok = (i, j) => (adding ? !at(i, j) && at(i - di, j - dj) : at(i, j) && !at(i + di, j + dj));
    const horiz = dj !== 0;   // run direction perpendicular to d
    const L1 = horiz ? ch + 2 : cw + 2, L2 = horiz ? cw + 2 : ch + 2;
    for (let a = -1; a < L1 - 1; a++) {
      let run = [];
      for (let b = -1; b <= L2 - 1; b++) {
        const [i, j] = horiz ? [b, a] : [a, b];
        if (b < L2 - 1 && ok(i, j)) run.push([i, j]);
        else { if (run.length >= K) out.push(run); run = []; }
      }
    }
  }
  return out;
}

function fixArea(set, rng, o) {
  const { minCells, maxCells, minWidth: K } = o;
  const target = between(rng, minCells + 1, maxCells - 1);
  for (let it = 0; it < 40; it++) {
    const g = toGrid(set);
    const area = set.size;
    if (area >= minCells && area <= maxCells && !checkOutlineCells(g, o)) return set;
    const adding = area < target;
    const need = Math.abs(target - area);
    const runs = rng.shuffle(strips(g, adding, K));
    let done = false;
    for (const run of runs) {
      // choose a sub-run length that moves the area toward [min,max] (or the full need), >= K
      const maxL = run.length;
      let L = Math.max(K, Math.min(maxL, need));
      if (L > maxL) continue;
      const off = rng.int(maxL - L + 1);
      // prefer strips flush with a run end (cleaner steps)
      const start = rng.chance(0.7) ? (rng.chance(0.5) ? 0 : maxL - L) : off;
      const t = new Set(set);
      for (const [i, j] of run.slice(start, start + L)) adding ? t.add(key(i, j)) : t.delete(key(i, j));
      const tg = toGrid(t);
      const r = checkOutlineCells(tg, { ...o, minCells: 0, maxCells: Infinity, maxAspect: 99, maxSide: 99 });
      if (r) continue;
      set = fromGrid(tg); done = true; break;
    }
    if (!done) return set;
  }
  return set;
}

// ---- public -------------------------------------------------------------------------------------------------
export function generateOutline(rng, opts = {}) {
  const o = { ...OUTLINE_DEFAULTS, ...opts };
  const families = opts.families ?? OUTLINE_FAMILIES;
  const fam = { notched: famNotched, circlish: famCirclish, blob: famBlob, chunky: famChunky };
  let family = opts.family ?? rng.pick(families);
  for (let attempt = 0; attempt < 400; attempt++) {
    if (attempt && !opts.family && attempt % 25 === 0) family = rng.pick(families);
    let s = fam[family](rng);
    s = fixArea(s, rng, o);
    const g = toGrid(s);
    if (checkOutlineCells(g, o)) continue;
    let area = 0;
    for (const c of g.cells) area += c;
    return { family, ...g, area, outline: cellsToOutline(g, o.cell) };
  }
  throw new Error(`generateOutline: no valid ${family} outline in 400 attempts`);
}
