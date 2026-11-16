// Parameter spaces: { name: [min, max, default] }. Params are plain objects { name: value }.

export function defaults(space) {
  const p = {};
  for (const [k, [, , d]] of Object.entries(space)) p[k] = d;
  return p;
}

export function clampParams(space, p) {
  const out = {};
  for (const [k, [lo, hi, d]] of Object.entries(space)) {
    const v = p[k] ?? d;
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

// Mulberry32: tiny seeded RNG for the climber itself.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// Mutate a random subset of params by gaussian noise scaled to each param's range.
export function mutate(space, p, r, sigma = 0.15, pMutate = 0.35) {
  const keys = Object.keys(space);
  const out = { ...p };
  let changed = 0;
  for (const k of keys) {
    if (r() < pMutate) {
      const [lo, hi] = space[k];
      out[k] = p[k] + gauss(r) * sigma * (hi - lo);
      changed++;
    }
  }
  if (!changed) {
    const k = keys[Math.floor(r() * keys.length)];
    const [lo, hi] = space[k];
    out[k] = p[k] + gauss(r) * sigma * (hi - lo);
  }
  return clampParams(space, out);
}

export function round(p, digits = 3) {
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = +v.toFixed(digits);
  return out;
}
