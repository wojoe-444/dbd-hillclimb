// Noise-robust selection for evolve.js: fixed opponent panels + hall of fame, common-random-number "slots",
// racing (successive evaluation of contenders near the selection cut) and per-generation reliability estimates.
// Pure functions: no matches are played here (evolve.js builds jobs from the plans and feeds results back).
//
// Vocabulary
//   panel   the opponents a side is evaluated against this generation: a list of { name, params }.
//   slot    one (opponent, seed) pair. Every individual of a side plays the same slots in the same order, so two
//           individuals' fitness difference never contains opponent or seed luck (common random numbers).
//   race    slots are played in stages; after each stage the individuals whose paired difference to the selection
//           cut is significant are decided (in / out) and stop; the rest (the contenders) play the next stage.
import { defaults, clampParams } from './params.js';

// ---------- panel composition ----------
// spec: comma list of <kind>:<n>, kinds: cur (top n of the opposite side's last ranking; gen 1: its first n),
// hof (n hall-of-fame entries spread over the archive), default (the hand-tuned defaults), mean (the opposite
// side's population/distribution mean). e.g. "cur:4,hof:3,default:1". Fixed external opponents come separately.
export function parsePanelSpec(spec) {
  if (spec === true || spec === undefined || spec === null || spec === '') spec = 'cur:4,hof:3,default:1';
  const out = [];
  for (const part of String(spec).split(',').filter(Boolean)) {
    const [kind, n] = part.split(':');
    if (!['cur', 'hof', 'default', 'mean'].includes(kind)) throw new Error(`--panel: unknown kind "${kind}" (cur|hof|default|mean)`);
    out.push({ kind, n: n === undefined ? 1 : Math.max(0, Math.floor(+n)) });
  }
  return out;
}

// evenly spread pick of n items from a list (always includes the newest; the oldest when n >= 2)
export function spreadPick(list, n) {
  if (n <= 0 || !list.length) return [];
  if (n >= list.length) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round(n === 1 ? list.length - 1 : (i * (list.length - 1)) / (n - 1))]);
  return out;
}

export function meanParams(space, list) {
  const out = {};
  for (const k of Object.keys(space)) out[k] = list.reduce((a, p) => a + p[k], 0) / list.length;
  return clampParams(space, out);
}

// Build one side's panel. opp: { space, ranked (last generation's ranking of the opposite side, may be null),
// pop (its current population), mean (optional distribution mean), hof (its hall of fame), fixed ([{name,params}]) }
// Duplicate parameter sets are dropped (e.g. gen 1: pop[0] = defaults = the default member).
export function buildPanel(spec, opp) {
  const out = [];
  const seen = new Set();
  const add = (name, params) => {
    const key = JSON.stringify(params);
    if (seen.has(key)) return;
    seen.add(key); out.push({ name, params });
  };
  for (const { kind, n } of spec) {
    if (kind === 'default') { if (n > 0) add('default', defaults(opp.space)); }
    else if (kind === 'mean') { if (n > 0) add('mean', opp.mean ?? meanParams(opp.space, opp.pop.map((x) => x.params))); }
    else if (kind === 'cur') {
      const src = opp.ranked ?? opp.pop;
      for (const x of src.slice(0, n)) add(`cur:${x.id}`, x.params);
    } else if (kind === 'hof') for (const h of spreadPick(opp.hof ?? [], n)) add(`hof:g${h.gen}:${h.id}`, h.params);
  }
  for (const f of opp.fixed ?? []) add(`fixed:${f.name}`, f.params);
  if (!out.length) add('default', defaults(opp.space));
  return out;
}

// Hall of fame: append { gen, id, params } (no duplicates of the newest entry); keep at most `size`, thinning the
// archive evenly (never dropping the newest) so it always spans the whole run.
export function hofAdd(hof, entry, size) {
  const last = hof[hof.length - 1];
  if (last && JSON.stringify(last.params) === JSON.stringify(entry.params)) return hof;
  const next = [...hof, entry];
  if (next.length <= size) return next;
  // drop the entry whose removal leaves the most even spacing: the one with the smallest gen gap to its neighbours
  let drop = 1, best = Infinity;
  for (let i = 1; i < next.length - 1; i++) { const gap = next[i + 1].gen - next[i - 1].gen; if (gap < best) { best = gap; drop = i; } }
  next.splice(drop, 1);
  return next;
}

// ---------- slots ----------
// n slots over the panel: slot k plays panel[k % P] on its own seed. Seeds come from R (fresh per generation).
export function makeSlots(panel, n, R, offset = 0) {
  const out = [];
  for (let k = 0; k < n; k++) out.push({ k: k + offset, opp: (k + offset) % panel.length, seed: Math.floor(R() * 2 ** 31) });
  return out;
}

// jobs for individuals idx[] of `side` on the given slots
export function slotJobs({ side, pop, panel, idx, slots }) {
  const jobs = [];
  for (const sl of slots) for (const i of idx) {
    const me = pop[i].params, opp = panel[sl.opp].params;
    jobs.push(side === 'hunter'
      ? { seed: sl.seed, hunterParams: me, survivorParams: opp, tag: { side, i, slot: sl.k } }
      : { seed: sl.seed, hunterParams: opp, survivorParams: me, tag: { side, i, slot: sl.k } });
  }
  return jobs;
}

// ---------- statistics ----------
export const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
export function variance(v) { if (v.length < 2) return 0; const m = mean(v); return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); }
export function pearson(a, b) {
  const n = a.length; if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
export function ranks(v) {
  const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(v.length);
  for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; }
  return r;
}
export const spearman = (a, b) => pearson(ranks(a), ranks(b));
const r3 = (x) => (x === null || !Number.isFinite(x) ? null : +x.toFixed(3));

// Reliability of a population's fitness means, from the per-match samples themselves.
//   samples[i] = per-match fitness of individual i (in play order; with slots: slot order).
//   centred:    if every individual played the same first m slots (common random numbers), subtract each slot's
//               mean over individuals first, so the shared seed/opponent luck (which cannot change a ranking) is
//               not counted as noise.
// Returns { icc, rel (of the mean each individual actually got), relAt16, need80, split (Spearman-Brown corrected
// split-half correlation of odd vs even matches), n, between/within sd }.
export function reliability(samples, { centred = false } = {}) {
  let S = samples.filter((s) => s.length >= 2);
  if (S.length < 3) return null;
  if (centred) {
    const m = Math.min(...S.map((s) => s.length));
    const slotMean = Array.from({ length: m }, (_, k) => mean(S.map((s) => s[k])));
    S = S.map((s) => s.slice(0, m).map((x, k) => x - slotMean[k]).concat(s.slice(m).map((x) => x - mean(slotMean))));
  }
  const mi = S.map(mean), ni = S.map((s) => s.length);
  const sw2 = mean(S.map(variance));                                 // within-individual (match-to-match) variance
  const hn = S.length / ni.reduce((a, n) => a + 1 / n, 0);           // harmonic mean of the sample sizes
  const sm2 = variance(mi);                                          // variance of the individuals' means
  const sb2 = Math.max(0, sm2 - sw2 / hn);                           // true between-individual variance
  const icc = sb2 + sw2 > 0 ? sb2 / (sb2 + sw2) : 0;
  const relAt = (k) => (sb2 + sw2 / k > 0 ? sb2 / (sb2 + sw2 / k) : 0);
  // split half on the matches every individual has (odd vs even positions)
  const odd = S.map((s) => mean(s.filter((_, k) => k % 2 === 1))), even = S.map((s) => mean(s.filter((_, k) => k % 2 === 0)));
  const r = pearson(odd, even);
  return {
    n: S.length, games: +hn.toFixed(1), icc: r3(icc), rel: r3(relAt(hn)), relAt16: r3(relAt(16)),
    need80: sb2 > 0 ? Math.ceil(4 * sw2 / sb2) : null,
    split: r === null ? null : r3((2 * r) / (1 + Math.abs(r))),
    sdBetween: r3(Math.sqrt(sb2)), sdWithin: r3(Math.sqrt(sw2)),
  };
}

// rank persistence between two rankings: Spearman of the fitness of the individuals present in both
export function persistence(prevRanked, ranked) {
  if (!prevRanked) return null;
  const prev = new Map(prevRanked.map((x) => [x.id, x.fit]));
  const both = ranked.filter((x) => prev.has(x.id));
  if (both.length < 3) return null;
  return { n: both.length, rho: r3(spearman(both.map((x) => prev.get(x.id)), both.map((x) => x.fit))) };
}

// ---------- racing ----------
// One racing decision step. F[i] = per-slot fitness of individual i (all alive individuals have played the same
// slots, in the same order). state = { inSet: [], outSet: [], alive: [indices] }, keep = how many to select overall.
// An alive individual above the provisional cut is decided "in" when its paired difference to the best alive
// individual below the cut has z >= zIn; one below the cut is decided "out" when its paired difference to the worst
// alive individual above the cut has z <= -zOut. Returns the new state (pure).
export function raceStep(F, state, keep, z = 1.5, minSlots = 4) {
  const inSet = [...state.inSet], outSet = [...state.outSet];
  let alive = [...state.alive];
  const need = keep - inSet.length;
  if (need <= 0) return { inSet, outSet: [...outSet, ...alive], alive: [] };
  if (need >= alive.length) return { inSet: [...inSet, ...alive], outSet, alive: [] };
  const m = Math.min(...alive.map((i) => F[i].length));
  if (m < minSlots) return { inSet, outSet, alive };
  const mu = (i) => mean(F[i].slice(0, m));
  const order = alive.slice().sort((a, b) => mu(b) - mu(a) || a - b);
  const lastIn = order[need - 1], firstOut = order[need];
  const zDiff = (a, b) => {
    const d = F[a].slice(0, m).map((x, k) => x - F[b][k]);
    const sd = Math.sqrt(variance(d));
    const md = mean(d);
    return sd > 0 ? md / (sd / Math.sqrt(m)) : (md > 0 ? Infinity : md < 0 ? -Infinity : 0);
  };
  const newIn = [], newOut = [];
  for (let r = 0; r < order.length; r++) {
    const i = order[r];
    if (r < need) { if (zDiff(i, firstOut) >= z) newIn.push(i); }
    else if (zDiff(i, lastIn) <= -z) newOut.push(i);
  }
  alive = order.filter((i) => !newIn.includes(i) && !newOut.includes(i));
  const st = { inSet: [...inSet, ...newIn], outSet: [...outSet, ...newOut], alive };
  // settle trivially decided remainders
  const left = keep - st.inSet.length;
  if (left <= 0) return { inSet: st.inSet, outSet: [...st.outSet, ...st.alive], alive: [] };
  if (left >= st.alive.length) return { inSet: [...st.inSet, ...st.alive], outSet: st.outSet, alive: [] };
  return st;
}
