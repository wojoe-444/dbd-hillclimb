// Navigation: 8-connected octile Dijkstra distance fields (no corner cutting), A*, string-pulled waypoints, and the
// swept-circle walkability test used by movement.
//
// DETERMINISM: all path costs are exact integers (millimetres: 1000 / 1414 / vault extras), so a distance is the same
// number whether it came from a cached field or from A*. The waypoint search algorithm depends on the
// target cell (never on cache history): map-feature cells (generators, hooks, pallets, windows, levers, exits,
// spawns) always use the canonical field descent; every other target uses A* (route cached per agent).
// A move a -> b costs STEP + extra(b) (extra = vault penalty for entering a window cell).
//
// Windows / pallet cells can only be entered along their axis (mapdata nbMask). Survivors may path through dropped
// pallets (vault). The hunter variant treats DROPPED pallets as blocked: static fields are reused while the route
// does not cross a dropped pallet, otherwise a pallet-aware A* (or, past its budget, a per-match field) is used.
// Entity-blocked windows and windows while carrying are excluded from the actor's searches and fields.

import { K_SOLID, K_WIN_X, K_WIN_Z, K_PAL_X } from './mapdata.js';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const STEP = [1000, 1000, 1000, 1000, 1414, 1414, 1414, 1414];

/** True when a circle of radius R centred at (x,z) does not overlap any blocked cell. */
export function circleFree(coll, W, H, x, z, R) {
  const i0 = Math.floor(x - R), i1 = Math.floor(x + R), j0 = Math.floor(z - R), j1 = Math.floor(z + R);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) return false;
      if (coll[j * W + i] !== 0) {
        const cx = x < i ? i : (x > i + 1 ? i + 1 : x);
        const cz = z < j ? j : (z > j + 1 ? j + 1 : z);
        const dx = x - cx, dz = z - cz;
        if (dx * dx + dz * dz < R * R) return false;
      }
    }
  }
  return true;
}

export class NavShared {
  constructor(md, cfg) {
    this.md = md;
    const N = md.N, W = md.w;
    this.hk = new Float64Array(N * 8 + 64);
    this.hv = new Int32Array(N * 8 + 64);
    this.hn = 0; this.topK = 0;
    this.g = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.stamp = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.gen = 0;
    this.fieldsS = new Map();
    this.fieldsH = new Map();
    this.windowCells = new Set(md.windows.map(w => w.cell));
    this.cap = cfg.nav.fieldCacheSize;
    this.lastCost = 0;
    this.capped = false;
    this.off = new Int32Array([1, -1, W, -W, W + 1, 1 - W, W - 1, -W - 1]);
  }
  push(k, v) {
    const K = this.hk, V = this.hv;
    let i = this.hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.hk, V = this.hv;
    const top = V[0]; this.topK = K[0];
    const n = --this.hn;
    if (n > 0) {
      const k = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = k; V[i] = v;
    }
    return top;
  }

  /** Cost-to-go field (millimetres) to `target` (may be a solid cell, e.g. a generator). hps: pallet states or null. */
  computeField(target, hps, winCost, blockedWindows = null) {
    const md = this.md, N = md.N, kind = md.kind, palIdx = md.palIdx, mask = md.nbMask, off = this.off;
    const dist = new Float32Array(N).fill(Infinity);
    this.hn = 0;
    dist[target] = 0;
    this.push(0, target);
    while (this.hn > 0) {
      const u = this.pop();
      const du = this.topK;
      if (du > dist[u]) continue;
      const ku = kind[u];
      const base = du + ((ku === K_WIN_X || ku === K_WIN_Z) ? winCost : 0);   // a neighbour moving INTO u pays extra(u)
      const m = mask[u];
      for (let d = 0; d < 8; d++) {
        if ((m & (1 << d)) === 0) continue;
        const v = u + off[d];
        if (blockedWindows?.has(v)) continue;
        if (hps !== null && kind[v] >= K_PAL_X && hps[palIdx[v] - 1] === 1) continue;
        const nd = base + STEP[d];
        if (nd < dist[v]) { dist[v] = nd; this.push(nd, v); }
      }
    }
    return dist;
  }

  // A* from start to goal (costs in mm; optimal). A blocked goal (generator, dropped pallet) is entered under the same
  // rules the field uses and dropped from the returned path. Returns cells (start ... last walkable), or null
  // (unreachable; `this.capped` is set when the expansion budget ran out instead).
  astar(start, goal, hps, winCost, maxExp, blockedWindows = null) {
    const md = this.md, W = md.w, H = md.h, kind = md.kind, palIdx = md.palIdx, mask = md.nbMask;
    const g = this.g, parent = this.parent, stamp = this.stamp, closed = this.closed;
    if (++this.gen > 4e9) { stamp.fill(0); closed.fill(0); this.gen = 1; }
    const gen = this.gen;
    const gi = goal % W, gj = (goal / W) | 0;
    const kg = kind[goal];
    const goalBlocked = kg === K_SOLID || (kg >= K_PAL_X && hps !== null && hps[palIdx[goal] - 1] === 1);
    const gmask = mask[goal];
    this.hn = 0; this.capped = false;
    g[start] = 0; stamp[start] = gen; parent[start] = -1;
    this.push(0, start);
    let exp = 0;
    while (this.hn > 0) {
      const u = this.pop();
      if (closed[u] === gen) continue;
      closed[u] = gen;
      if (u === goal) {
        const path = [];
        for (let c = goalBlocked ? parent[u] : u; c !== -1; c = parent[c]) path.push(c);
        path.reverse();
        this.lastCost = g[u];
        return path;
      }
      if (++exp > maxExp) { this.capped = true; return null; }
      const gu = g[u];
      const m = mask[u];
      const i = u % W, j = (u / W) | 0;
      for (let d = 0; d < 8; d++) {
        const ni = i + DX[d], nj = j + DZ[d];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const v = nj * W + ni;
        if (blockedWindows?.has(v)) continue;
        if (v === goal && goalBlocked) { if ((gmask & (1 << OPP[d])) === 0) continue; }
        else {
          if ((m & (1 << d)) === 0) continue;
          if (hps !== null && kind[v] >= K_PAL_X && hps[palIdx[v] - 1] === 1) continue;
        }
        if (closed[v] === gen) continue;
        const kv = kind[v];
        const ng = gu + STEP[d] + ((kv === K_WIN_X || kv === K_WIN_Z) ? winCost : 0);
        if (stamp[v] !== gen || ng < g[v]) {
          g[v] = ng; stamp[v] = gen; parent[v] = u;
          const adx = ni > gi ? ni - gi : gi - ni, adz = nj > gj ? nj - gj : gj - nj;
          const h = adx > adz ? 1000 * adx + 414 * adz : 1000 * adz + 414 * adx;   // octile, admissible + consistent
          this.push(ng + h + h * 1e-7, v);                                          // tie-break toward the goal
        }
      }
    }
    return null;
  }
}

export function getShared(md, cfg) {
  if (!md.nav) md.nav = new NavShared(md, cfg);
  return md.nav;
}

/** Navigation view bound to one actor and one match's traversal state. */
export class NavView {
  constructor(shared, match, role, id) {
    this.sh = shared;
    this.m = match;
    this.md = shared.md;
    this.hunter = role === 'hunter';
    this.id = id;
    const cfgN = match.cfg.nav;
    this.winCost = Math.round((this.hunter ? cfgN.windowCostHunter : cfgN.windowCostSurvivor) * 1000);
    this.cfgN = cfgN;
    this.hits = new Uint8Array(this.md.N);       // recent-query counters per target cell (decay after 2 s)
    this.hitT = new Uint16Array(this.md.N);
    this.local = new Map();      // fields for this actor's current traversal restrictions
    this.localVer = -1;
    this.windowBlocks = null;
    this.rt = null;              // cached A* route {tc, ver, nodes, i}
    this.waypoint = { ver: -1, fx: 0, fz: 0, tx: 0, tz: 0, x: 0, z: 0 };
    this.radius = match.cfg.radius;
  }

  cell(x, z) {
    const i = Math.floor(x), j = Math.floor(z);
    if (i < 0 || j < 0 || i >= this.md.w || j >= this.md.h) return -1;
    return j * this.md.w + i;
  }

  _hit(tc) {
    const tick = this.m.tick;
    if (tick - this.hitT[tc] > 20) this.hits[tc] = 0;
    this.hitT[tc] = tick;
    const h = this.hits[tc] + 1;
    if (h < 255) this.hits[tc] = h;
    return h;
  }

  _dyn() { return this.hunter && this.m.droppedCount > 0; }

  _windowBlocks() {
    const m = this.m;
    let blocks = this.windowBlocks, changed = false;
    if (this.hunter) {
      const all = this.sh.windowCells;
      blocks = all.size > 0 && m.hunter.carrying >= 0 ? all : null;
      changed = blocks !== this.windowBlocks;
    } else {
      const windows = this.md.windows;
      for (let i = 0; i < windows.length; i++) {
        const cell = windows[i].cell;
        const blocked = m._windowBlocked(i, this.id);
        if ((blocks?.has(cell) ?? false) === blocked) continue;
        if (blocked) (blocks ??= new Set()).add(cell);
        else blocks.delete(cell);
        changed = true;
      }
      if (blocks?.size === 0) blocks = null;
    }
    if (changed) {
      // Expiry and carry transitions can change routes even when the pallet state and endpoints match.
      this.windowBlocks = blocks;
      this.local.clear();
      this.rt = null;
      this.waypoint.ver = -1;
    }
    return blocks;
  }

  _fieldStatic(cell, build = true) {
    const cache = this.hunter ? this.sh.fieldsH : this.sh.fieldsS;
    // Matches on the same map can price window edges differently.
    const key = `${this.winCost}:${cell}`;
    let f = cache.get(key);
    if (f !== undefined) {
      cache.delete(key);
    } else if (build) {
      f = this.sh.computeField(cell, null, this.winCost);
      if (cache.size >= this.sh.cap) cache.delete(cache.keys().next().value);
    } else {
      return undefined;
    }
    cache.set(key, f);
    return f;
  }
  _localMap() {
    if (this.localVer !== this.m.palVersion) { this.local.clear(); this.localVer = this.m.palVersion; }
    return this.local;
  }
  _peekLocal(cell) { return this._localMap().get(cell); }
  _fieldLocal(cell, hps, blockedWindows) {
    const map = this._localMap();
    let f = map.get(cell);
    if (f === undefined) {
      f = this.sh.computeField(cell, hps, this.winCost, blockedWindows);
      if (map.size >= 48) map.delete(map.keys().next().value);
      map.set(cell, f);
    }
    return f;
  }

  // Canonical descent of a cost-to-go field from fc: at each cell take the first (in direction order) neighbour that
  // minimises STEP + extra(v) + f[v]. Depends on the target, window cost and pallet state. A blocked goal cell
  // (generator, dropped pallet) is not included in the result.
  _follow(f, fc, maxN, hps) {
    const md = this.md, kind = md.kind, palIdx = md.palIdx, mask = md.nbMask, off = this.sh.off, wc = this.winCost;
    const path = [fc];
    let u = fc;
    while (path.length < maxN && f[u] > 0) {
      const m = mask[u], fu = f[u];
      let best = -1, bv = Infinity;
      for (let d = 0; d < 8; d++) {
        if ((m & (1 << d)) === 0) continue;
        const v = u + off[d];
        if (hps !== null && kind[v] >= K_PAL_X && hps[palIdx[v] - 1] === 1) continue;
        if (!(f[v] < fu)) continue;
        const kv = kind[v];
        const c = f[v] + STEP[d] + ((kv === K_WIN_X || kv === K_WIN_Z) ? wc : 0);
        if (c < bv) { bv = c; best = v; }
      }
      if (best < 0) break;
      u = best;
      path.push(u);
    }
    if (path.length > 1 && f[u] === 0) {
      const k = kind[u];
      if (k === K_SOLID || (k >= K_PAL_X && hps !== null && hps[palIdx[u] - 1] === 1)) path.pop();
    }
    return path;
  }

  _crossesDropped(path) {
    const kind = this.md.kind, palIdx = this.md.palIdx, ps = this.m.ps;
    for (let k = 0; k < path.length; k++) { const c = path[k]; if (kind[c] >= K_PAL_X && ps[palIdx[c] - 1] === 1) return true; }
    return false;
  }

  /**
   * Path length in metres (octile + vault penalties) between two points; Infinity if unreachable.
   * O(1) when either endpoint's field is cached (map features); otherwise a bounded A* (~0.05-0.4 ms), and
   * repeatedly-queried targets get a cached field. For the hunter with a dropped pallet on the route it is
   * pallet-aware; past its search budget the static distance plus nav.crossPenalty is returned.
   */
  dist(from, to) {
    const fc = this.cell(from.x, from.z), tc = this.cell(to.x, to.z);
    if (fc < 0 || tc < 0) return Infinity;
    const blockedWindows = this._windowBlocks();
    if (blockedWindows?.has(fc) || blockedWindows?.has(tc)) return Infinity;
    if (fc === tc) return Math.hypot(to.x - from.x, to.z - from.z);
    // from inside a solid cell (e.g. a brain's extrapolated / estimated position): no move enters a solid cell, so every
    // field says Infinity there, while a cold A* would step out of it -> answer like the field (cache-state independent)
    if (this.md.kind[fc] === K_SOLID) return Infinity;
    const dyn = this._dyn(), hps = dyn ? this.m.ps : null;
    // A carrying hunter's walking field cannot start on a dropped pallet.
    if (blockedWindows && hps?.[this.md.palIdx[fc] - 1] === 1) return Infinity;
    if (dyn || blockedWindows) { const lf = this._peekLocal(tc); if (lf !== undefined) return lf[fc] / 1000; }
    // NOTE: no reverse-field shortcut (using the field of `from`): fields are not symmetric at solid/window endpoints,
    // so it made results depend on which fields happened to be cached.
    let f = blockedWindows ? undefined : this._fieldStatic(tc, false);
    const cfgN = this.cfgN;
    if (f === undefined) {
      if (this._hit(tc) < cfgN.fieldAfterHits) {
        const p = this.sh.astar(fc, tc, hps, this.winCost, cfgN.astarMaxExpand, blockedWindows);
        if (p) return this.sh.lastCost / 1000;
        if (!this.sh.capped) return Infinity;
      }
      f = blockedWindows ? this._fieldLocal(tc, hps, blockedWindows) : this._fieldStatic(tc);
    }
    const d = f[fc];
    if (blockedWindows || !dyn || d === Infinity || !this._crossesDropped(this._follow(f, fc, 100000, null))) return d / 1000;
    const p = this.sh.astar(fc, tc, this.m.ps, this.winCost, cfgN.astarMaxExpand);
    if (p) return this.sh.lastCost / 1000;
    return this.sh.capped ? d / 1000 + cfgN.crossPenalty : Infinity;
  }

  walkClear(ax, az, bx, bz) {
    const md = this.md, coll = this.m.coll, R = this.radius;
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.ceil(len / 0.4);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!circleFree(coll, md.w, md.h, ax + dx * t, az + dz * t, R)) return false;
    }
    return true;
  }

  _isVault(c) {
    const k = this.md.kind[c];
    if (k === K_WIN_X || k === K_WIN_Z) return true;
    return !this.hunter && k >= K_PAL_X && this.m.ps[this.md.palIdx[c] - 1] === 1;
  }

  // cells from `fc` toward `tc` (fc first; a blocked goal is not included; may be truncated to the lookahead), or null
  _path(fc, tc, blockedWindows) {
    const cfgN = this.cfgN, maxN = cfgN.lookahead + 2;
    const dyn = this._dyn(), ver = this.m.palVersion;
    const hps = dyn ? this.m.ps : null;
    const rt = this.rt;
    if (rt !== null && rt.tc === tc && rt.ver === ver) {      // still on a cached A* route?
      const nodes = rt.nodes, lim = Math.min(nodes.length, rt.i + 8);
      for (let k = rt.i; k < lim; k++) if (nodes[k] === fc) { rt.i = k; return nodes.slice(k, k + maxN); }
    }
    if (this.md.keyCell[tc] === 1) {                          // map feature: canonical field descent
      let lf;
      if (blockedWindows) lf = this._fieldLocal(tc, hps, blockedWindows);
      else if (dyn) lf = this._peekLocal(tc);
      if (lf !== undefined) return lf[fc] < Infinity ? this._follow(lf, fc, maxN, hps) : null;
      const sf = this._fieldStatic(tc);
      if (!(sf[fc] < Infinity)) return null;
      const p = this._follow(sf, fc, maxN, null);
      if (!dyn || !this._crossesDropped(p)) return p;
    }
    const p = this.sh.astar(fc, tc, hps, this.winCost, cfgN.astarMaxExpand, blockedWindows);
    if (p) { this.rt = { tc, ver, nodes: p, i: 0 }; return p.length > maxN ? p.slice(0, maxN) : p; }
    if (!this.sh.capped) return null;
    const f = dyn || blockedWindows ? this._fieldLocal(tc, hps, blockedWindows) : this._fieldStatic(tc);
    return f[fc] < Infinity ? this._follow(f, fc, maxN, hps) : null;
  }

  /**
   * Next point to steer toward when travelling from `from` to `to`. String-pulled: the farthest path node that is
   * reachable in a straight (swept-circle) line. Returns {x,z} or null if unreachable. If `to` lies in a solid cell
   * (generator, dropped pallet) the result ends at the last walkable cell centre in front of it.
   */
  nextWaypoint(from, to) {
    const out = { x: 0, z: 0 };
    return this._next(from.x, from.z, to.x, to.z, out) ? out : null;
  }

  _next(fx, fz, tx, tz, out) {
    // Grid routes can be reused as an actor moves, but steering clearance depends on both exact endpoints.
    const blockedWindows = this._windowBlocks();
    const wp = this.waypoint, ver = this.m.palVersion;
    if (wp.ver === ver && wp.fx === fx && wp.fz === fz && wp.tx === tx && wp.tz === tz) {
      out.x = wp.x; out.z = wp.z;
      return true;
    }
    if (!this._computeNext(fx, fz, tx, tz, out, blockedWindows)) return false;
    wp.ver = ver; wp.fx = fx; wp.fz = fz; wp.tx = tx; wp.tz = tz;
    wp.x = out.x; wp.z = out.z;
    return true;
  }

  _computeNext(fx, fz, tx, tz, out, blockedWindows) {
    const md = this.md, W = md.w, kind = md.kind;
    const fc = this.cell(fx, fz), tc = this.cell(tx, tz);
    if (fc < 0 || tc < 0) return false;
    if (blockedWindows?.has(fc) || blockedWindows?.has(tc)) return false;
    if (fc === tc || this.walkClear(fx, fz, tx, tz)) {
      out.x = tx; out.z = tz;
      return true;
    }
    const nodes = this._path(fc, tc, blockedWindows);
    if (!nodes) return false;
    const n = nodes.length;
    if (n === 1) { out.x = (nodes[0] % W) + 0.5; out.z = ((nodes[0] / W) | 0) + 0.5; return true; }
    let maxJ = Math.min(n - 1, this.cfgN.lookahead);
    // vault handling: do not string-pull past the approach cell of a window / dropped pallet
    for (let k = 1; k <= maxJ; k++) {
      if (this._isVault(nodes[k])) {
        if (k === 1) {
          const ci = nodes[0] % W, cj = (nodes[0] / W) | 0;
          const axisX = (kind[nodes[1]] === K_WIN_X || kind[nodes[1]] === K_PAL_X);
          const lat = axisX ? fz - (cj + 0.5) : fx - (ci + 0.5);
          const tgt = nodes[k + 1] !== undefined ? nodes[k + 1] : nodes[k];
          if (Math.abs(lat) > 0.12) { out.x = ci + 0.5; out.z = cj + 0.5; }
          else { out.x = (tgt % W) + 0.5; out.z = ((tgt / W) | 0) + 0.5; }
          return true;
        }
        maxJ = k - 1;
        break;
      }
    }
    let pick = 1;
    for (let j = maxJ; j >= 2; j--) {
      const c = nodes[j];
      if (this.walkClear(fx, fz, (c % W) + 0.5, ((c / W) | 0) + 0.5)) { pick = j; break; }
    }
    const c = nodes[pick];
    out.x = (c % W) + 0.5; out.z = ((c / W) | 0) + 0.5;
    return true;
  }
}
