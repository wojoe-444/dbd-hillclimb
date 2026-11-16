#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Shared with the renderer; importing this module does not run the CLI.
export function analyzeMap(map) {
  const errors = [];
  const fail = message => errors.push(message);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const integer = n => Number.isSafeInteger(n);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(map)) return { errors: ['Map must be an object.'] };
  if (typeof map.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(map.id)) fail('id must be a lowercase slug.');
  if (typeof map.name !== 'string' || !map.name.trim()) fail('name must be a nonempty string.');
  if (!object(map.size) || !integer(map.size.w) || !integer(map.size.h) || map.size.w <= 0 || map.size.h <= 0) fail('size.w and size.h must be positive integers.');
  if (!finite(map.eyeHeight) || map.eyeHeight <= 0) fail('eyeHeight must be positive.');
  for (const key of ['outline', 'obstacles', 'windows', 'pallets', 'generators', 'hooks', 'exitGates', 'labels']) {
    if (!Array.isArray(map[key])) fail(`${key} must be an array.`);
  }
  if (!object(map.spawns) || !Array.isArray(map.spawns.hunter) || !Array.isArray(map.spawns.survivors)) fail('spawns must contain hunter and survivors arrays.');
  if (errors.length) return { errors };
  if (map.generators.length < 10 || map.generators.length > 12) fail('generators must contain 10-12 candidates.');
  const { w, h } = map.size;
  // Avoid allocating unbounded grids for malformed inputs.
  if (w * h > 10_000_000) return { errors: ['Map exceeds the validator limit of 10,000,000 grid cells.'] };
  const outline = map.outline;
  if (outline.length < 4 || outline.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(integer))) return { errors: ['outline needs at least four integer [x,z] vertices.'] };
  let twiceArea = 0;
  const segments = outline.map((p, i) => [p, outline[(i + 1) % outline.length]]);
  for (const [[x, z], [xx, zz]] of segments) {
    if ((x === xx) === (z === zz)) fail('outline edges must be nonzero and axis-aligned.');
    if (x < 0 || x > w || z < 0 || z > h) fail(`outline vertex (${x},${z}) exceeds the bounding box.`);
    twiceArea += x * zz - xx * z;
  }
  if (twiceArea <= 0) fail('outline must run clockwise in x-right/z-down coordinates.');
  if (Math.min(...outline.map(p => p[0])) !== 0 || Math.max(...outline.map(p => p[0])) !== w || Math.min(...outline.map(p => p[1])) !== 0 || Math.max(...outline.map(p => p[1])) !== h) fail('size must match the outline bounding box.');
  const intersects = (a, b) => {
    const [p, q] = a, [r, s] = b;
    return Math.max(Math.min(p[0], q[0]), Math.min(r[0], s[0])) <= Math.min(Math.max(p[0], q[0]), Math.max(r[0], s[0])) &&
      Math.max(Math.min(p[1], q[1]), Math.min(r[1], s[1])) <= Math.min(Math.max(p[1], q[1]), Math.max(r[1], s[1]));
  };
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i], c = segments[(i + 1) % segments.length][1];
    if ((a[0] === b[0] && b[0] === c[0] && (b[1] - a[1]) * (c[1] - b[1]) < 0) || (a[1] === b[1] && b[1] === c[1] && (b[0] - a[0]) * (c[0] - b[0]) < 0)) fail('outline doubles back along an edge.');
    for (let j = i + 1; j < segments.length; j++) {
      if (j === i + 1 || (i === 0 && j === segments.length - 1)) continue;
      if (intersects(segments[i], segments[j])) fail(`outline edges ${i} and ${j} intersect.`);
    }
  }
  if (errors.length) return { errors };
  const insidePoint = (x, z) => {
    let inside = false;
    for (const [[a, b], [c, d]] of segments) {
      if ((b > z) !== (d > z) && x < (c - a) * (z - b) / (d - b) + a) inside = !inside;
    }
    return inside;
  };
  const index = (x, z) => z * w + x;
  const inside = new Uint8Array(w * h);
  const solid = new Uint8Array(w * h);
  const sight = new Uint8Array(w * h);
  const occupied = new Map();
  let playableCells = 0;
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = index(x, z);
    inside[i] = Number(insidePoint(x + 0.5, z + 0.5));
    if (inside[i]) playableCells++;
    else solid[i] = sight[i] = 1;
  }
  const inCell = (x, z) => x >= 0 && x < w && z >= 0 && z < h && !!inside[index(x, z)];
  const walkable = (x, z) => inCell(x, z) && !solid[index(x, z)];
  const isSolid = (x, z) => !inCell(x, z) || !!solid[index(x, z)];
  const ids = new Set();
  const idCheck = (v, type) => {
    if (!object(v)) { fail(`${type} entries must be objects.`); return false; }
    if (typeof v.id !== 'string' || !v.id.trim()) fail(`${type} needs an id.`);
    else if (ids.has(v.id)) fail(`Duplicate id: ${v.id}.`);
    else ids.add(v.id);
    return true;
  };
  const addRect = (v, type, rw, rd, blocks, blocksSight) => {
    if (!integer(v.x) || !integer(v.z) || !integer(rw) || !integer(rd) || rw <= 0 || rd <= 0) { fail(`${v.id}: ${type} rectangle requires integer coordinates and positive integer dimensions.`); return; }
    if (v.x < 0 || v.z < 0 || v.x + rw > w || v.z + rd > h) { fail(`${v.id}: rectangle exceeds the bounding box.`); return; }
    for (let z = v.z; z < v.z + rd; z++) for (let x = v.x; x < v.x + rw; x++) {
      const i = index(x, z);
      if (!inCell(x, z)) fail(`${v.id}: cell (${x},${z}) is outside the outline.`);
      if (occupied.has(i)) fail(`${v.id}: overlaps ${occupied.get(i)} at (${x},${z}).`);
      else occupied.set(i, v.id);
      if (blocks) solid[i] = 1;
      if (blocksSight) sight[i] = 1;
    }
  };
  const pointCell = (p, name) => {
    if (!object(p) || !finite(p.x) || !finite(p.z)) { fail(`${name}: requires finite x,z coordinates.`); return null; }
    const x = Math.floor(p.x), z = Math.floor(p.z);
    if (!inCell(x, z)) { fail(`${name}: point is outside the outline.`); return null; }
    return { x, z, i: index(x, z) };
  };
  for (const o of map.obstacles) if (idCheck(o, 'obstacle')) {
    if (!finite(o.height) || o.height <= 0) fail(`${o.id}: height must be positive.`);
    if (typeof o.kind !== 'string' || !o.kind.trim()) fail(`${o.id}: kind must be a nonempty string.`);
    addRect(o, 'obstacle', o.w, o.d, true, o.height >= map.eyeHeight);
  }
  for (const g of map.generators) if (idCheck(g, 'generator')) {
    const c = pointCell(g, g.id);
    if (c) addRect({ ...g, x: c.x, z: c.z }, 'generator', 1, 1, true, false);
  }
  for (const v of map.windows) if (idCheck(v, 'window')) {
    if (!['x', 'z'].includes(v.axis)) fail(`${v.id}: window axis must be x or z.`);
    addRect(v, 'window', 1, 1, false, false);
  }
  for (const p of map.pallets) if (idCheck(p, 'pallet')) {
    if (!['x', 'z'].includes(p.axis) || ![1, 2].includes(p.length)) { fail(`${p.id}: pallet requires axis x/z and length 1 or 2.`); continue; }
    addRect(p, 'pallet', p.axis === 'z' ? p.length : 1, p.axis === 'x' ? p.length : 1, false, false);
  }
  const targets = [];
  const addPoint = (p, name) => {
    const c = pointCell(p, name);
    if (c) {
      if (solid[c.i]) fail(`${name}: overlaps solid cell (${c.x},${c.z}).`);
      if (occupied.has(c.i)) fail(`${name}: overlaps ${occupied.get(c.i)} at (${c.x},${c.z}).`);
      targets.push({ ...c, name });
    }
    return c;
  };
  const hookCells = [];
  for (const hook of map.hooks) if (idCheck(hook, 'hook')) { const c = addPoint(hook, hook.id); if (c) hookCells.push(c); }
  for (const gate of map.exitGates) if (idCheck(gate, 'exit gate')) {
    addPoint(gate.lever, `${gate.id} lever`);
    const exit = addPoint(gate.exit, `${gate.id} exit`);
    // The exit cell adjoins the outline. Levers can be inset, as in the format
    // example; the spec does not assign a numeric maximum inset to them.
    if (exit && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !inCell(exit.x + dx, exit.z + dz))) fail(`${gate.id}: exit cell must adjoin an outline edge.`);
  }
  if (!map.spawns.hunter.length || !map.spawns.survivors.length) fail('At least one hunter and one survivor spawn are required.');
  for (const team of ['hunter', 'survivors']) map.spawns[team].forEach((p, i) => addPoint(p, `${team} spawn ${i + 1}`));
  for (const [i, label] of map.labels.entries()) {
    if (!object(label) || typeof label.text !== 'string' || !label.text.trim()) fail(`label ${i + 1}: needs text.`);
    else pointCell(label, `label ${label.text}`);
  }
  // A window's supporting cells are perpendicular to traversal; pallets may
  // span two cells across that direction, so check every approach lane.
  for (const [v, length] of [...map.windows.map(v => [v, 1]), ...map.pallets.map(v => [v, v?.length])]) {
    if (!object(v) || !integer(v.x) || !integer(v.z) || !['x', 'z'].includes(v.axis)) continue;
    if (![1, 2].includes(length)) continue;
    const [dx, dz] = v.axis === 'x' ? [1, 0] : [0, 1];
    const [px, pz] = [dz, dx];
    if (!isSolid(v.x - px, v.z - pz) || !isSolid(v.x + px * length, v.z + pz * length)) fail(`${v.id}: both gap ends perpendicular to axis must be solid.`);
    for (let n = 0; n < length; n++) for (const sign of [-1, 1]) {
      if (!walkable(v.x + px * n + dx * sign, v.z + pz * n + dz * sign)) fail(`${v.id}: approach ${sign < 0 ? '-' : '+'}${v.axis} lane ${n + 1} must be walkable.`);
    }
  }
  const neighbors = i => {
    const x = i % w, z = Math.floor(i / w), result = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (walkable(x + dx, z + dz)) result.push(index(x + dx, z + dz));
    return result;
  };
  const bfs = starts => {
    const distance = new Int32Array(w * h).fill(-1), queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    for (const i of starts) if (inside[i] && !solid[i] && distance[i] < 0) { queue[tail++] = i; distance[i] = 0; }
    while (head < tail) {
      const i = queue[head++];
      for (const next of neighbors(i)) if (distance[next] < 0) { distance[next] = distance[i] + 1; queue[tail++] = next; }
    }
    return { distance, reached: tail };
  };
  const firstHunter = map.spawns.hunter[0];
  const hunterCell = firstHunter && finite(firstHunter.x) && finite(firstHunter.z) && inCell(Math.floor(firstHunter.x), Math.floor(firstHunter.z)) ? index(Math.floor(firstHunter.x), Math.floor(firstHunter.z)) : -1;
  const connected = bfs(hunterCell >= 0 ? [hunterCell] : []);
  let walkableCells = 0, tallCells = 0, lowCells = 0;
  for (let i = 0; i < w * h; i++) if (inside[i]) {
    if (!solid[i]) walkableCells++;
    else if (sight[i]) tallCells++;
    else lowCells++;
  }
  if (connected.reached !== walkableCells) fail(`${walkableCells - connected.reached} walkable cells are unreachable from the first hunter spawn.`);
  for (const t of targets) if (connected.distance[t.i] < 0) fail(`${t.name}: unreachable from hunter spawn.`);
  for (const g of map.generators) if (object(g) && finite(g.x) && finite(g.z) && inCell(Math.floor(g.x), Math.floor(g.z))) {
    const adjacent = neighbors(index(Math.floor(g.x), Math.floor(g.z)));
    if (!adjacent.length) fail(`${g.id}: no walkable repair neighbour.`);
    else if (adjacent.some(i => connected.distance[i] < 0)) fail(`${g.id}: repair neighbours must be reachable.`);
  }
  // Spawn placement rules (perimeter spawns). Enforced as errors when the map declares `spawnRules`
  // (generated variants do); otherwise reported as warnings so older hand-made maps still validate.
  // Every spawn point must be walkable and inset spawnRules.inset (default 4-8 m) from the outline;
  // survivor points are group anchors and need mostly-walkable space within 15 m.
  const warnings = [];
  {
    const rules = object(map.spawnRules) ? map.spawnRules : null;
    const report = rules ? fail : m => warnings.push(m);
    const [lo, hi] = Array.isArray(rules?.inset) ? rules.inset : [4, 8];
    const inset = (px, pz) => {
      let best = Infinity;
      for (const [[ax, az], [bx, bz]] of segments) {
        const qx = Math.max(Math.min(ax, bx), Math.min(px, Math.max(ax, bx))), qz = Math.max(Math.min(az, bz), Math.min(pz, Math.max(az, bz)));
        best = Math.min(best, Math.hypot(px - qx, pz - qz));
      }
      return best;
    };
    for (const team of ['hunter', 'survivors']) map.spawns[team].forEach((p, i) => {
      if (!object(p) || !finite(p.x) || !finite(p.z)) return;
      const d = inset(p.x, p.z);
      if (d < lo || d > hi) report(`${team} spawn ${i + 1} (${p.x},${p.z}): inset ${d.toFixed(1)} m from the outline, expected ${lo}-${hi} m.`);
      const x = Math.floor(p.x), z = Math.floor(p.z);
      if (!walkable(x, z)) report(`${team} spawn ${i + 1}: not on a walkable cell.`);
      if (team === 'survivors') {
        let ins = 0, open = 0;
        for (let dz = -15; dz <= 15; dz++) for (let dx = -15; dx <= 15; dx++) {
          if (dx * dx + dz * dz > 225 || !inCell(x + dx, z + dz)) continue;
          ins++; if (walkable(x + dx, z + dz)) open++;
        }
        if (ins && open / ins < 0.7) report(`survivors spawn ${i + 1}: only ${Math.round(100 * open / ins)}% walkable within 15 m (need 70%).`);
      }
    });
  }
  const hooks = bfs(hookCells.map(c => c.i));
  let maxHookDistance = 0, farthestHookCell = null;
  for (let i = 0; i < w * h; i++) if (inside[i] && !solid[i]) {
    if (hooks.distance[i] < 0) { maxHookDistance = Infinity; farthestHookCell = [i % w, Math.floor(i / w)]; break; }
    if (hooks.distance[i] > maxHookDistance) { maxHookDistance = hooks.distance[i]; farthestHookCell = [i % w, Math.floor(i / w)]; }
  }
  return { errors, warnings, playableCells, walkableCells, tallCells, lowCells, outsideCells: w * h - playableCells, reachableCells: connected.reached, maxHookDistance, farthestHookCell, inside, solid, sight, hookDistances: hooks.distance };
}

export function summary(map, result) {
  return [
    `VALID ${map.id}: ${map.size.w} x ${map.size.h} m; ${result.playableCells} playable cells (${result.playableCells / 64} tiles).`,
    `Cells: ${result.walkableCells} walkable, ${result.tallCells} tall solid, ${result.lowCells} low solid (including generators), ${result.outsideCells} outside; ${result.reachableCells}/${result.walkableCells} reachable.`,
    `Features: ${map.obstacles.length} obstacles, ${map.windows.length} windows, ${map.pallets.length} pallets, ${map.generators.length} generators, ${map.hooks.length} hooks, ${map.exitGates.length} gates; spawns ${map.spawns.hunter.length} hunter / ${map.spawns.survivors.length} survivor; ${map.labels.length} labels.`,
    `Maximum nearest-hook walking distance: ${result.maxHookDistance} m (4-neighbour grid; windows/pallets walkable), at cell (${result.farthestHookCell?.join(',') ?? 'none'}).`
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/validate-map.js <map.json>'); process.exitCode = 1; }
  else try {
    const map = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    const result = analyzeMap(map);
    if (result.errors.length) { console.error(`INVALID ${map?.id ?? 'map'}:\n${result.errors.map(e => `- ${e}`).join('\n')}`); process.exitCode = 1; }
    else {
      console.log(summary(map, result));
      if (result.warnings?.length) console.log(`Warnings (spawn rules not declared, so not enforced):\n${result.warnings.map(w => `- ${w}`).join('\n')}`);
    }
  } catch (error) { console.error(`Cannot validate map: ${error.message}`); process.exitCode = 1; }
}
