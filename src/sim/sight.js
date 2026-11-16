// Line-of-sight over the 1 m grid (Amanatides-Woo DDA).
//
// grid.sight[cell]: 0 = clear, -1 = opaque (tall obstacle / outside outline), >0 = semi-transparent obstacle id.
// The ray multiplies visibility by `semiT` once per distinct semi-transparent obstacle it crosses (contiguous
// cells of the same obstacle count once). Start and end cells are never counted (so a generator can be seen,
// and standing in a pallet/window cell does not hide you).
//
// Returns visibility in [0,1]. If the running product drops below `minV` we return early with that
// (under-estimated) product -- callers only need to know "below threshold".

export function rayVis(grid, ax, az, bx, bz, semiT, minV) {
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
    if (s !== last) { v *= semiT; if (v < minV) return v; last = s; }
  }
  return v;
}
