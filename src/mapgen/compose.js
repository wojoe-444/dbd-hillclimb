// Turns a composed character grid into map-format features: merged obstacle rectangles, windows and pallets
// with inferred axes. Zero deps.

import { SOLID_CHARS, isSolidChar } from './tiles.js';

export const OUTSIDE = ' ';

// grid: Array<string> of single chars, length w*h, row-major (index z*w + x). OUTSIDE = beyond the outline.
export function composeFeatures(grid, w, h, { owner = null, instName = () => 'x' } = {}) {
  const at = (x, z) => (x < 0 || z < 0 || x >= w || z >= h ? OUTSIDE : grid[z * w + x]);
  const solid = (x, z) => { const c = at(x, z); return c === OUTSIDE || isSolidChar(c); };
  const tag = (x, z) => (owner ? instName(owner[z * w + x]) : 'x');

  // Obstacles: greedy rectangle merge per character.
  const obstacles = [];
  const used = new Uint8Array(w * h);
  const counters = {};
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const ch = grid[z * w + x];
    if (!isSolidChar(ch) || used[z * w + x]) continue;
    let rw = 1;
    while (x + rw < w && grid[z * w + x + rw] === ch && !used[z * w + x + rw]) rw++;
    let rd = 1;
    grow: while (z + rd < h) {
      for (let i = x; i < x + rw; i++) if (grid[(z + rd) * w + i] !== ch || used[(z + rd) * w + i]) break grow;
      rd++;
    }
    for (let j = z; j < z + rd; j++) for (let i = x; i < x + rw; i++) used[j * w + i] = 1;
    const { kind, height } = SOLID_CHARS[ch];
    const base = `o-${tag(x, z)}-${kind}${height >= 1.6 ? '' : '-low'}`;
    counters[base] = (counters[base] ?? 0) + 1;
    obstacles.push({ id: `${base}-${counters[base]}`, x, z, w: rw, d: rd, height, kind });
  }

  const inferAxis = (x, z, len = 1, horizontal = true) => {
    if (len === 2) return horizontal ? 'z' : 'x';
    if (solid(x - 1, z) && solid(x + 1, z)) return 'z';
    if (solid(x, z - 1) && solid(x, z + 1)) return 'x';
    return 'x'; // invalid placement; the validator will report it
  };

  const windows = [];
  const wCount = {};
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) if (grid[z * w + x] === 'W') {
    const t = tag(x, z); wCount[t] = (wCount[t] ?? 0) + 1;
    windows.push({ id: `w-${t}-${wCount[t]}`, x, z, axis: inferAxis(x, z) });
  }

  const pallets = [];
  const pCount = {};
  const seen = new Uint8Array(w * h);
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    if (grid[z * w + x] !== 'P' || seen[z * w + x]) continue;
    seen[z * w + x] = 1;
    let length = 1, horizontal = true;
    if (at(x + 1, z) === 'P' && !seen[z * w + x + 1]) { length = 2; seen[z * w + x + 1] = 1; }
    else if (at(x, z + 1) === 'P' && !seen[(z + 1) * w + x]) { length = 2; horizontal = false; seen[(z + 1) * w + x] = 1; }
    const t = tag(x, z); pCount[t] = (pCount[t] ?? 0) + 1;
    pallets.push({ id: `p-${t}-${pCount[t]}`, x, z, axis: inferAxis(x, z, length, horizontal), length });
  }
  return { obstacles, windows, pallets };
}
