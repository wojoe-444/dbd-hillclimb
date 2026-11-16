// Small seeded PRNG (mulberry32) with a string/number seed hash. Deterministic across Node and browsers.

export function hashSeed(str) {
  // murmur3-style 32-bit hash of a string
  let h = 0x811c9dc5 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed, stream = '') {
  let s = hashSeed(String(seed) + '|' + stream) || 0x9e3779b9;
  const rng = {
    /** float in [0,1) */
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** int in [0,n) */
    int(n) { return (rng.next() * n) | 0; },
    /** float in [a,b) */
    range(a, b) { return a + (b - a) * rng.next(); },
    chance(p) { return rng.next() < p; },
    pick(arr) { return arr[(rng.next() * arr.length) | 0]; },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = (rng.next() * (i + 1)) | 0;
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
    /** standard normal (Box-Muller) */
    normal() {
      const u = 1 - rng.next(), v = rng.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}
