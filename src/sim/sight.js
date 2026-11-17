// Line-of-sight over the 1 m grid (Amanatides-Woo DDA).
//
// grid.sight[cell]: 0 = clear, -1 = opaque (tall obstacle / outside outline), >0 = semi-transparent obstacle id.
// The ray multiplies visibility by `semiT` once per distinct semi-transparent obstacle it crosses (contiguous
// cells of the same obstacle count once). Start and end cells are never counted (so a generator can be seen,
// and standing in a pallet/window cell does not hide you).
//
// Returns visibility in [0,1]. If the running product drops below `minV` we return early with that
// (under-estimated) product -- callers only need to know "below threshold".
//
// Crouched target (README "Crouching"): pass `need` = a coverNeedTable (indexed by sight id). A semi-transparent
// cell whose exit parameter t along the ray (0 = viewer, 1 = target) reaches need[id] hides the target fully
// (returns 0): there the sight line from the viewer's eye to the top of the crouched body passes below the object's
// top. Without `need` (standing target) the behaviour is unchanged.

export function rayVis(grid, ax, az, bx, bz, semiT, minV, need) {
  const W = grid.w, H = grid.h, sight = grid.sight;
  let i = Math.floor(ax), j = Math.floor(az);
  const ei = Math.floor(bx), ej = Math.floor(bz);
  if (i === ei && j === ej) return 1;
  const dx = bx - ax, dz = bz - az;
  const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (i + 1 - ax) * tdx : dx < 0 ? (ax - i) * tdx : Infinity;
  let tmz = dz > 0 ? (j + 1 - az) * tdz : dz < 0 ? (az - j) * tdz : Infinity;
  let v = 1, last = 0;
  let guard = Math.abs(ei - i) + Math.abs(ej - j) + 2;
  while (guard-- > 0) {
    if (tmx < tmz) { i += si; tmx += tdx; }
    else if (tmz < tmx) { j += sj; tmz += tdz; }
    else { i += si; j += sj; tmx += tdx; tmz += tdz; }   // exact corner: pass diagonally
    if (i === ei && j === ej) break;
    if (i < 0 || j < 0 || i >= W || j >= H) return 0;
    const s = sight[j * W + i];
    if (s === 0) { last = 0; continue; }
    if (s < 0) return 0;
    if (need && (tmx < tmz ? tmx : tmz) >= need[s]) return 0;   // crouched target inside this object's shadow
    if (s !== last) { v *= semiT; if (v < minV) return v; last = s; }
  }
  return v;
}

// Crouch shadow behind a low object. Viewer eye height E, crouched body height hb, object top h (metres): the line
// from the eye (t = 0) to the top of the body (t = 1) has height E - (E - hb) t, so the object hides the whole body
// iff the ray leaves the object at t >= (E - h) / (E - hb). Returns that threshold (2 = never: h <= hb or no cover).
export function coverNeed(eye, body, h) {
  if (!(h > body) || !(eye > body)) return 2;
  if (h >= eye) return 0;
  return (eye - h) / (eye - body);
}

// Per-sight-id threshold table for one viewer eye height (index = grid.sight id; grid.sidKind / grid.sidH come from
// mapdata.js). Object heights: low obstacles = their map height; windows / pallets / generators = config.sight.*CoverM.
export function coverNeedTable(grid, sc, eye) {
  const n = grid.sidKind.length, out = new Float32Array(n).fill(2);
  for (let id = 1; id < n; id++) {
    const k = grid.sidKind[id];
    const h = k === 1 ? grid.sidH[id] : k === 2 ? sc.windowCoverM : k === 3 ? sc.palletCoverM : k === 4 ? sc.genCoverM : 0;
    out[id] = coverNeed(eye, sc.crouchBodyM, h);
  }
  return out;
}
