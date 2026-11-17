// Authored candidate selection only; no navigation, agents, or match state. Distances are metres.
// Values are simulation approximations, not a claim about BHVR's unpublished matching function.
// Mapgen uses the same feasibility check as the engine so generated maps never need a weaker fallback.
const cache = new WeakMap();

export function generatorSets(candidates, count, rules) {
  const n = candidates.length, k = Math.max(0, Math.min(n, count));
  const distances = candidates.map(a => candidates.map(b => Math.hypot(a.x - b.x, a.z - b.z)));
  const sets = [], selected = [];
  function visit(start) {
    if (selected.length === k) {
      if (distances.some(row => Math.min(...selected.map(i => row[i])) > (rules.maxCoverageM ?? Infinity))) return;
      sets.push(selected.slice()); return;
    }
    for (let i = start; i <= n - (k - selected.length); i++) {
      if (selected.some(j => distances[i][j] < (rules.minSpacingM ?? 0))) continue;
      let tight = false;
      for (let a = 0; a < selected.length; a++) for (let b = a + 1; b < selected.length; b++) {
        const j = selected[a], l = selected[b];
        if (distances[i][j] + distances[i][l] + distances[j][l] < (rules.minThreeGenTourM ?? 0)) tight = true;
      }
      if (tight) continue;
      selected.push(i); visit(i + 1); selected.pop();
    }
  }
  visit(0);
  return sets;
}

export function selectGenerators(md, count, rng, placementRng = rng) {
  const order = md.genCands.map((_, i) => i);
  // Keep the old world-stream consumption and legacy-map behavior; placement uses its own stream.
  rng.shuffle(order);
  const rules = md.map.generatorRules;
  if (!rules) return order.slice(0, Math.min(count, order.length)).sort((a, b) => a - b);
  let byCount = cache.get(md);
  if (!byCount) { byCount = new Map(); cache.set(md, byCount); }
  const key = JSON.stringify([count, rules]);
  let sets = byCount.get(key);
  if (!sets) { sets = generatorSets(md.genCands, count, rules); byCount.set(key, sets); }
  if (!sets.length) throw new Error(`No feasible ${count}-generator distribution for ${md.map.id}`);
  // Uniform among feasible subsets, without repeatedly accepting only one greedy order.
  return sets[placementRng.int(sets.length)].slice();
}
