// "Canary" metric: do survivors abuse the deliberately broken infinite-loop probe tile of the Gas Heaven variants?
// (four windows, two sealed corridors; docs/research/infinite-loop-deaths.md). Real players would loop it for as long
// as the entity blocker allows, so chase time spent there is a cheap signal that survivors find the obvious loops.
//
// Read-only observer of a live Match (engine state, never brain state); O(4) per tick, no allocation per tick.
//
//   import { makeCanary } from '../src/diag/canary.js';
//   const m = createMatch({ map, ... }); const can = makeCanary(m, map);   // map = the JSON given to createMatch
//   while (!m.over) { m.step(); can.step(); }
//   can.result()   // { present, chaseS, tileChaseS, chases, tileChases, tileVaults, laps, tileChaseLenS, otherChaseLenS,
//                  //   tileDowns, tileShare }
//   mergeCanary([r1, r2, ...]) -> the same fields summed / pooled over matches (+ matches, matchesPresent)
//
// Tile location: map.mapgen.tiles entry with tile === 'infinite-loop' (its square, rotation-invariant); maps without it
// report present: false and zeros. "On the tile" = the chased survivor's body inside that square.

export function findInfLoopTile(map) {
  const t = map && map.mapgen && Array.isArray(map.mapgen.tiles) ? map.mapgen.tiles.find((x) => x.tile === 'infinite-loop') : null;
  return t ? { x0: t.x, z0: t.z, x1: t.x + t.size, z1: t.z + t.size } : null;
}

export function makeCanary(m, map) {
  const sq = findInfLoopTile(map);
  const inside = (p) => sq && p.x >= sq.x0 && p.x <= sq.x1 && p.z >= sq.z0 && p.z <= sq.z1;
  // tile windows: window index -> true (cells via the engine's window table)
  const tileWin = new Set();
  if (sq) m.md.windows.forEach((w, i) => { if (inside({ x: w.x + 0.5, z: w.z + 0.5 })) tileWin.add(i); });
  const r = { present: !!sq, chaseS: 0, tileChaseS: 0, chases: 0, tileChases: 0, tileVaults: 0, laps: 0, tileChaseLenS: 0, otherChaseLenS: 0, tileDowns: 0, otherDowns: 0 };
  let cur = null;                                   // { id, who, dur, tileS, vaults, laps }
  const lastVault = [null, null, null, null];       // per survivor: last vault object seen (new object = new vault)
  const lapTail = [[], [], [], []];                 // distinct tile windows in the current run of tile vaults
  const close = (downed) => {
    if (!cur) return;
    r.chases++;
    const onTile = cur.tileS >= 2 || cur.vaults > 0;
    if (onTile) { r.tileChases++; r.tileChaseLenS += cur.dur; if (downed) r.tileDowns++; }
    else { r.otherChaseLenS += cur.dur; if (downed) r.otherDowns++; }
    cur = null;
  };
  return {
    step() {
      const dt = m.dt, tgt = m.chaseTgt;
      if (cur && (tgt !== cur.who || m.chaseId !== cur.id)) { const s = m.survivors[cur.who]; close(s.st >= 2); }
      if (tgt >= 0 && !cur) cur = { id: m.chaseId, who: tgt, dur: 0, tileS: 0, vaults: 0 };
      if (cur) {
        const s = m.survivors[cur.who];
        cur.dur += dt; r.chaseS += dt;
        if (inside(s)) { cur.tileS += dt; r.tileChaseS += dt; }
      }
      if (!tileWin.size) return;
      for (let k = 0; k < 4; k++) {
        const s = m.survivors[k], v = s.vault;
        if (v && v !== lastVault[k]) {
          const wi = m.winOfCell.get(v.cell);
          if (wi !== undefined && tileWin.has(wi) && tgt === k) {
            r.tileVaults++; if (cur) cur.vaults++;
            const tail = lapTail[k];
            if (tail.includes(wi)) tail.length = 0;  // a repeat (hold / reversal) restarts the lap count
            tail.push(wi);
            if (tail.length === tileWin.size) { r.laps++; tail.length = 0; }
          } else if (wi !== undefined && !tileWin.has(wi)) lapTail[k].length = 0;
        }
        lastVault[k] = v || null;
      }
    },
    result() {
      if (cur) { const s = m.survivors[cur.who]; close(s.st >= 2); }
      return finish({ ...r });
    },
  };
}

function finish(r) {
  const other = r.chases - r.tileChases;
  r.tileShare = r.chaseS > 0 ? r.tileChaseS / r.chaseS : 0;
  r.meanTileChaseS = r.tileChases ? r.tileChaseLenS / r.tileChases : 0;
  r.meanOtherChaseS = other ? r.otherChaseLenS / other : 0;
  return r;
}

export function mergeCanary(list) {
  const keys = ['chaseS', 'tileChaseS', 'chases', 'tileChases', 'tileVaults', 'laps', 'tileChaseLenS', 'otherChaseLenS', 'tileDowns', 'otherDowns'];
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  out.matches = list.length; out.matchesPresent = 0;
  for (const r of list) { if (r.present) out.matchesPresent++; for (const k of keys) out[k] += r[k]; }
  return finish(out);
}
