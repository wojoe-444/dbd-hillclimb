// 'goal' survivor: a LEARNED GOAL LAYER over the param brain's hand-written motor skills
// (docs/research/emergent-behaviour.md, recommended path step 3: "utility goal selector").
//
// The param brain (survivor.js) decides with a fixed priority cascade (hooked > downed > being healed > freeze > chase >
// stealth > hide > mend > gate > sneak > rescue > patient > seek heal > heal > gens / explore). Here the cascade is gone:
// every decision each of GOALS is scored by a linear function of one shared feature vector,
//
//     score_g = sum_j w[g][j] * f_j  +  stick (if g is the current goal)  +  fatigue_g * min(1, s in g / 30)
//
// and the best FEASIBLE goal runs. Feasibility is physical only ("is there a hooked teammate", "do I know a gen"), never
// a habit. If the chosen goal's motor routine has nothing to do this tick (returns null) the next best one runs.
// Every w is an evolvable knob `g_<goal>_<feature>` (space [-6, 6, default]); the defaults are hand-set so the brain
// plays roughly like 'param', but the point is that priorities, context and switching are now weights, so they can
// emerge. A new idea becomes a FEATURE (an observable in FEATURES) or a GOAL (a primitive with a motor routine), never a
// new rule.
//
// Motor skills are the param brain's own (one param brain instance per survivor, reached through its `skills`
// accessor): loop running / crossings / vault timing / pallet drops (chase), hide-spot search (findHide /
// pickHideSpot), gen slots + gen / explore choice (workStep), gates (gateStep), rescue.js, healplan.js, belief maps,
// map knowledge, camera (withLook), body-block sidestep (unblock). The cascade's gating knobs (fleeSeenDist, altruism,
// hideThreat, ...) are dropped from this brain's space: the goal weights replace them.
//
// Solo-queue legal: features come only from this survivor's obs (HUD, own sight, notifications, own belief).
// Viewer: debug() adds { goal, since, scores, top (largest contributing features of the chosen goal), features }.
import { survivorSpace, makeSurvivor } from './survivor.js';
import { makeCoverRoute } from './coverroute.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sig = (x) => 1 / (1 + Math.exp(-1.702 * x));
const approach = (t, me, r = 1.2) => { const dx = me.x - t.x, dz = me.z - t.z, L = Math.hypot(dx, dz) || 1; return { x: t.x + (dx / L) * r, z: t.z + (dz / L) * r }; };

// ---- shared feature vector: every feature roughly in [0, 1] (hClosing in [-1, 1]) ----
export const FEATURES = {
  bias: 'constant 1',
  injured: 'I am injured',
  hookStages: 'my hook stages consumed / 2',
  deepWound: 'I have Deep Wound',
  protected: 'unhook protection left / 10 s',
  beingHealed: 'a teammate is healing me (HUD)',
  chased: 'chase music: the hunter is chasing me',
  repairing: 'I am repairing right now',
  hVisible: 'I see the hunter (1; fades over ~1 s after losing sight)',
  hNear: 'seen hunter proximity: 1 at 0 m .. 0 at 40 m (x hVisible)',
  hMem: 'hunter memory: proximity of the last sighting to me now, decaying (5 s time constant)',
  hClosing: 'seen hunter speed toward me / 4.6 m/s (-1..1)',
  hCanSee: 'the seen hunter could see me (cone + line of sight); decays over ~1 s after it stops',
  terror: 'terror radius layer heard / 3',
  terrorUp: 'the terror layer got closer within 4 s',
  threat: 'my belief: hunter within 16 m of me (soft probability)',
  hBusy: 'another teammate is chased or carried (HUD)',
  gens: 'generators done / needed',
  genAvail: 'known workable gens / 2 (capped)',
  genNear: 'nearest known workable gen: 1 at 0 m .. 0 at 60 m (path)',
  genProg: 'best progress among known workable gens (last seen)',
  kicked: 'progress of a known gen I saw regressing / losing progress in the last 120 s',
  unexplored: 'gens not found yet / all (0 once the map is explored)',
  gatesPowered: 'exit gates powered',
  gateOpen: 'an exit gate is open',
  collapse: 'endgame collapse elapsed share',
  hooked: 'teammates on a hook / 3 (HUD)',
  hookUrgency: 'hooked teammate: share of the stage gone (x2 in struggle) / 2, max',
  hookNear: 'nearest hooked teammate: 1 at 0 m .. 0 at 60 m (path)',
  hookCamp: 'P(the hunter is near that hook): sighting / Resolve rising / belief',
  claimed: 'another teammate claimed / is doing that rescue (intent / HUD)',
  iClosest: 'P(I am the closest standing teammate to that hook)',
  downedNear: 'nearest downed teammate (aura): 1 at 0 m .. 0 at 40 m',
  injuredNear: 'nearest visible injured teammate: 1 at 0 m .. 0 at 30 m',
  healthyNear: 'nearest visible healthy teammate: 1 at 0 m .. 0 at 30 m',
  healOffer: 'a visible teammate offered to heal me (accepted: 1, said "healing": 0.5)',
  matesGone: 'teammates dead or escaped / 3 (HUD)',
  matesRepairing: 'teammates repairing / 3 (HUD)',
  cover: 'cover at my spot (0..1)',
  loopNear: 'best known usable loop tile near me (distance held, fading to 0 at 15 m)',
  time: 'match time / 600 s',
  injNear: 'injured x hNear',
  seeNear: 'hCanSee x hNear',
  progTerror: 'genProg x terror',
  hookGens: 'hooked x gens',
  // ---- reflex-oriented (conditions read these; also weighted like any feature) ----
  matesHookedFrac: 'hooked teammates / teammates still in the match (HUD)',
  allOthersOut: 'no other teammate standing: every one still in the match is hooked / downed / carried (HUD)',
  lastAlive: 'every other teammate is dead or escaped (HUD)',
  hunterChasingOther: 'another teammate is being chased (HUD)',
  mateCarried: 'a teammate is being carried (HUD)',
  hunterNearHook: 'the hunter is seen / was seen < 8 s ago within 16 m of the nearest hooked teammate',
  hookTimeLeft: 'time until the most urgent hooked teammate dies / 140 s (1 = nobody hooked)',
  endgameLeft: 'endgame collapse time left / 120 s (0 = no collapse)',
  danger: 'max(hNear, hMem, terror, threat)',
};
const FEATS = Object.keys(FEATURES), NF = FEATS.length, FI = Object.fromEntries(FEATS.map((k, i) => [k, i]));

export const GOALS = ['repair', 'explore', 'kicked', 'flee', 'hide', 'watch', 'sneak', 'rescue', 'heal', 'pickup', 'getHealed', 'mend', 'gate', 'protect'];
export const GOAL_INFO = {
  repair: 'work the best known generator (gen choice + side slots: workStep)',
  explore: 'explore for unfound generators (know.pickTarget)',
  kicked: 'return to a generator I saw kicked / regressing',
  flee: 'run: loops / crossings / vaults / pallets / open-field routes (chase)',
  hide: 'break line of sight of a seen hunter (findHide), or hide from the believed one (pickHideSpot)',
  watch: 'hold still and watch the hunter / where it should be',
  sneak: 'leave quietly: away from the last sighting toward the farthest known gen',
  rescue: 'unhook a teammate (rescue.js picks which / executes)',
  heal: 'heal an injured teammate / pick up a downed one (healplan.js handshake)',
  pickup: 'go straight to the nearest downed teammate and pick it up',
  getHealed: 'injured: stand still while healed / accept a heal offer / walk to a healthy teammate',
  mend: 'mend my Deep Wound',
  gate: 'open an exit gate / leave',
  protect: 'body-block: stand between the seen hunter and the teammate nearest to it',
};

// hand-set defaults (scale: a plain "repair" is worth ~1.5-2.5); unlisted weights are 0
const DEF = {
  repair:    { bias: 1, genProg: 0.8, genNear: 0.5, repairing: 0.6, progTerror: 0.8, terror: -1, threat: -0.3, hVisible: -1.5, hNear: -1, hMem: -1.5, chased: -6 },
  explore:   { bias: 0.2, unexplored: 1.6, genNear: -0.4, repairing: -1, terror: -1, hVisible: -1.5, hNear: -1, hMem: -1.5, chased: -6 },
  kicked:    { bias: 0.3, kicked: 1.2, terror: -1, hVisible: -1.5, hNear: -1, hMem: -1.5, chased: -6 },
  flee:      { bias: -1, chased: 6, hNear: 3, hMem: 3.5, hClosing: 1, hCanSee: 1, injNear: 1 },
  hide:      { bias: -1, hVisible: 1, hCanSee: 2.5, hNear: 0.5, chased: -6 },
  watch:     { bias: -1, hVisible: 2, hCanSee: -3, hNear: 0.5, chased: -6 },
  sneak:     { bias: -3, terror: 5, hBusy: -2, hVisible: -2, chased: -6 },
  rescue:    { bias: 0.5, iClosest: 4, hookUrgency: 3, hookCamp: -2, hBusy: 1, claimed: -4, injured: -0.25, threat: -0.5, terror: -0.3, hookNear: 0.5, hNear: -2, chased: -6 },
  heal:      { bias: 2.6, downedNear: 0.3, terror: -0.5, hVisible: -1, hNear: -2, chased: -6 },
  pickup:    { bias: -1, downedNear: 1.5 },
  getHealed: { beingHealed: 6, healOffer: 4, hNear: -3, chased: -6 },
  mend:      { deepWound: 6, hVisible: -0.5, hNear: -5, chased: -6 },
  gate:      { gatesPowered: 5, gateOpen: 0.5, hNear: -2, chased: -6 },
  protect:   { bias: -3, hVisible: 0.5, injuredNear: 0.5 },
};
const FATIGUE = { sneak: -2, watch: -1 };   // x min(1, seconds in the goal / 30), current goal only
const W_RANGE = 6;

// the param cascade's gates: unused by this brain (fixed at these values; the goal weights decide instead)
const DROPPED = {
  fleeSeenDist: null, fleeTR: null, calmS: null, sneakMaxS: null, altruism: null, trustChase: null, seekHeal: null,
  hideDist: null, hideHoldS: null, mendRiskDist: null, exploresMap: null,
  hideThreat: 1,           // <= 1 keeps the hunter belief on (features use it); the unseen-hide trigger itself is unused
  hideOnLayer: null, hideOnClosing: null, hideProgSlack: null, hideStayS: null, hideMaxS: null,
  rescueThreshold: -1e9,   // rescue.js always returns its best target; the goal layer decides whether to go
};

const wName = (g, f) => `g_${g}_${f}`;
export const survivorGoalSpace = {};
for (const [k, v] of Object.entries(survivorSpace)) if (!(k in DROPPED)) survivorGoalSpace[k] = v;
survivorGoalSpace.goalStick = [0, 3, 0.75];   // hysteresis: bonus of the current goal
for (const g of GOALS) {
  for (const f of FEATS) survivorGoalSpace[wName(g, f)] = [-W_RANGE, W_RANGE, DEF[g][f] ?? 0];
  survivorGoalSpace[`g_${g}_fatigue`] = [-4, 2, FATIGUE[g] ?? 0];
}

// ---- motor modes (per goal that moves): gait, route preference, timing ----
//   stealth = m_<g>_stealth + m_<g>_stealthDanger * danger : < -0.5 run | < 0 the routine's own gait | < 0.5 walk | crouch
//   covered = m_<g>_cover + m_<g>_coverDanger * danger > 0 : covered / low-exposure steps (coverroute.js) instead of shortest
//   wait    = m_<g>_wait (0..1)                            : hold (watching) while the hunter is near the target
//             (target danger > 1 - wait), unless it is busy elsewhere (chasing / carrying another), at most 25 s per entry
// Defaults: the routine's own gait, shortest route, go now = today's behaviour.
export const MOVE_GOALS = ['repair', 'explore', 'kicked', 'hide', 'sneak', 'rescue', 'heal', 'pickup', 'getHealed', 'gate', 'protect'];
export const GAITS = ['own', 'run', 'walk', 'crouch'];
for (const g of MOVE_GOALS) {
  survivorGoalSpace[`m_${g}_stealth`] = [-1, 1, -0.25];
  survivorGoalSpace[`m_${g}_stealthDanger`] = [-2, 2, 0];
  survivorGoalSpace[`m_${g}_cover`] = [-1, 1, -0.5];
  survivorGoalSpace[`m_${g}_coverDanger`] = [-2, 2, 0];
  survivorGoalSpace[`m_${g}_wait`] = [0, 1, 0];
}

// ---- reflexes: K evolvable condition -> response slots (all off by default) ----
//   IF f[fa] (>|<) ta [AND f[fb] (>|<) tb] THEN score[goal] += bonus, and while that goal runs: gait / covered / wait
// Genes per slot k (integer genes are continuous and floored, so params.js mutation / crossover / CMA-ES need nothing new):
//   r<k>_on >0.5 enables · r<k>_fa, r<k>_fb feature index [0, NF) · r<k>_ta, r<k>_tb threshold [0,1] · r<k>_da, r<k>_db
//   direction (>= 0: '>', < 0: '<') · r<k>_and >0.5 adds the second condition · r<k>_goal goal index [0, NG) ·
//   r<k>_bonus [-8, 8] · r<k>_gait [0, 4) GAITS (0 = no override) · r<k>_cover >0.5 covered route · r<k>_wait >0.5 wait
// A firing condition stays latched for 1 s (no flicker at the threshold).
export const REFLEX_SLOTS = 10;
const RX_LATCH_S = 1;
const idx = (v, n) => Math.max(0, Math.min(n - 1, Math.floor(v ?? 0)));
for (let k = 0; k < REFLEX_SLOTS; k++) {
  Object.assign(survivorGoalSpace, {
    [`r${k}_on`]: [0, 1, 0], [`r${k}_fa`]: [0, NF, 0], [`r${k}_ta`]: [0, 1, 0.5], [`r${k}_da`]: [-1, 1, 1],
    [`r${k}_and`]: [0, 1, 0], [`r${k}_fb`]: [0, NF, 0], [`r${k}_tb`]: [0, 1, 0.5], [`r${k}_db`]: [-1, 1, 1],
    [`r${k}_goal`]: [0, GOALS.length, 0], [`r${k}_bonus`]: [-8, 8, 0], [`r${k}_gait`]: [0, GAITS.length, 0],
    [`r${k}_cover`]: [0, 1, 0], [`r${k}_wait`]: [0, 1, 0],
  });
}
// active slots of a param set, decoded: [{ k, fa, ta, gt, and, fb, tb, gtb, goal, bonus, gait, cover, wait, text }]
export function parseReflexes(params) {
  const out = [];
  for (let k = 0; k < REFLEX_SLOTS; k++) {
    if (!((params[`r${k}_on`] ?? 0) > 0.5)) continue;
    const r = {
      k, fa: idx(params[`r${k}_fa`], NF), ta: params[`r${k}_ta`] ?? 0.5, gt: (params[`r${k}_da`] ?? 1) >= 0,
      and: (params[`r${k}_and`] ?? 0) > 0.5, fb: idx(params[`r${k}_fb`], NF), tb: params[`r${k}_tb`] ?? 0.5, gtb: (params[`r${k}_db`] ?? 1) >= 0,
      goal: idx(params[`r${k}_goal`], GOALS.length), bonus: params[`r${k}_bonus`] ?? 0,
      gait: idx(params[`r${k}_gait`], GAITS.length), cover: (params[`r${k}_cover`] ?? 0) > 0.5, wait: (params[`r${k}_wait`] ?? 0) > 0.5,
    };
    const c = (fi, gt, th) => `${FEATS[fi]} ${gt ? '>' : '<'} ${th.toFixed(2)}`;
    const mods = [r.gait ? GAITS[r.gait] : null, r.cover ? 'covered' : null, r.wait ? 'wait' : null].filter(Boolean);
    r.text = `IF ${c(r.fa, r.gt, r.ta)}${r.and ? ' AND ' + c(r.fb, r.gtb, r.tb) : ''} THEN ${GOALS[r.goal]}${mods.length ? '[' + mods.join(',') + ']' : ''} ${r.bonus >= 0 ? '+' : ''}${r.bonus.toFixed(1)}`;
    out.push(r);
  }
  return out;
}
export const decodeReflexes = (params) => parseReflexes(params).map((r) => r.text);
// genes for a readable reflex, e.g. reflexGenes(0, { if: ['allOthersOut', '>', 0.5], and: ['hNear', '<', 0.3], goal: 'rescue', bonus: 6, gait: 'crouch', cover: true })
export function reflexGenes(k, spec) {
  const g = { [`r${k}_on`]: 1, [`r${k}_fa`]: FI[spec.if[0]] + 0.5, [`r${k}_da`]: spec.if[1] === '<' ? -1 : 1, [`r${k}_ta`]: spec.if[2],
    [`r${k}_goal`]: GOALS.indexOf(spec.goal) + 0.5, [`r${k}_bonus`]: spec.bonus ?? 0, [`r${k}_gait`]: GAITS.indexOf(spec.gait ?? 'own') + 0.5,
    [`r${k}_cover`]: spec.cover ? 1 : 0, [`r${k}_wait`]: spec.wait ? 1 : 0, [`r${k}_and`]: spec.and ? 1 : 0 };
  if (spec.and) Object.assign(g, { [`r${k}_fb`]: FI[spec.and[0]] + 0.5, [`r${k}_db`]: spec.and[1] === '<' ? -1 : 1, [`r${k}_tb`]: spec.and[2] });
  return g;
}

export function makeSurvivorGoal(params) {
  const P = { ...params };
  for (const [k, v] of Object.entries(DROPPED)) P[k] = v ?? survivorSpace[k][2];
  for (const k of Object.keys(survivorSpace)) if (P[k] === undefined) P[k] = survivorSpace[k][2];
  const NG = GOALS.length;
  const W = GOALS.map((g) => Float64Array.from(FEATS, (f) => params[wName(g, f)] ?? DEF[g][f] ?? 0));
  const fatigueW = GOALS.map((g) => params[`g_${g}_fatigue`] ?? FATIGUE[g] ?? 0);
  const stick = params.goalStick ?? 0.75;
  const isMove = GOALS.map((g) => MOVE_GOALS.includes(g));
  const mk = (n, d) => GOALS.map((g) => (MOVE_GOALS.includes(g) ? params[`m_${g}_${n}`] ?? d : 0));
  const mSt = mk('stealth', -0.25), mStD = mk('stealthDanger', 0), mCv = mk('cover', -0.5), mCvD = mk('coverDanger', 0), mWait = mk('wait', 0);
  const RX = parseReflexes(params);
  return (ctx) => {
    const base = makeSurvivor(P)(ctx);
    const S = base.skills, { belief, rescue, heal, know, loops } = base, M = ctx.map;
    const anchors = loops.anchors;
    const HK = ctx.config.hooks || {}, stageS = HK.stageS ?? 70, deathStage = HK.deathStage ?? 3;
    const f = new Float64Array(NF);
    const score = new Float64Array(NG);
    const failed = [];   // goals whose motor routine had nothing to do this decision (debug)
    let goal = -1, goalSince = 0, prevGoal = -1;
    const goalStats = { ticks: new Float64Array(NG), switches: 0, enters: new Float64Array(NG), trans: {}, fallbacks: 0 };
    // kicked-gen memory (own sight only)
    const lastProg = M.generators.map(() => -1), kickT = M.generators.map(() => -1e9);
    let kickIdx = -1;
    let closeT = -99, closeKey = '', closeV = 0;
    let chaseSentT = -99, helpSentT = -99;
    let memX = 0, memZ = 0, memT = -2e9, memClose = 0, canSeeT = -1e9;   // own hunter memory (features hMem / hCanSee)
    const route = makeCoverRoute(ctx, belief);     // covered-route steps (extension point: stealth planner)
    const rxUntil = new Float64Array(RX.length).fill(-1);   // reflex latch
    const rxFired = new Uint8Array(RX.length);
    const modeRx = new Array(GOALS.length).fill(null);      // this decision's reflex mode override per goal
    let waitAcc = 0, lastMode = null;
    goalStats.reflexFired = new Float64Array(RX.length);   // decisions on which each reflex fired
    goalStats.reflexWon = new Float64Array(RX.length);     // ... and its goal ran
    goalStats.modes = { run: 0, walk: 0, crouch: 0, covered: 0, wait: 0 };

    function features(obs, api) {
      const me = obs.self, h = obs.hunter, hud = obs.hud || [], t = obs.t, nav = api.nav, mine = hud[me.id] || {};
      f.fill(0);
      f[FI.bias] = 1;
      f[FI.injured] = me.state === 'injured' ? 1 : 0;
      f[FI.hookStages] = Math.min(1, (mine.hookStages ?? 0) / 2);
      f[FI.deepWound] = me.deepWoundS != null ? 1 : 0;
      f[FI.protected] = me.protectedS != null ? clamp01(me.protectedS / 10) : 0;
      f[FI.beingHealed] = mine.beingHealed ? 1 : 0;
      f[FI.chased] = me.chased ? 1 : 0;
      f[FI.repairing] = me.act === 'repair' ? 1 : 0;
      // hunter sight features are short memories (time constant ~1 s; hMem 5 s), so a sighting that flickers for a
      // tick (cone edge, camera turn, occluder) doesn't flip the goal scores
      if (h) {
        const d = d2(h, me);
        memX = h.x; memZ = h.z; memT = t;
        memClose = Math.max(-1, Math.min(1, ((h.vx || 0) * (me.x - h.x) + (h.vz || 0) * (me.z - h.z)) / Math.max(0.1, d) / 4.6));
        if (S.hunterCouldSee(api, h, me)) canSeeT = t;
      }
      if (memT > -1e9) {
        const prox = clamp01(1 - hyp(memX - me.x, memZ - me.z) / 40), k1 = Math.exp(-(t - memT) / 1.0);
        f[FI.hVisible] = k1 < 0.05 ? 0 : k1;
        f[FI.hNear] = prox * f[FI.hVisible];
        f[FI.hClosing] = memClose * f[FI.hVisible];
        f[FI.hMem] = prox * Math.exp(-(t - memT) / 5);
      }
      f[FI.hCanSee] = Math.exp(-(t - canSeeT) / 1.0);
      if (f[FI.hCanSee] < 0.05) f[FI.hCanSee] = 0;
      if (obs.terror) { f[FI.terror] = obs.terror.layer / 3; f[FI.terrorUp] = belief.trend(t, 4) > 0 ? 1 : 0; }
      f[FI.threat] = S.beliefOn ? clamp01(S.myThreat(me)) : 0;
      let hooked = 0, gone = 0, rep = 0, busy = 0;
      for (const x of hud) {
        if (!x || x.id === me.id) continue;
        if (x.state === 'hooked') hooked++;
        else if (x.state === 'dead' || x.state === 'escaped') gone++;
        if (x.chased || x.state === 'carried') busy = 1;
        if (x.activity === 'repair') rep++;
      }
      f[FI.hBusy] = busy; f[FI.hooked] = hooked / 3; f[FI.matesGone] = gone / 3; f[FI.matesRepairing] = rep / 3;
      // generators (only the ones I've found)
      const gens = obs.gens;
      let avail = 0, nearD = Infinity, prog = 0, unknown = 0, kp = 0;
      kickIdx = -1;
      for (let i = 0; i < gens.length; i++) {
        const g = gens[i];
        if (!g.known) { unknown++; continue; }
        if (g.visible) {
          if (g.regressing || (lastProg[i] >= 0 && g.progress < lastProg[i] - 0.004)) kickT[i] = t;
          else if (g.workers && g.workers.some((w) => w !== me.id)) kickT[i] = -1e9;   // someone's on it
          lastProg[i] = g.progress;
        }
        if (g.done || g.blocked) continue;
        avail++;
        const d = nav.dist(me, g);
        if (d < nearD) nearD = d;
        if (g.progress > prog) prog = g.progress;
        if (t - kickT[i] < 120 && g.progress > 0.05 && g.progress > kp) { kp = g.progress; kickIdx = i; }
      }
      f[FI.gens] = Math.min(1, (obs.gensDone ?? 0) / (obs.gensNeeded || 5));
      f[FI.genAvail] = Math.min(1, avail / 2);
      f[FI.genNear] = isFinite(nearD) ? clamp01(1 - nearD / 60) : 0;
      f[FI.genProg] = prog;
      f[FI.kicked] = kp;
      f[FI.unexplored] = unknown > 0 && know.fraction() < 0.98 ? unknown / gens.length : 0;
      f[FI.gatesPowered] = obs.gatesPowered ? 1 : 0;
      f[FI.gateOpen] = obs.gates && obs.gates.some((g) => g.open) ? 1 : 0;
      f[FI.collapse] = obs.endgame ? clamp01(1 - obs.endgame.remainingS / 120) : 0;
      // hooked teammates (rescue.js keeps the hook positions from the notifications)
      let hk = null, hkD = Infinity, hkJ = -1, urg = 0;
      for (const k of Object.keys(rescue.hooked)) {
        const j = +k, e = rescue.hooked[k];
        if (j === me.id) continue;
        const struggle = (hud[j] ? hud[j].hookStage : e.stage) >= deathStage - 1;
        urg = Math.max(urg, clamp01(1 - (stageS - (t - e.stageT)) / stageS) * (struggle ? 2 : 1) / 2);
        const d = nav.dist(me, e);
        if (d < hkD) { hkD = d; hk = e; hkJ = j; }
      }
      f[FI.hookUrgency] = urg;
      if (hk) {
        f[FI.hookNear] = isFinite(hkD) ? clamp01(1 - hkD / 60) : 0;
        // camping: seen / recently seen near the hook, its Resolve rising (hunter within 16 m), else my belief
        const near = (d) => (d < 12 ? 1 : d < 24 ? (24 - d) / 12 : 0);
        let camp;
        if (h) camp = near(d2(h, hk));
        else if (obs.lastHunter && t - obs.lastHunter.t < 6) camp = near(Math.max(0, d2(obs.lastHunter, hk) - 4.6 * (t - obs.lastHunter.t)));
        else camp = S.beliefOn ? belief.pHunterWithin(hk, 16) : Math.exp(-(t - hk.t) / 20);
        if (t - hk.resolveUpT < 3) camp = Math.max(camp, 0.9);
        f[FI.hookCamp] = clamp01(camp);
        let claim = 0;
        for (const x of hud) {
          if (!x || x.id === me.id || x.id === hkJ || x.state === 'downed' || x.state === 'hooked' || x.state === 'dead') continue;
          if (x.activity === 'rescue' && hkD > 3) claim = 1;
          else if (!x.chased && rescue.tracker.claimedUnhook(x.id, hk.t, t)) claim = Math.max(claim, 0.5);
        }
        f[FI.claimed] = claim;
        // P(I'm the closest) vs each standing, un-chased teammate's estimated path distance (2 Hz)
        const key = hkJ + ':' + me.state;
        if (t - closeT >= 0.5 || key !== closeKey) {
          closeT = t; closeKey = key; closeV = 1;
          if (isFinite(hkD)) for (const x of hud) {
            if (!x || x.id === me.id || x.id === hkJ || x.chased || (x.state !== 'healthy' && x.state !== 'injured')) continue;
            const e = rescue.tracker.pathTo(x.id, hk, t);
            closeV *= 1 - sig((hkD - e.d) / (0.4 * e.r + 3));
          } else closeV = 0;
        }
        f[FI.iClosest] = closeV;
        const lh = obs.lastHunter;
        f[FI.hunterNearHook] = (h ? d2(h, hk) < 16 : !!lh && t - lh.t < 8 && d2(lh, hk) < 16) ? 1 : 0;
      }
      // teammates I can see / downed auras
      let dn = Infinity, inj = Infinity, hl = Infinity;
      for (const a of obs.downedAuras || []) dn = Math.min(dn, d2(a, me));
      for (const tm of obs.teammates) {
        const d = d2(tm, me);
        if (tm.state === 'downed') dn = Math.min(dn, d);
        else if (tm.state === 'injured') inj = Math.min(inj, d);
        else if (tm.state === 'healthy') hl = Math.min(hl, d);
      }
      f[FI.downedNear] = isFinite(dn) ? clamp01(1 - dn / 40) : 0;
      f[FI.injuredNear] = isFinite(inj) ? clamp01(1 - inj / 30) : 0;
      f[FI.healthyNear] = isFinite(hl) ? clamp01(1 - hl / 30) : 0;
      if (heal.accept) f[FI.healOffer] = 1;
      else if (me.state === 'injured') {
        for (const tm of obs.teammates) { const it = rescue.tracker.intent[tm.id]; if (it && it.intent === 'healing' && t - it.t < 10 && d2(tm, me) <= Math.max(6, P.healAcceptDist)) { f[FI.healOffer] = 0.5; break; } }
      }
      // terrain
      f[FI.cover] = clamp01(belief.coverAt(me.x, me.z));
      let ln = 0;
      for (const a of anchors) {
        if (!know.anchorKnown[a.k]) continue;
        const d = d2(a.c, me);
        if (d > 15) continue;
        if (a.kind === 'w' ? obs.blockedWindows.includes(a.id) : obs.pallets[a.i] === 'broken') continue;
        const v = clamp01(Math.max(0, loops.detour(a.k) - 3.2) / 20) * (1 - d / 15);
        if (v > ln) ln = v;
      }
      f[FI.loopNear] = ln;
      f[FI.time] = Math.min(1, t / 600);
      f[FI.injNear] = f[FI.injured] * f[FI.hNear];
      f[FI.seeNear] = f[FI.hCanSee] * f[FI.hNear];
      f[FI.progTerror] = f[FI.genProg] * f[FI.terror];
      f[FI.hookGens] = f[FI.hooked] * f[FI.gens];
      let inGame = 0, standing = 0, chasedO = 0, carried = 0;
      for (const x of hud) {
        if (!x || x.id === me.id || x.state === 'dead' || x.state === 'escaped') continue;
        inGame++;
        if (x.state === 'healthy' || x.state === 'injured') standing++;
        if (x.chased) chasedO = 1;
        if (x.state === 'carried') carried = 1;
      }
      f[FI.matesHookedFrac] = inGame ? hooked / inGame : 0;
      f[FI.allOthersOut] = inGame > 0 && standing === 0 ? 1 : 0;
      f[FI.lastAlive] = inGame === 0 ? 1 : 0;
      f[FI.hunterChasingOther] = chasedO;
      f[FI.mateCarried] = carried;
      let left = 1;
      for (const k of Object.keys(rescue.hooked)) {
        const j = +k, e = rescue.hooked[k];
        if (j === me.id) continue;
        const struggle = (hud[j] ? hud[j].hookStage : e.stage) >= deathStage - 1;
        left = Math.min(left, clamp01((stageS - (t - e.stageT) + (struggle ? 0 : stageS)) / (2 * stageS)));
      }
      f[FI.hookTimeLeft] = left;
      f[FI.endgameLeft] = obs.endgame ? clamp01(obs.endgame.remainingS / 120) : 0;
      f[FI.danger] = Math.max(f[FI.hNear], f[FI.hMem], f[FI.terror], f[FI.threat]);
    }

    // physical preconditions only (not habits): can this goal do anything at all right now?
    function feasible(gi, obs) {
      const me = obs.self;
      switch (GOALS[gi]) {
        case 'repair': return f[FI.genAvail] > 0 && !obs.gatesPowered;
        case 'explore': return f[FI.unexplored] > 0 && !obs.gatesPowered;
        case 'kicked': return kickIdx >= 0 && !obs.gatesPowered;
        case 'flee': return !!(me.chased || obs.hunter || obs.lastHunter);
        case 'sneak': return !!(obs.lastHunter || obs.terror);
        case 'rescue': return f[FI.hookNear] > 0 || Object.keys(rescue.hooked).some((k) => +k !== me.id);
        case 'heal': return f[FI.injuredNear] > 0 || f[FI.downedNear] > 0;
        case 'pickup': return f[FI.downedNear] > 0;
        case 'getHealed': return me.state === 'injured';
        case 'mend': return me.deepWoundS != null;
        case 'gate': return !!obs.gatesPowered;
        case 'protect': return !!obs.hunter && obs.teammates.length > 0;
        default: return true;   // hide, watch
      }
    }

    // motor routines: an action, or null (nothing to do -> the next best goal runs)
    function run(gi, obs, api, cx) {
      const me = obs.self, h = obs.hunter, t = obs.t;
      switch (GOALS[gi]) {
        case 'repair': return S.workStep(obs, api, cx.walk, cx.hold, 'gen');
        case 'explore': return S.workStep(obs, api, cx.walk, cx.hold, 'explore');
        case 'kicked': {
          if (kickIdx < 0) return null;
          S.genTarget = kickIdx;
          return S.slots.act(obs, kickIdx, obs.gens[kickIdx], { walk: cx.walk, hold: cx.hold });
        }
        case 'flee': {
          const a = S.chase(obs, api, me, h);
          if (a) { if (me.chased && t - chaseSentT > 30) { chaseSentT = t; return cx.say(a, 'chasingMe'); } return a; }
          if (me.chased) { const hp = S.hunterPos(obs); if (hp) return { moveDir: { x: me.x - hp.x, z: me.z - hp.z } }; }
          return null;
        }
        case 'hide': {
          if (h) {
            if (S.hunterCouldSee(api, h, me)) {
              const spot = S.findHide(obs, api, me, h);
              return spot ? { moveTo: spot, walk: P.hideWalk > 0.5, look: h } : null;
            }
            return { look: { x: h.x + (h.vx || 0) * 0.5, z: h.z + (h.vz || 0) * 0.5 } };   // out of its view: hold, watch it
          }
          if (!S.hide) {
            const gt = S.genTarget;
            S.hide = { start: t, lastTrig: t, spot: null, spotT: -99, gen: me.act === 'repair' || (gt >= 0 && obs.gens[gt].known && d2(me, obs.gens[gt]) < 4) ? gt : -1 };
            base.stats.hides++;
          }
          const hd = S.hide;
          base.stats.hideTicks++;
          if (!hd.spot || t - hd.spotT >= 2) { hd.spot = S.pickHideSpot(obs, api, me); hd.spotT = t; }
          const lk = hd.look || (S.beliefOn ? belief.expectedPos() : null);
          if (d2(me, hd.spot) > 0.6) return { moveTo: hd.spot, walk: P.coverRun <= 0.5 };
          return lk ? { look: lk } : {};
        }
        case 'watch': {
          if (h) return { look: { x: h.x + (h.vx || 0) * 0.5, z: h.z + (h.vz || 0) * 0.5 } };
          const e = (S.beliefOn ? belief.expectedPos() : null) || obs.lastHunter;
          return e ? { look: { x: e.x, z: e.z } } : {};
        }
        case 'sneak': {
          const ref = obs.lastHunter ?? me;
          let far = -1, fd = -Infinity;
          for (let i = 0; i < obs.gens.length; i++) {
            const g = obs.gens[i];
            if (!g.known || g.done || g.blocked) continue;
            const d = d2(g, ref) - 0.3 * d2(g, me);
            if (d > fd) { fd = d; far = i; }
          }
          if (far >= 0) return S.slots.act(obs, far, obs.gens[far], { walk: cx.walk, hold: cx.hold });
          if (obs.lastHunter) return { moveDir: { x: me.x - ref.x, z: me.z - ref.z }, walk: true };
          return null;
        }
        case 'rescue': return rescue.decide(obs, api, { holdProtection: cx.hold, say: cx.say, beliefFull: S.beliefFull });
        case 'heal': return heal.healer(obs, { healDist: P.healDist, holdProtection: cx.hold, say: cx.say, joinGen: (gi) => S.slots.act(obs, gi, obs.gens[gi], { walk: false, hold: cx.hold }) });
        case 'pickup': {
          let best = null, bd = Infinity;
          for (const a of obs.downedAuras || []) { const d = d2(a, me); if (d < bd) { bd = d; best = a; } }
          if (!best) return null;
          if (bd <= 1.5) return cx.hold ? {} : { act: 'heal', target: best.id };
          return { moveTo: approach(best, me) };
        }
        case 'getHealed': {
          if (me.state !== 'injured') return null;
          if (obs.hud && obs.hud[me.id] && obs.hud[me.id].beingHealed) return {};
          const pa = heal.patient(obs);
          if (pa) return pa;
          let mate = null, md = Infinity;
          for (const tm of obs.teammates) if (tm.state === 'healthy') { const d = d2(tm, me); if (d < md) { md = d; mate = tm; } }
          if (!mate || md > 30) return null;
          if (md <= 1.5) return t - helpSentT > 20 ? (helpSentT = t, cx.say({}, 'help')) : {};
          return { moveTo: approach(mate, me) };
        }
        case 'mend': return me.deepWoundS != null ? { act: 'mend' } : null;
        case 'gate': return S.gateStep(obs, api, cx.hold);
        case 'protect': {
          if (!h) return null;
          let best = null, bd = 16;
          for (const tm of obs.teammates) { if (tm.state === 'dead' || tm.state === 'hooked' || tm.state === 'carried') continue; const d = d2(tm, h); if (d < bd) { bd = d; best = tm; } }
          if (!best) return null;
          const L = Math.max(0.1, bd), k = Math.min(1.2, L / 2);
          return { moveTo: { x: best.x + (h.x - best.x) / L * k, z: best.z + (h.z - best.z) / L * k }, face: h };
        }
      }
      return null;
    }

    function leave(gi) {
      const g = GOALS[gi];
      if (g === 'flee') S.circ = null;
      if (g === 'hide') S.hide = null;
    }

    // hunter near a point: seen (1 at the point .. 0 at 24 m), else my belief's P(within 16 m)
    function dangerAt(pt, obs) {
      const h = obs.hunter;
      if (h) return clamp01(1 - d2(h, pt) / 24);
      return S.beliefOn ? clamp01(belief.pHunterWithin(pt, 16)) : 0;
    }
    // motor mode of the running goal: timing (wait), route (covered), gait. The defaults change nothing.
    function applyMode(gi, a, obs, api) {
      const s = mSt[gi] + mStD[gi] * f[FI.danger];
      let gait = s < -0.5 ? 1 : s < 0 ? 0 : s < 0.5 ? 2 : 3;
      let cover = mCv[gi] + mCvD[gi] * f[FI.danger] > 0, wait = mWait[gi];
      const rx = modeRx[gi];
      if (rx) { if (rx.gait) gait = rx.gait; if (rx.cover) cover = true; if (rx.wait) wait = Math.max(wait, 0.7); }
      if (a.act || !(a.moveTo || a.moveDir)) return a;
      if (!gait && !cover && !(wait > 0)) return a;
      const me = obs.self;
      lastMode = { gait: GAITS[gait], cover: false, wait: false, rx: rx ? rx.by.slice() : null };
      if (wait > 0 && a.moveTo && waitAcc < 25 && !(f[FI.hunterChasingOther] || f[FI.mateCarried]) && dangerAt(a.moveTo, obs) > 1 - wait) {
        waitAcc += (ctx.config.decisionEvery || 1) / (ctx.config.tickHz || 10);
        goalStats.modes.wait++; lastMode.wait = true;
        const h = obs.hunter, e = h || (S.beliefOn ? belief.expectedPos() : null) || a.moveTo;
        const out = { look: { x: e.x, z: e.z } };
        if (gait === 3) out.crouch = true;
        return out;
      }
      let out = a;
      if (cover && a.moveTo) {
        const wp = route.step(obs, api, me, a.moveTo, { crouch: gait === 3 });
        if (wp) { out = { ...out, moveTo: wp }; goalStats.modes.covered++; lastMode.cover = true; }
      }
      if (gait === 1) { out = { ...out }; delete out.walk; delete out.crouch; goalStats.modes.run++; }
      else if (gait === 2) { out = { ...out, walk: true }; delete out.crouch; goalStats.modes.walk++; }
      else if (gait === 3) { out = { ...out, crouch: true }; goalStats.modes.crouch++; }
      return out;
    }

    function decideInner(obs, api) {
      const me = obs.self, h = obs.hunter, nav = api.nav;
      if (me.state === 'hooked') return me.canSelfUnhook ? { act: 'selfUnhook' } : {};
      if (me.state === 'carried') return { act: 'wiggle' };
      S.observe(obs, api);
      if (me.state === 'downed') {
        if (goal >= 0) { leave(goal); goal = -1; }
        if (obs.gates) for (const g of obs.gates) {
          if (!g.open) continue;
          const gd = M.exitGates.find((x) => x.id === g.id);
          if (gd && nav.dist(me, gd.exit) < 30) return { moveTo: gd.exit };
        }
        if (h && d2(h, me) < P.downedStillDist) return { moveDir: { x: me.x - h.x, z: me.z - h.z } };
        return {};
      }
      rescue.update(obs);
      heal.update(obs);
      features(obs, api);
      const t = obs.t;
      for (let g = 0; g < NG; g++) {
        if (!feasible(g, obs)) { score[g] = -Infinity; continue; }
        const w = W[g];
        let s = 0;
        for (let j = 0; j < NF; j++) s += w[j] * f[j];
        if (g === goal) s += stick + fatigueW[g] * Math.min(1, (t - goalSince) / 30);
        score[g] = s;
      }
      // reflexes: conditions over the same features; a firing one adds its bonus and its mode override to its goal
      modeRx.fill(null);
      for (let i = 0; i < RX.length; i++) {
        const r = RX[i];
        const ca = r.gt ? f[r.fa] > r.ta : f[r.fa] < r.ta;
        if (ca && (!r.and || (r.gtb ? f[r.fb] > r.tb : f[r.fb] < r.tb))) rxUntil[i] = t + RX_LATCH_S;
        rxFired[i] = t < rxUntil[i] ? 1 : 0;
        if (!rxFired[i]) continue;
        goalStats.reflexFired[i]++;
        if (score[r.goal] === -Infinity) continue;
        score[r.goal] += r.bonus;
        if (r.gait || r.cover || r.wait) {
          const o = modeRx[r.goal] || (modeRx[r.goal] = { gait: 0, cover: false, wait: false, by: [] });
          if (r.gait) o.gait = r.gait;
          o.cover = o.cover || r.cover; o.wait = o.wait || r.wait; o.by.push(r.k);
        }
      }
      const canSay = !(me.intentCooldownS > 0);
      const cx = {
        walk: P.walkWhenTR > 0.5 && obs.terror !== null,
        hold: me.protectedS != null && me.protectedS > 10 - P.protectHoldS,
        say: (a, msg) => (canSay ? { ...a, intent: msg } : a),
      };
      const tried = new Uint8Array(NG);
      failed.length = 0;
      for (let n = 0; n < NG; n++) {
        let bi = -1, bs = -Infinity;
        for (let g = 0; g < NG; g++) if (!tried[g] && score[g] > bs) { bs = score[g]; bi = g; }
        if (bi < 0) break;
        tried[bi] = 1;
        let a = run(bi, obs, api, cx);
        if (!a) { goalStats.fallbacks++; failed.push(bi); continue; }
        if (bi !== goal) {   // switching: release the old goal's motor state
          if (goal >= 0) leave(goal);
          prevGoal = goal; goal = bi; goalSince = t; waitAcc = 0;
          goalStats.switches++; goalStats.enters[bi]++;
          const key = (prevGoal >= 0 ? GOALS[prevGoal] : '-') + '>' + GOALS[bi];
          goalStats.trans[key] = (goalStats.trans[key] || 0) + 1;
        }
        S.mode = GOALS[bi] === 'flee' ? 'chase' : GOALS[bi] === 'sneak' ? 'sneak' : 'work';
        goalStats.ticks[bi]++;
        for (let i = 0; i < RX.length; i++) if (rxFired[i] && RX[i].goal === bi) goalStats.reflexWon[i]++;
        lastMode = null;
        if (isMove[bi]) a = applyMode(bi, a, obs, api);
        return a;
      }
      if (goal >= 0) { leave(goal); goal = -1; }
      return {};
    }

    return {
      stats: base.stats, know, loops, belief, rescue, heal, goalStats,
      features: f, scores: score,
      decide(obs, api) {
        let a = decideInner(obs, api);
        const st = obs.self.state;
        if (st === 'healthy' || st === 'injured') a = S.unblock(obs, a);
        return S.withLook(obs, a);
      },
      decideInner,
      get goal() { return goal >= 0 ? GOALS[goal] : null; },
      // viewer: the param brain's layers + "current goal and why" (plain copies; mutates nothing a decision reads)
      debug(t = 0, opts = {}) {
        const out = base.debug(t, opts);
        const feats = {};
        for (let j = 0; j < NF; j++) feats[FEATS[j]] = f[j];
        const scores = {};
        for (let g = 0; g < NG; g++) if (score[g] > -Infinity) scores[GOALS[g]] = +score[g].toFixed(3);
        let top = [];
        if (goal >= 0) {
          const w = W[goal];
          for (let j = 0; j < NF; j++) if (w[j] * f[j] !== 0) top.push({ f: FEATS[j], v: +f[j].toFixed(3), w: w[j], c: +(w[j] * f[j]).toFixed(3) });
          top.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
          top = top.slice(0, 5);
        }
        const reflexes = RX.map((r, i) => ({ k: r.k, text: r.text, fired: !!rxFired[i] }));
        out.goal = { reflexes, mode: lastMode ? { ...lastMode } : null, name: goal >= 0 ? GOALS[goal] : null, failed: failed.map((g) => GOALS[g]), prev: prevGoal >= 0 ? GOALS[prevGoal] : null, since: goalSince, scores, top, features: feats };
        return out;
      },
    };
  };
}
