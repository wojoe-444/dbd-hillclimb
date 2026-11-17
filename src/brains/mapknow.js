// Per-survivor exploration memory (one instance per brain closure; no module-level state).
//
//   explored: coarse grid (cs m cells) of what this survivor has seen: a cell counts as explored once its centre was
//             within `seeR` m and in line of sight (360 deg, the engine's semi-transparency via api.los). Updated at
//             ~1 Hz, at most `raysPer` rays per update (nearest unexplored cells first), so it costs little and less
//             and less as the map fills in.
//   anchors : windows / pallets count as "known" (usable for loops) once seen (in line of sight within `anchorR` m).
//             Static geometry is otherwise available for navigation; this only gates the brain's loop choice.
//   gens    : the engine already withholds unfound generators (obs.gens[i].known).
//   cands   : the public generator candidates (ctx.map.generatorCandidates: the wrecks are visible static geometry).
//             A candidate is resolved once it matches a found gen (obs.gens[i].known at its position), or once I've
//             had it in view (within candSeeR, camera + line of sight) on candConfirm separate updates without it
//             turning out to be a gen: then it's a wreck. candP() = P(an unresolved candidate is a gen) =
//             unfound gens / unresolved candidates. Nothing here reads which candidates were chosen.
//
// Queries: explored(x,z), unexploredNear(x,z,r) (fraction), pickTarget(me, prefR) (an unexplored spot worth walking to).

import { viewOf } from './hunterbelief.js';

export class MapKnowledge {
  constructor(ctx, anchors, opts = {}) {
    const M = ctx.map;
    this.cs = opts.cellSize ?? 6;
    this.seeR = opts.seeR ?? 30;
    this.anchorR = opts.anchorR ?? 40;
    this.raysPer = opts.raysPer ?? 60;
    this.W = Math.ceil(M.w / this.cs); this.H = Math.ceil(M.h / this.cs);
    const N = this.W * this.H, cs = this.cs;
    // a coarse cell is "open" if its centre is inside the outline and not inside an obstacle
    this.open = new Uint8Array(N);
    const solid = (x, z) => { for (const o of M.obstacles) if (x >= o.x && x < o.x + o.w && z >= o.z && z < o.z + o.d) return true; return false; };
    this.cx = new Float32Array(N); this.cz = new Float32Array(N);
    for (let J = 0; J < this.H; J++) for (let I = 0; I < this.W; I++) {
      const c = J * this.W + I;
      let x = Math.min(M.w - 0.5, I * cs + cs / 2), z = Math.min(M.h - 0.5, J * cs + cs / 2);
      // nudge the centre to a free spot inside the cell if needed
      let ok = inPoly(x, z, M.outline) && !solid(x, z);
      for (let t = 0; t < 8 && !ok; t++) {
        const xx = I * cs + 0.5 + ((t * 2.3) % cs), zz = J * cs + 0.5 + ((t * 3.7) % cs);
        if (xx < M.w && zz < M.h && inPoly(xx, zz, M.outline) && !solid(xx, zz)) { x = xx; z = zz; ok = true; }
      }
      this.open[c] = ok ? 1 : 0;
      this.cx[c] = x; this.cz[c] = z;
    }
    this.nOpen = this.open.reduce((a, b) => a + b, 0);
    this.seen = new Uint8Array(N);
    this.nSeen = 0;
    this.anchors = anchors;
    this.anchorKnown = new Uint8Array(anchors.length);
    // tile recognition (opts.tileGestalt, default on): a glimpse of any part of a standard tile (one of its windows /
    // pallets, or its middle) reveals the tile's whole layout, like a player who knows the tile set
    this.tileGestalt = opts.tileGestalt ?? true;
    this.tiles = (M.tiles || []).map((t) => ({ x: t.x, z: t.z, size: t.size, cx: t.x + t.size / 2, cz: t.z + t.size / 2, anchors: [] }));
    this.anchorTile = new Int32Array(anchors.length).fill(-1);
    anchors.forEach((a, k) => { const ti = this.tiles.findIndex((t) => a.c.x >= t.x && a.c.x < t.x + t.size && a.c.z >= t.z && a.c.z < t.z + t.size); if (ti >= 0) { this.anchorTile[k] = ti; this.tiles[ti].anchors.push(k); } });
    this.tileKnown = new Uint8Array(this.tiles.length);
    // a coarse cell counts as explored when ANY of 5 sample points (centre + 4 offsets) is in view, not only its centre
    this.samp = [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]].map(([u, v]) => [u * this.cs / 3, v * this.cs / 3]);
    this.lastT = -99;
    this.camCfg = ctx.config.survivor && ctx.config.survivor.camera && ctx.config.survivor.camera.enabled ? ctx.config.survivor.camera : null;
    this.cands = (M.generatorCandidates || []).map((g) => ({ x: g.x, z: g.z }));
    this.candRes = new Int8Array(this.cands.length);     // 0 unresolved, 1 = a gen (found), -1 = a wreck
    this.candHits = new Uint8Array(this.cands.length);
    this.candSeeR = opts.candSeeR ?? 22;
    this.candConfirm = opts.candConfirm ?? 3;
    this.nUnres = this.cands.length;
    this.unfound = 0;
  }

  // candidates: match found gens, count in-view sightings of the rest (called from update with the same view test)
  updateCands(obs, sees) {
    const gens = obs.gens || [];
    let known = 0;
    for (const g of gens) if (g.known) known++;
    this.unfound = gens.length - known;
    const me = obs.self, r2 = this.candSeeR * this.candSeeR;
    for (let k = 0; k < this.cands.length; k++) {
      if (this.candRes[k]) continue;
      const c = this.cands[k];
      if (gens.some((g) => g.known && Math.abs(g.x - c.x) < 1 && Math.abs(g.z - c.z) < 1)) { this.candRes[k] = 1; this.nUnres--; continue; }
      if (this.unfound === 0) { this.candRes[k] = -1; this.nUnres--; continue; }
      if (sees && (c.x - me.x) ** 2 + (c.z - me.z) ** 2 <= r2 && sees(c.x, c.z)) {
        if (++this.candHits[k] >= this.candConfirm) { this.candRes[k] = -1; this.nUnres--; }
      }
    }
  }
  candP() { return this.nUnres > 0 ? Math.min(1, this.unfound / this.nUnres) : 0; }
  // the best unresolved candidate to walk toward: P(gen) x weight - distance / prefR (+ caller's bonus); null if none
  pickCand(me, prefR, bonus = null) {
    let best = null, bs = -Infinity;
    for (let k = 0; k < this.cands.length; k++) {
      if (this.candRes[k]) continue;
      const c = this.cands[k], d = Math.hypot(c.x - me.x, c.z - me.z);
      const s = -d / prefR + (bonus ? bonus(k) : 0);
      if (s > bs) { bs = s; best = k; }
    }
    return best;
  }

  cellAt(x, z) {
    const I = Math.min(this.W - 1, Math.max(0, Math.floor(x / this.cs))), J = Math.min(this.H - 1, Math.max(0, Math.floor(z / this.cs)));
    return J * this.W + I;
  }

  update(obs, api, everyS = 1) {
    const me = obs.self;
    const c0 = this.cellAt(me.x, me.z);
    if (!this.seen[c0]) { this.seen[c0] = 1; this.nSeen++; }
    if (obs.t - this.lastT < everyS) return;
    this.lastT = obs.t;
    // explored cells: nearest unexplored open cells within seeR, LOS-tested
    const R = Math.ceil(this.seeR / this.cs), I0 = c0 % this.W, J0 = (c0 / this.W) | 0, r2 = this.seeR * this.seeR;
    const cand = [];
    for (let J = Math.max(0, J0 - R); J <= Math.min(this.H - 1, J0 + R); J++) for (let I = Math.max(0, I0 - R); I <= Math.min(this.W - 1, I0 + R); I++) {
      const c = J * this.W + I;
      if (this.seen[c] || !this.open[c]) continue;
      const d = (this.cx[c] - me.x) ** 2 + (this.cz[c] - me.z) ** 2;
      if (d <= r2) cand.push([d, c]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const sees = viewOf(obs, api, this.camCfg, this.seeR + 4);   // camera FOV + body awareness (or 360 without camera)
    this.updateCands(obs, sees);
    for (let k = 0; k < cand.length && k < this.raysPer; k++) {
      const c = cand[k][1];
      for (const [ox, oz] of this.samp) if (sees(this.cx[c] + ox, this.cz[c] + oz)) { this.seen[c] = 1; this.nSeen++; break; }
    }
    // anchors
    const a2 = this.anchorR * this.anchorR;
    for (let k = 0; k < this.anchors.length; k++) {
      if (this.anchorKnown[k]) continue;
      const a = this.anchors[k];
      if ((a.c.x - me.x) ** 2 + (a.c.z - me.z) ** 2 > a2) continue;
      if (sees(a.s[0].x, a.s[0].z) || sees(a.s[1].x, a.s[1].z) || sees(a.c.x, a.c.z)) { this.anchorKnown[k] = 1; if (this.tileGestalt && this.anchorTile[k] >= 0) this.knowTile(this.anchorTile[k]); }
    }
    if (this.tileGestalt) for (let t = 0; t < this.tiles.length; t++) {
      const T = this.tiles[t];
      if (this.tileKnown[t] || !T.anchors.length || (T.cx - me.x) ** 2 + (T.cz - me.z) ** 2 > a2) continue;
      if (sees(T.cx, T.cz)) this.knowTile(t);
    }
  }

  knowTile(t) { this.tileKnown[t] = 1; for (const k of this.tiles[t].anchors) this.anchorKnown[k] = 1; }

  explored(x, z) { return !!this.seen[this.cellAt(x, z)]; }
  fraction() { return this.nOpen ? this.nSeen / this.nOpen : 1; }

  unexploredNear(x, z, r) {
    const R = Math.ceil(r / this.cs), c0 = this.cellAt(x, z), I0 = c0 % this.W, J0 = (c0 / this.W) | 0, r2 = r * r;
    let n = 0, u = 0;
    for (let J = Math.max(0, J0 - R); J <= Math.min(this.H - 1, J0 + R); J++) for (let I = Math.max(0, I0 - R); I <= Math.min(this.W - 1, I0 + R); I++) {
      const c = J * this.W + I;
      if (!this.open[c] || (this.cx[c] - x) ** 2 + (this.cz[c] - z) ** 2 > r2) continue;
      n++; if (!this.seen[c]) u++;
    }
    return n ? u / n : 0;
  }

  // an unexplored open cell: score = unexplored share around it - straight distance / prefR (+ tiny per-survivor jitter)
  pickTarget(me, prefR, jitter = null) {
    let best = null, bs = -Infinity;
    for (let c = 0; c < this.seen.length; c++) {
      if (this.seen[c] || !this.open[c]) continue;
      const d = Math.hypot(this.cx[c] - me.x, this.cz[c] - me.z);
      const s = this.unexploredNear(this.cx[c], this.cz[c], 12) - d / prefR + (jitter ? jitter(c) : 0);
      if (s > bs) { bs = s; best = { x: this.cx[c], z: this.cz[c], c }; }
    }
    return best;
  }
}

function inPoly(x, z, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
