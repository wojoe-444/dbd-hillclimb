// Small seeded RNG (mulberry32) + helpers. Zero deps, Node + browser.

export function hashSeed(...parts) {
  // FNV-1a over the string form of the parts, then a final avalanche.
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: n => Math.floor(next() * n),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
    },
    // entries: [[value, weight], ...]
    weighted(entries) {
      const total = entries.reduce((s, e) => s + Math.max(0, e[1]), 0);
      if (total <= 0) return entries.length ? entries[0][0] : undefined;
      let r = next() * total;
      for (const [v, wt] of entries) { r -= Math.max(0, wt); if (r < 0) return v; }
      return entries[entries.length - 1][0];
    },
  };
  return rng;
}
