// Research prototype (docs/research/emergent-behaviour.md): the param survivor with CONTEXT-CONDITIONED knobs.
//
// Each tick, a handful of the param brain's strategic knobs (the gates of its priority cascade: when to flee, hide,
// rescue, heal, explore, drop pallets, ...) is recomputed from a shared feature vector built only from what this
// survivor's obs already shows (solo-queue legal):
//
//     knob_k(t) = clamp(base_k + range_k * sum_j w[k][j] * f_j(t))
//
// base_k are the param brain's own knobs (all evolvable as before), w[k][j] in [-1, 1] are new evolvable weights named
// `ctx_<knob>_<feature>`, default 0. With every weight at 0 this brain plays exactly like 'param', so evolution starts
// from the hand-written behaviour and only adds context dependence where it pays (e.g. "rescue more once the gens are
// nearly done", "hide more when two teammates are already hooked") without anyone writing those branches.
//
// survivor.js is untouched: the param brain closes over P and reads its knobs live each decision, so this wrapper hands
// it a per-survivor P object and rewrites the modulated fields before every decide(). Knobs that survivor.js reads only
// at construction (hbSpread, hideThreat / genThreatW's belief gating) are deliberately not modulated.
import { survivorSpace, makeSurvivor } from './survivor.js';

// the context features, each roughly in [0, 1]
export const CTX_FEATURES = {
  gens: 'generators done / needed',
  time: 'match time / 600 s',
  injured: 'I am injured',
  stages: 'my hook stages consumed / 2',
  hooked: 'teammates on a hook / 3 (HUD)',
  down: 'teammates downed / 3 (HUD)',
  gone: 'teammates dead or escaped / 3 (HUD)',
  mateChased: 'a teammate is being chased (HUD)',
  near: 'hunter seen: 1 at 0 m .. 0 at 40 m; decays over 10 s after it leaves sight',
  terror: 'terror radius heard: 1 = inner layer, 1/3 = outer, 0 = none',
};
// the modulated knobs (all read per decision by survivor.js / rescue.js / healplan.js)
export const CTX_KNOBS = ['fleeSeenDist', 'fleeTR', 'hideDist', 'altruism', 'healDist', 'seekHeal', 'trustChase',
  'exploresMap', 'spreadW', 'genProgW', 'palletGreed', 'chaseToMatesW', 'rescueThreshold'];

const FEATS = Object.keys(CTX_FEATURES);
const wName = (k, f) => `ctx_${k}_${f}`;

export const survivorCtxSpace = { ...survivorSpace };
for (const k of CTX_KNOBS) for (const f of FEATS) survivorCtxSpace[wName(k, f)] = [-1, 1, 0];

export function makeSurvivorCtx(params) {
  const knobs = CTX_KNOBS.filter((k) => survivorSpace[k]);
  const W = knobs.map((k) => FEATS.map((f) => params[wName(k, f)] ?? 0));
  const active = knobs.map((_, i) => W[i].some((w) => w !== 0));
  return (ctx) => {
    const P = { ...params };                    // per survivor: the wrapped brain reads this object live
    const inner = makeSurvivor(P)(ctx);
    const f = new Float64Array(FEATS.length);
    let nearV = 0, nearT = -99;
    function features(obs) {
      const me = obs.self, hud = obs.hud || [];
      let hooked = 0, down = 0, gone = 0, mateChased = 0;
      for (const x of hud) {
        if (!x || x.id === me.id) continue;
        if (x.state === 'hooked') hooked++;
        else if (x.state === 'downed' || x.state === 'carried') down++;
        else if (x.state === 'dead' || x.state === 'escaped') gone++;
        if (x.chased) mateChased = 1;
      }
      if (obs.hunter) { nearV = Math.max(0, 1 - Math.hypot(obs.hunter.x - me.x, obs.hunter.z - me.z) / 40); nearT = obs.t; }
      f[0] = Math.min(1, (obs.gensDone ?? 0) / (obs.gensNeeded || 5));
      f[1] = Math.min(1, obs.t / 600);
      f[2] = me.state === 'injured' ? 1 : 0;
      f[3] = Math.min(1, (hud[me.id]?.hookStages ?? 0) / 2);
      f[4] = hooked / 3; f[5] = down / 3; f[6] = gone / 3; f[7] = mateChased;
      f[8] = obs.hunter ? nearV : nearV * Math.max(0, 1 - (obs.t - nearT) / 10);
      f[9] = obs.terror ? (4 - obs.terror.layer) / 3 : 0;
    }
    const brain = Object.create(inner);
    brain.decide = function (obs, api) {
      features(obs);
      for (let i = 0; i < knobs.length; i++) {
        if (!active[i]) continue;
        const k = knobs[i], [lo, hi] = survivorSpace[k], w = W[i];
        let s = 0;
        for (let j = 0; j < w.length; j++) s += w[j] * f[j];
        P[k] = Math.min(hi, Math.max(lo, params[k] + (hi - lo) * s));
      }
      return inner.decide(obs, api);
    };
    brain.ctxFeatures = f;
    return brain;
  };
}
