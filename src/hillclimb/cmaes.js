// sep-CMA-ES (Ros & Hansen 2008: CMA-ES with a diagonal covariance, linear time/space, learns faster than full CMA in
// 40-100 dimensions) over a knob space normalised to [0, 1] per knob. Used by evolve.js --opt cmaes, one instance per
// side. Bounds: a sample is reflected into [0, 1] (mirror at the bounds) and the update uses the repaired point, so
// the mean and the steps never leave the feasible box. Optional mirrored (antithetic) sampling: samples come in pairs
// m + s and m - s, which cancels the first-order noise of a pair's fitness difference.
//
// State is a plain JSON object (resume-safe). All randomness comes from the R passed in (deterministic per seed).
import { clampParams } from './params.js';

function gauss(R) {
  const u = Math.max(1e-12, R());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R());
}
const reflect01 = (v) => {
  // mirror into [0, 1] (period 2), robust to values far outside
  let x = ((v % 2) + 2) % 2;
  return x > 1 ? 2 - x : x;
};

export function toNorm(space, p) { return Object.entries(space).map(([k, [lo, hi]]) => (hi > lo ? (p[k] - lo) / (hi - lo) : 0)); }
export function fromNorm(space, x) {
  const out = {};
  Object.entries(space).forEach(([k, [lo, hi]], i) => { out[k] = lo + Math.min(1, Math.max(0, x[i])) * (hi - lo); });
  return clampParams(space, out);
}

// A fixed brain fills the same evaluation slots with one parameter set and has no distribution to adapt.
function fixedState(lambda, gen) {
  return { kind: 'sep-cmaes', n: 0, lambda, mu: Math.floor(lambda / 2), gen, mean: [], sigma: 0, C: [] };
}

// opts: { lambda, sigma0, mirror, minSigma, maxSigma }
export function cmaInit(space, startParams, { lambda, sigma0 = 0.15, mirror = false, minSigma = 0.01, maxSigma = 0.5 } = {}) {
  const n = Object.keys(space).length;
  const lam = Math.max(4, lambda ?? 4 + Math.floor(3 * Math.log(Math.max(1, n))));
  if (n === 0) return fixedState(lam, 0);
  const mu = Math.floor(lam / 2);
  const raw = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const sw = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => x / sw);
  const mueff = 1 / w.reduce((a, x) => a + x * x, 0);
  const cs = (mueff + 2) / (n + mueff + 5);
  const ds = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n);
  const sep = (n + 2) / 3;                                              // sep-CMA learning-rate boost
  const c1 = Math.min(1, sep * 2 / ((n + 1.3) ** 2 + mueff));
  const cmu = Math.min(1 - c1, sep * 2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff));
  return {
    kind: 'sep-cmaes', n, lambda: lam, mu, w, mueff, cs, ds, cc, c1, cmu, mirror: !!mirror, minSigma, maxSigma,
    chiN: Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n)),
    gen: 0, mean: toNorm(space, startParams).map(reflect01), sigma: sigma0,
    C: new Array(n).fill(1), ps: new Array(n).fill(0), pc: new Array(n).fill(0),
  };
}

// Draw lambda candidates: [{ x (normalised, feasible), params }]
export function cmaAsk(space, st, R) {
  const out = [];
  const D = st.C.map(Math.sqrt);
  for (let k = 0; k < st.lambda; k++) {
    let z;
    if (st.mirror && k % 2 === 1) z = out[k - 1].z.map((v) => -v);
    else z = Array.from({ length: st.n }, () => gauss(R));
    const x = st.mean.map((m, i) => reflect01(m + st.sigma * D[i] * z[i]));
    out.push({ z, x, params: fromNorm(space, x) });
  }
  return out.map(({ x, params }) => ({ x, params }));
}

// Update from the candidates ranked best-first (array of normalised x). Returns the new state (pure).
export function cmaTell(st, rankedX) {
  if (st.n === 0) return fixedState(st.lambda, st.gen + 1);
  const { n, mu, w, mueff, cs, ds, cc, c1, cmu, chiN } = st;
  const old = st.mean, sigma = st.sigma;
  const D = st.C.map(Math.sqrt);
  const ys = rankedX.slice(0, mu).map((x) => x.map((v, i) => (v - old[i]) / sigma));   // repaired steps
  const yw = new Array(n).fill(0);
  ys.forEach((y, k) => { for (let i = 0; i < n; i++) yw[i] += w[k] * y[i]; });
  const mean = old.map((m, i) => Math.min(1, Math.max(0, m + sigma * yw[i])));
  const a = Math.sqrt(cs * (2 - cs) * mueff);
  const ps = st.ps.map((p, i) => (1 - cs) * p + a * yw[i] / D[i]);
  const psn = Math.sqrt(ps.reduce((s, v) => s + v * v, 0));
  const hs = psn / Math.sqrt(1 - (1 - cs) ** (2 * (st.gen + 1))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
  const b = hs * Math.sqrt(cc * (2 - cc) * mueff);
  const pc = st.pc.map((p, i) => (1 - cc) * p + b * yw[i]);
  const C = st.C.map((c, i) => {
    let rmu = 0;
    ys.forEach((y, k) => { rmu += w[k] * y[i] * y[i]; });
    const v = (1 - c1 - cmu) * c + c1 * (pc[i] * pc[i] + (1 - hs) * cc * (2 - cc) * c) + cmu * rmu;
    return Math.min(1e4, Math.max(1e-8, v));
  });
  let sig = sigma * Math.exp((cs / ds) * (psn / chiN - 1));
  sig = Math.min(st.maxSigma, Math.max(st.minSigma, sig));
  return { ...st, gen: st.gen + 1, mean, sigma: sig, C, ps, pc };
}

// Log-friendly summary: mean in knob units, per-knob sampling sd in knob units, step size, axis ratio.
export function cmaSummary(space, st, digits = 4) {
  // No step size or axis spread for a point distribution, including checkpoints with old null values.
  if (st.n === 0) return { kind: st.kind, gen: st.gen, sigma: 0, axisRatio: 1, mean: {}, meanNorm: [], sd: {} };
  const keys = Object.keys(space);
  const meanP = fromNorm(space, st.mean);
  const sd = {};
  keys.forEach((k, i) => { const [lo, hi] = space[k]; sd[k] = +(st.sigma * Math.sqrt(st.C[i]) * (hi - lo)).toFixed(digits); });
  const dmax = Math.sqrt(Math.max(...st.C)), dmin = Math.sqrt(Math.min(...st.C));
  return {
    kind: st.kind, gen: st.gen, sigma: +st.sigma.toFixed(5), axisRatio: +(dmax / dmin).toFixed(3),
    mean: Object.fromEntries(keys.map((k) => [k, +meanP[k].toFixed(digits)])),
    meanNorm: st.mean.map((v) => +v.toFixed(4)), sd,
  };
}
