// Parametric survivor. Solo-queue rules: no module-level mutable state; everything lives in the closure.
// Knobs are hill-climbed; `space` = { name: [min, max, default] }.

export const survivorSpace = {
  fleeSeenDist:  [6, 40, 20],    // hunter seen within this -> chase mode
  fleeTR:        [0, 32, 12],    // abandon a gen when the heard terror layer's midpoint (26.7 / 16 / 5.3 m) is below this
  calmS:         [1, 12, 4],     // seconds without sighting (and terror > fleeTR) before calming down
  walkWhenTR:    [0, 1, 0.5],    // >0.5: walk (no scratch marks) when sneaking away from terror
  vaultDist:     [1.5, 8, 4],    // cross a window/dropped pallet when hunter on our side within this
  loopRace:      [0.4, 1.2, 0.8],// take a loop only if my path to its entry < loopRace * the hunter's distance to it
  altruism:      [0, 1, 0.6],    // willingness to rescue / heal
  healDist:      [0, 40, 15],    // heal visible injured/downed teammates within this
  genDistW:      [0, 2, 1],
  genProgW:      [0, 2, 1],
  spreadW:       [-1, 2, 0.5],   // per teammate already on a gen (HUD): >0 spread out, <0 group up
  hunterAvoidW:  [0, 2, 1],      // avoid gens near the last hunter sighting
  sneakMaxS:     [3, 60, 15],    // give up sneaking (go back to work despite terror) after this long
  protectHoldS:  [0, 10, 0],     // after unhook: hold off conspicuous actions (repair/heal/rescue/gate) for this many of the 10 protected seconds
  mendRiskDist:  [0, 40, 16],    // only mend Deep Wound if the hunter isn't seen within this
  holdMaxS:      [0, 20, 4],     // max time to hold at a loop entry while the hunter isn't pressing us (seen + approaching)
  // ---- HUD-driven teamwork (solo queue: no comms, but the HUD shows states / gens / chases / hooks / downed auras) ----
  ...rescueSpace,
  ...healSpace,                  // heal handshake (healer says "healing", patient pauses) + slug pick-up priorities: healplan.js                // rescue utility (closest / stage urgency / camping / busy hunter / claims / own risk) + chaseFromHookW: rescue.js
  trustChase:    [0, 1, 0.6],    // >0.5: don't abandon my gen on terror while another survivor is being chased
  downedStillDist: [0, 40, 12],  // downed: lie still (auto-recover to 95%) unless the hunter is seen within this; then crawl away
  seekHeal:      [0, 1, 0.4],    // >0.5: when injured, walk to a visible healthy teammate and stand still to be healed
  // ---- generator choice ----
  farFromHunterW: [0, 2, 0.5],   // prefer gens far from the hunter's last known position (linear up to 60 m)
  genJitter:     [0, 2, 0.3],    // per-survivor fixed random preference per gen (breaks the four-identical-bots symmetry)
  // ---- stealth: use line of sight ----
  hideDist:      [0, 75, 40],    // hunter seen within this, not chasing me, and it could see me -> slip out of its view
  hideWalk:      [0, 1, 0.6],    // >0.5: walk (no scratch marks) while slipping out of view
  // ---- camera (survivor.camera): where to look, peeking ----
  glanceRate:    [0, 1, 0.4],    // how often to glance around while working / walking (0 = rarely, 1 = constantly)
  peekW:         [0, 8, 1],      // hiding-spot score: bonus for a "peek spot" (body out of the hunter's sight, camera sees it)
  peekMoveMaxM:  [2, 20, 10],    // how far to move for a peek / hiding spot when slipping out of a visible hunter's view
  hideHoldS:     [0, 8, 2],      // once out of view, stay put this long while the hunter is still around
  // ---- chase: loops scored by "equivalent distance held" (loops.js) ----
  loopTravelMaxM:[5, 50, 25],    // max path distance I'll run to reach a loop's entry
  holdW:         [0, 3, 1],      // loop route value = min gap to its entry + holdW * the circuit's distance held per lap (m)
  holdHorizonS:  [2, 12, 8],     // open-field fleeing: routes scored by the min survivor-hunter path gap over this horizon (s)
  avoidHeading:  [0, 1, 0.6],    // >0.5: skip loop entries the hunter is heading toward (it would cut us off)
  loopReverseDist: [0, 20, 0],   // running a loop: the visible hunter comes round the other way (heading for my next crossing, nearer to it than to me) within this path distance of it -> reverse (0 = off)
  loopReactS:    [0, 1.5, 0.4],  // ...after seeing that for this long (reaction time; also filters a hunter's fake turn)
  vaultSafetyMarginM: [0, 3, 0.8], // vault only if the hunter's swing (range + windup lunge) misses by this margin in a 1D replay
  vaultClearanceS: [0, 3, 1],    // don't vault a window the hunter is in / cleared less than this long ago
  // ---- fast-vault approach (a fast window vault needs a straight 2.5 m run-up ending at the window; arriving from the
  // side at the 1.6 m entry point gives a 0.9 s medium vault). docs/research/fast-vaults.md ----
  // >0.5: on. A running loop crossing may line up in front of the window and run straight in, and the planners price
  // the vault tier that approach produces (loops.tsIn, routes.js run-up edges). Off (default) = the entry-point approach
  // and the old pricing (bit-identical to before; on measured slightly worse in full matches, see the doc)
  vaultLineup:   [0, 1, 0],
  vaultApproachM: [3.9, 6, 4],   // how far out (m, from the window centre) the lineup starts at most (>= 3.9 for a 2.5 m run-up)
  // line up when the extra path x this weight costs less than the 0.4 s a fast vault saves (and the lineup stays
  // safe); 0 = always when the lane allows it, high = only when it's on the way
  vaultDetourW:  [0, 4, 1],
  // approach angle: the straight-in run may start up to this many degrees off the window's axis (the engine's
  // fast-vault cone is 45 deg; wider = shorter lineup detours, less slack; the run is steered directly, not via the nav)
  vaultFunnelDeg: [5, 44, 20],
  // planners price a window crossing as fast + this x (the executed approach's extra time: medium vault, or the lineup
  // detour); 1 = as executed, 0 = every window as a fast vault (optimistic: the medium-vs-fast trade-off weight)
  vaultAngleW:   [0, 1.5, 1],
  loopScoutW:    [0, 2, 0.5],    // exploring: pull toward unseen windows / pallets that would complete a strong known loop
  chaseToMatesW: [-1, 1, 0],     // in a chase: >0 run toward teammates known to be repairing, <0 lead the hunter away from them
  edgeAvoidW:    [-1, 1, 0],     // in a chase: >0 avoid loops / flee points within 16 m of the map's outer wall, <0 prefer them
  followFleeW:   [-1, 1, 0],     // fleeing (chase flee point / loop anchor / hide spot): >0 run the same way as a visible teammate who's fleeing the hunter, <0 diverge
  genClusterW:   [-1, 1, 0],     // fleeing (flee point / loop anchor / hide spot): >0 toward the tightest cluster of unfinished gens I've perceived, <0 away
  // ---- pallets: drop vs save, by distance held ----
  palletGreed:   [0, 3, 1],      // value of keeping a standing pallet for later (x its distance held): high = drop only when it's that or get hit
  stunSeek:      [0, 1, 0.5],    // once dropping: 1 = hold the drop until the hunter is in the stun zone (risky), 0 = drop early (hunter within ~6 m)
  // ---- hiding while the hunter is NOT visible (own belief map about the hunter: hunterbelief.js) ----
  hbSpread:      [0.3, 1.2, 0.8],  // belief: how fast the hunter's possible area grows, as a fraction of hunter speed
  hideThreat:    [0.05, 1.05, 1.05],// hide when P(hunter within hideThreatR, soft) >= this (> 1 = never; default off: A/B vs the default hunter cost gens)
  hideThreatR:   [8, 32, 16],      // radius (m) of that threat estimate
  hideOnLayer:   [0, 3.5, 0],      // also hide while hearing a terror layer >= this (layer 1 = outermost; < 1 = off)
  hideOnClosing: [0, 1, 0.3],      // >0.5: also hide when the terror layer got closer within the last 4 s
  hideProgSlack: [0, 1, 0.3],      // while repairing: raise the threat threshold by this x my generator's progress
  hideStayS:     [0, 15, 3],       // keep hiding this long after the trigger clears (hysteresis)
  hideMaxS:      [5, 60, 20],      // give up a hide after this long (then no new unseen-hunter hide for 10 s)
  hideMoveMaxM:  [0, 30, 12],      // how far I'll move to a hiding spot (0 = freeze where I am)
  coverW:        [0, 3, 1],        // hiding-spot score: weight of the spot's cover (vs its threat and the walk there)
  exposeW:       [0, 3, 1.5],      // hiding-spot score: penalty for line of sight from where my belief puts the hunter
  hideGenFear:   [0, 2, 0.5],      // hide-spot exposure: weight of the gen I was on as a hunter viewpoint (x the belief's top mass)
  coverRun:      [0, 1, 0.3],      // >0.5: run to the hiding spot (faster, scratch marks); else walk
  hideNerveM:    [0, 30, 8],       // hiding and the hunter shows up without seeing me: stay frozen unless it comes closer than this
  genCoverW:     [-1, 2, 0],       // generator choice: prefer gens with well-covered repair slots
  genThreatW:    [0, 3, 0.5],      // generator choice: avoid gens where my belief puts the hunter (P within 24 m)
  // ---- crouching (engine: 1.13 m/s, no scratch marks, fully hidden in the shadow of low cover; sim README 'Crouching') ----
  crouchHideW:   [0, 1, 0],        // hiding: blend a spot's cover toward its crouched cover (low walls / gens count) and crouch while holding a hidden spot; >0.5 also judges spots / exposure as crouched. 0 = off
  crouchSneakDist: [0, 40, 0],     // stealth moves (slipping out of view, to a hide spot, sneaking off): crouch-walk while the hunter is within this (seen distance, else the terror layer's approx). 0 = off
  crouchMaxS:    [1, 30, 8],       // stop crouch-walking (walk instead) after this long continuously
  // ---- exploration (survivors only know the generators / loop anchors they have found) ----
  exploresMap:   [0, 1, 0.5],      // propensity to explore unexplored areas instead of working a known gen (0 = only when no gen is known)
  exploreRadM:   [10, 80, 35],     // preferred distance of exploration targets (score = unexplored share - distance / this)
  // ---- repair productivity (work mode) ----
  otherChaseTrustDist: [0, 40, 5],  // hunter seen while the HUD shows it chasing someone else and it isn't coming at me: keep working (no chase mode / hide) if it's farther than this (40 = off)
  candidateSearchW: [0, 3, 1],      // exploring: value of unresolved public generator-candidate wrecks (x P(gen) = unfound gens / unresolved candidates); 0 = generic area exploration only
  taskGlanceS:   [0, 10, 3],        // work mode, hunter not seen lately: every this many s glance ~1 s at an unresolved candidate wreck in view (0 = off)
  genCommitS:    [0, 30, 0],        // after committing to a gen, don't switch to exploring for this long
  repairAbandonMarginS: [0, 30, 10], // repairing: another option must beat staying by this many seconds of travel (~4 m/s) to pull me off
  repairersTargetW: [-1, 2, 1],     // gen choice: per teammate I last saw repairing it and the HUD still shows repairing (MateTracker), like spreadW
  remainingClusterW: [0, 3, 1],     // gen choice: prefer the gen whose completion leaves the most spread-out remaining known gens (min 3-gen tour among the ones I've found, per 30 m)
  finishRiskW:   [0, 3, 0],         // gen choice: a partial gen's hunter-danger penalty shrinks by min(1, this x progress) while the hunter isn't on me / seen coming
  // ---- route lookahead: open flee destinations scored by the next resource reachable from there (lookahead.js) ----
  ...lookaheadSpace,
  // ---- kicked / threatened gen: hide nearby and return when the hunter leaves vs leave for another gen (kickplan.js) ----
  ...kickSpace,
  // ---- killer profile: what I've observed of this hunter's habits, and how much to play around it (killerprofile.js) ----
  ...profileSpace,
  // ---- hunter forecast (hunterforecast.js): where the seen hunter is GOING, learned per chase from its own moves ----
  fcLearnS:      [0.3, 4, 1.5],    // memory (s) of each motion model's recent prediction error (pursue / momentum / cut / stand)
  fcLeadS:       [0, 1.5, 0],      // route scoring: the hunter keeps its forecast course this long, then pure pursuit (0 = pure pursuit, old)
  fcReverseP:    [0, 1.05, 1.05],  // running a loop: reverse when P(forecast hunter is at my next entry before me) >= this (> 1 = off;
                                   // default off: 0.6 was neutral at n=128, -0.02 / +0.01 kills)
  fcEntryMarginM:[-1, 4, 1],       // ...where "at" = within its swing reach + this
  // ---- after a vault: where to wait, and whether waiting beats running on ----
  stationMode:   [0, 1, 0],        // >0.5: wait at the best mind-game distance on the landing side (vault-back vs run-round
                                   // margins, weighted by the forecast) and leave when running on is worth more; else the
                                   // old hold at the entry until holdMaxS. Default off: n=128 A/B +0.10..0.15 kills (the
                                   // default hunter vaults into a holding survivor in 56% of holds: diag-holds.js)
  palletRunOn:   [0, 1, 0],        // >0.5: through a standing pallet, wait on the far side for a drop only while that beats running on
                                   // (P(it comes through) x the pallet's distance held vs the best route's gap + holdBiasM); else the old wait.
                                   // Default off: +0.04..0.06 kills at n=128 (more probe-tile laps though), fewer stuns in the shack duel
  holdBiasM:     [-10, 20, 10],    // m added to waiting (window / pallet) vs running on (the best route's min gap); holdMaxS stays a hard cap
  fcReactS:      [0, 1, 0.3],      // my reaction time to the hunter's vault / turn in that margin model
  // ---- strong loops: run farther to them, value the laps they hold ----
  strongTravelW: [0, 1.5, 0.5],    // extra path I'll run to a loop: + this x its expected distance held per chase (m per m)
  strongLoopW:   [0, 2, 0.3],      // route value of a loop: + this x (expected held per chase - one lap): more laps there
};

import { makeSlotPicker } from '../sim/slotpick.js';
import { HunterBelief } from './hunterbelief.js';
import { LoopModel } from './loops.js';
import { MapKnowledge } from './mapknow.js';
import { RouteEval } from './routes.js';
import { accelCosts } from './accel.js';
import { HunterForecast } from './hunterforecast.js';
import { RouteLookahead, lookaheadSpace, LOOKAHEAD_DOOM_M, LOOKAHEAD_NEAR_M } from './lookahead.js';
import { rescueSpace, makeRescuePlanner } from './rescue.js';
import { healSpace, makeHealPlanner } from './healplan.js';
import { kickSpace, makeKickPlanner } from './kickplan.js';
import { profileSpace, makeKillerProfile } from './killerprofile.js';
import { palletBreakInfo, withPalletGone, landingOnHunterSide, laneBlockedBy } from './tileplay.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);
// a point r m short of a teammate, on my side (never walk onto a teammate: bodies collide; heal reach is 1.6 m)
const approach = (t, me, r = 1.2) => { const dx = me.x - t.x, dz = me.z - t.z, L = Math.hypot(dx, dz) || 1; return { x: t.x + (dx / L) * r, z: t.z + (dz / L) * r }; };
function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return hyp(dx, dz);
}
// "at" a pallet = within the engine's drop reach (config.reach.pallet, 1.2 m) of its footprint, minus a small epsilon so
// float error never decides it (a loop side point sits 1.1 m from the footprint, which can come out as 1.1000000000000014)
const atPallet = (me, p, reach) => rectDist(me.x, me.z, p.x0, p.z0, p.x1, p.z1) <= reach - 1e-6;

export function makeSurvivor(P) {
  return (ctx) => {
    const M = ctx.map;
    // survivors don't know where the generators are: obs.gens[i] gets id / position / slots once found (engine).
    const loops = new LoopModel(ctx, { lineup: (P.vaultLineup ?? 0) > 0.5, approachM: P.vaultApproachM ?? 4, detourW: P.vaultDetourW ?? 1, funnelDeg: P.vaultFunnelDeg ?? 20, tierW: P.vaultAngleW ?? 1 });   // anchors + distance-held circuits (static parts lazily, once per match)
    const anchors = loops.anchors;
    const know = new MapKnowledge(ctx, anchors);  // explored area + anchors seen
    const routes = new RouteEval(loops, ctx);     // short-horizon distance held for open-field routes
    const ahead = new RouteLookahead(loops, know, ctx);   // next resource reachable from a flee destination + open ground
    const fc = new HunterForecast(ctx, loops, { learnS: P.fcLearnS });   // where the seen hunter is going (hunterforecast.js)
    const fcOn = P.fcLeadS > 0 || P.fcReverseP <= 1 || P.stationMode > 0.5;
    let fcCheckT = -99, fcLastSeenT = -99;
    let lastBreakT = -99;                         // last pallet break I saw (chain to the next tile)
    let routeT = -99, chaseStartT = -99, wasChasedR = false;
    // exploration pull toward unseen anchors that would complete a strong loop with anchors I already know
    let scoutMap = null, scoutKnownN = -1;
    const scoutBonus = (cell) => {
      if (P.loopScoutW <= 0) return 0;
      const kn = know.anchorKnown.reduce((a, b) => a + b, 0);
      if (kn !== scoutKnownN) {
        scoutKnownN = kn; scoutMap = new Map();
        for (const a of anchors) {
          if (know.anchorKnown[a.k]) continue;
          if (!anchors.some((b) => know.anchorKnown[b.k] && d2(a.c, b.c) < 16)) continue;
          let best = 0;
          for (const o of loops.circuitsFrom(2 * a.k)) if (o.seq.some((x) => (x >> 1) !== a.k && know.anchorKnown[x >> 1])) best = Math.max(best, o.fresh);
          const cl = know.cellAt(a.c.x, a.c.z);
          scoutMap.set(cl, Math.max(scoutMap.get(cl) || 0, P.loopScoutW * Math.min(1, best / 30)));
        }
      }
      return scoutMap.get(cell) || 0;
    };
    const exploreJit = Float32Array.from({ length: know.seen.length }, () => 0.15 * ctx.rng.next());   // own taste per area
    const detourOf = (a) => Math.max(0, loops.detour(a.k) - 3.2);
    const jitter = M.generators.map(() => ctx.rng.next());   // this survivor's own taste per gen (own seeded stream)
    let mode = 'work';          // work | chase | sneak
    let lastThreatT = -99;
    let circ = null;            // running loop: { seq, i, phase: 'toP' | 'cross', lockT, holdT }
    let cutSeenT = -1, cutLastT = -99;   // loopReverseDist: since when / last time the hunter was seen coming round the loop the other way
    let genTarget = -1;         // >= 0 gen index, -2 = exploring
    let exploreTo = null, exploreT = -99, genCommitT = -99, sneakGen = -1;
    const vaultCount = new Map(); let wasVaulting = false, lastChasedT = -99;   // window vaults in the current chase (entity blocker)
    let myVault = null;           // my vault in progress: { c (crossing), t }
    const occupiedUntil = new Map();   // anchor k -> time: the hunter is in / just cleared it (visible vault)
    const hunterVaultT = new Map();    // anchor k -> last time I saw the hunter mid-vault through it (re-vault rule: no fast vault for revaultNoFastS)
    let blT0 = 0;                 // Bloodlust clock start (chase start / my hit / observed pallet break)
    let prevMyState = 'healthy', prevPal = null;
    let brk = null, brkSeenT = -99;   // visible hunter pallet break this tick ({ i, remainS }) / last tick one was seen
    const slots = makeSlotPicker(ctx.config.reach.repairSlot);   // generator side slots (one repairer per side)
    let fleePoint = null, fleeT = -99;
    let sneakStart = -1;
    let helpSentT = -99, chaseSentT = -99;

    const anchorUsable = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] !== 'broken');
    const vaultsLeft = (obs) => (k) => { const a = anchors[k]; return obs.blockedWindows.includes(a.id) ? 0 : Math.max(0, 3 - (vaultCount.get(k) || 0)); };
    const palletState = (obs) => (k) => obs.pallets[anchors[k].i];

    // stealth: a spot near me the hunter can't see (cone + line of sight), cached ~1 s
    let hideSpot = null, hideT = -99, hiddenUntil = -99;
    function hunterCouldSee(api, h, pt) {
      const dx = pt.x - h.x, dz = pt.z - h.z, d = Math.hypot(dx, dz);
      if (d > 75) return false;
      const fx = Math.cos(h.facing), fz = Math.sin(h.facing);
      if (d > 1.5 && (dx * fx + dz * fz) < d * Math.cos((50 * Math.PI) / 180)) return false;   // outside its 100 deg cone
      return api.visibility(h, pt, !!pt.crouched) >= 0.5;   // pt.crouched: judged as a crouched body (obs.self.crouched / crouchHideW)
    }
    // a spot near me the hunter can't see (its cone + line of sight), not toward it; among those prefer peek spots
    // (body out of its line of sight whatever its facing, camera sees it) by peekW vs the walk there
    let hideLook = null, hidePeekV = 0;
    function findHide(obs, api, me, h) {
      if (hideSpot && obs.t - hideT < 1 && !hunterCouldSee(api, h, hideSpot)) return hideSpot;
      hideT = obs.t; hideSpot = null; hideLook = null; hidePeekV = 0;
      const tg = [{ x: h.x, z: h.z, p: 1 }, { x: h.x + (h.vx || 0) * 1.5, z: h.z + (h.vz || 0) * 1.5, p: 0.5 }];
      let best = null, bs = -Infinity, nFound = 0;
      const hkN = rescue.nearestHook(me);   // peek-spot score is ~1-scaled: the route bias enters at a tenth
      for (let rr = 2; rr <= P.peekMoveMaxM && nFound < 8; rr += 2) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * 2 * Math.PI, pt = { x: me.x + Math.cos(a) * rr, z: me.z + Math.sin(a) * rr, crouched: P.crouchHideW > 0.5 };
          if (hunterCouldSee(api, h, pt) || d2(pt, h) < d2(me, h) - 2) continue;   // hidden, and not toward the hunter
          if (!api.walkClear(me, pt)) continue;
          nFound++;
          const pv = P.peekW > 0 ? peekValue(api, pt, tg) : { v: 0, look: null };
          const sc = -rr / Math.max(2, P.peekMoveMaxM) + P.peekW * pv.v + 0.1 * rescue.fromHookTerm(me, hkN, pt);
          if (sc > bs) { bs = sc; best = pt; hideLook = pv.look; hidePeekV = pv.v; }
        }
      }
      hideSpot = best;
      return best;
    }

    // ---- hiding from an UNSEEN hunter: own belief map + static cover ----
    const belief = new HunterBelief(ctx, { spread: P.hbSpread });
    const beliefOn = P.hideThreat <= 1 || P.genThreatW > 0;   // otherwise only the terror trend is tracked
    const beliefFull = beliefOn || P.rescueCampFear > 0;       // the rescue's camp estimate needs the full belief update
    const rescue = makeRescuePlanner(ctx, P, belief);          // hooked teammates, teammate whereabouts, rescue utility
    const heal = makeHealPlanner(ctx, P, rescue.tracker);      // heal / pick-up choice + healer <-> patient handshake
    const prof = makeKillerProfile(ctx, P);                    // killer profile: own observations of the hunter's habits (killerprofile.js)
    // camera emulation (same rule as the engine): position for a yaw at body (x,z), pushed in by opaque cells
    const CAM = ctx.config.survivor.camera || { enabled: false };
    const camAt = (x, z, yaw) => {
      const lx = Math.cos(yaw), lz = Math.sin(yaw), side = CAM.side ?? 1, px = -lz * side, pz = lx * side;
      const dx = -lx * CAM.backM + px * CAM.shoulderM, dz = -lz * CAM.backM + pz * CAM.shoulderM, L = Math.hypot(dx, dz);
      const n = Math.max(1, Math.ceil(L / 0.1)), W = M.w, Hh = M.h;
      let free = L;
      for (let k = 1; k <= n; k++) {
        const i = Math.floor(x + dx * k / n), j = Math.floor(z + dz * k / n);
        if (i < 0 || j < 0 || i >= W || j >= Hh || belief.opq[j * W + i] === -2) { free = Math.max(0, L * (k - 1) / n - CAM.wallMarginM); break; }
      }
      if (free < CAM.minM) return { x, z };
      return { x: x + dx * free / L, z: z + dz * free / L };
    };
    // peek value of standing at c: body hidden from every target (any facing) and a camera aimed at the targets' centre
    // sees them; returns { v: seen mass share (0 if the body is exposed), look } — targets [{x, z, p}]
    function peekValue(api, c, targets) {
      if (!targets.length) return { v: 0, look: null };
      let tot = 0, cx = 0, cz = 0;
      for (const t of targets) { tot += t.p; cx += t.x * t.p; cz += t.z * t.p; }
      cx /= tot; cz /= tot;
      for (const t of targets) if (api.los(t, c)) return { v: 0, look: null };
      if (!CAM.enabled) return { v: 0, look: { x: cx, z: cz } };
      const base = Math.atan2(cz - c.z, cx - c.x);
      let best = 0, bl = null;
      for (const off of [0, 0.35, -0.35]) {
        const yaw = base + off, cam = camAt(c.x, c.z, yaw), cosF = Math.cos((CAM.fovDeg / 2) * Math.PI / 180);
        let m = 0;
        for (const t of targets) {
          const dx = t.x - cam.x, dz = t.z - cam.z, d = Math.hypot(dx, dz);
          if (d > 75 || (d > 0.5 && (dx * Math.cos(yaw) + dz * Math.sin(yaw)) < d * cosF)) continue;
          if (api.los(cam, t)) m += t.p;
        }
        if (m > best) { best = m; bl = { x: c.x + Math.cos(yaw) * 5, z: c.z + Math.sin(yaw) * 5 }; }
      }
      return { v: best / tot, look: bl };
    }
    const peekTargets = (obs) => {
      if (obs.hunter) { const h = obs.hunter; return [{ x: h.x, z: h.z, p: 1 }, { x: h.x + (h.vx || 0) * 1.5, z: h.z + (h.vz || 0) * 1.5, p: 0.5 }]; }
      if (beliefOn) return belief.topCells(4);
      return obs.lastHunter ? [{ x: obs.lastHunter.x, z: obs.lastHunter.z, p: 1 }] : [];
    };
    let peek = null;              // current peek: { spot, look, since }
    let hide = null;              // { start, lastTrig, spot, spotT }
    let hideCooldownUntil = -99;
    const stats = { decides: 0, hideTicks: 0, hides: 0, found: 0, chases: 0, peekTicks: 0, peeks: 0, peekFound: 0, loopReversals: 0, trustTicks: 0, taskGlances: 0, candExplores: 0, fcReversals: 0, fcLeaves: 0, holdLeaves: 0, stationTicks: 0, lineup: { revault: 0, funnel: 0, cost: 0, unsafe: 0, chosen: 0, dropped: 0, realign: 0 } };   // diagnostics (read by scripts via brain.stats)
    let wasChased = false, lastHideTickT = -99, lastPeekT = -99, wasChasedV = false;
    const kick = makeKickPlanner(ctx, P, { belief, peekValue, hunterCouldSee, slots, stats, beliefOn });   // kicked-gen plan (kickplan.js)
    const genCover = M.generators.map(() => null);   // per known gen: mean cover of its repair slots (lazy)
    const genCoverOf = (g, i) => {
      if (genCover[i] === null) { const sl = g.slots && g.slots.length ? g.slots : [g]; genCover[i] = sl.reduce((a, s) => a + belief.coverAt(s.x, s.z), 0) / sl.length; }
      return genCover[i];
    };
    let thrCache = { v: -1, x: 0, z: 0, val: 0 };
    const myThreat = (me) => {   // threatAt(me), recomputed only when the belief changed or I moved > 1 m
      if (thrCache.v !== belief.version || Math.abs(me.x - thrCache.x) + Math.abs(me.z - thrCache.z) > 1) thrCache = { v: belief.version, x: me.x, z: me.z, val: belief.threatAt(me, P.hideThreatR) };
      return thrCache.val;
    };
    function hideTrigger(obs, me, hysteresis) {
      const layer = obs.terror ? obs.terror.layer : 0;
      if (P.hideOnLayer >= 1 && layer >= P.hideOnLayer) return true;
      if (P.hideOnClosing > 0.5 && layer > 0 && belief.trend(obs.t, 4) > 0) return true;
      if (P.hideThreat <= 1) {
        let thr = P.hideThreat;
        if (me.act === 'repair' && genTarget >= 0) thr += P.hideProgSlack * obs.gens[genTarget].progress;
        if (hysteresis) thr *= 0.7;
        if (myThreat(me) >= thr) return true;
      }
      return false;
    }
    // visible teammates fleeing the hunter (fast, moving away from its known / estimated position, or HUD-chased):
    // their unit velocities. alignTo(c) = mean cos(angle between (c - me) and those velocities).
    function fleeingMates(obs, me) {
      if (P.followFleeW === 0 || !obs.teammates.length) return [];
      let hp = obs.hunter;
      if (!hp && obs.lastHunter && obs.t - obs.lastHunter.t < 10) hp = obs.lastHunter;
      if (!hp && beliefOn) hp = belief.expectedPos();
      if (!hp) hp = obs.lastHunter;
      const out = [];
      for (const t of obs.teammates) {
        const v = Math.hypot(t.vx || 0, t.vz || 0);
        if (v < 2.5) continue;
        const chased = obs.hud && obs.hud[t.id] && obs.hud[t.id].chased;
        const away = hp && (t.vx * (t.x - hp.x) + t.vz * (t.z - hp.z)) > 0;
        if (chased || away) out.push({ x: t.vx / v, z: t.vz / v });
      }
      return out;
    }
    // tightest group of up to 3 unfinished generators this survivor has actually found (obs.gens[i].known); never uses
    // positions of gens it hasn't seen. < 2 known: the nearest known one. Recomputed when the known/done set changes.
    let clusterKey = '', clusterC = null;
    function genCluster(obs, me) {
      const known = [];
      for (let i = 0; i < obs.gens.length; i++) { const g = obs.gens[i]; if (g.known && !g.done) known.push(g); }
      if (known.length < 2) return known.length ? known[0] : null;
      const key = known.map((g) => g.id).join(',');
      if (key === clusterKey) return clusterC;
      clusterKey = key;
      const k = Math.min(3, known.length);
      let best = null, bs = Infinity;
      for (let a = 0; a < known.length; a++) for (let b = a + 1; b < known.length; b++) {
        if (k === 2) { const sum = d2(known[a], known[b]); if (sum < bs) { bs = sum; best = [known[a], known[b]]; } continue; }
        for (let c = b + 1; c < known.length; c++) {
          const sum = d2(known[a], known[b]) + d2(known[a], known[c]) + d2(known[b], known[c]);
          if (sum < bs) { bs = sum; best = [known[a], known[b], known[c]]; }
        }
      }
      clusterC = { x: best.reduce((t, g) => t + g.x, 0) / best.length, z: best.reduce((t, g) => t + g.z, 0) / best.length };
      return clusterC;
    }
    const clusterAt = (cc, c) => (cc ? Math.max(0, 40 - d2(c, cc)) / 40 : 0);
    const alignTo = (fl, me, c) => {
      if (!fl.length) return 0;
      const dx = c.x - me.x, dz = c.z - me.z, L = Math.hypot(dx, dz);
      if (L < 0.5) return 0;
      let a = 0; for (const u of fl) a += (dx * u.x + dz * u.z) / L;
      return a / fl.length;
    };

    // hide-spot cover: standing cover, blended toward the crouched cover (low objects shadow a crouched body) by crouchHideW
    const coverOf = (pt) => {
      const cs = belief.coverAt(pt.x, pt.z);
      return P.crouchHideW > 0 ? cs + P.crouchHideW * (belief.coverAt(pt.x, pt.z, true) - cs) : cs;
    };
    // Crouch hook (applied to every decision, see decide()): crouch while holding a hidden spot (crouchHideW) and
    // crouch-walk stealth moves while the hunter is near (crouchSneakDist, at most crouchMaxS at a time). Off => unchanged.
    let crouchMoveS = 0, crouchPrevT = -99;
    function crouchPost(obs, a) {
      if (P.crouchHideW <= 0 && P.crouchSneakDist <= 0) return a;
      const me = obs.self, dt = Math.min(1, Math.max(0, obs.t - crouchPrevT));
      crouchPrevT = obs.t;
      if (!a || a.act || me.chased || mode === 'chase' || (me.state !== 'healthy' && me.state !== 'injured')) { crouchMoveS = 0; return a; }
      const holding = !!hide || obs.t < hiddenUntil;
      const tgt = a.moveTo || null, moving = !!(a.moveTo || a.moveDir);
      if (holding && P.crouchHideW > 0 && (!moving || (tgt && d2(tgt, me) < 1.5))) return { ...a, crouch: true };   // settle in / hold crouched
      if (moving && P.crouchSneakDist > 0 && (holding || mode === 'sneak')) {
        const h = obs.hunter, d = h ? d2(h, me) : obs.terror ? obs.terror.approx : Infinity;
        if (d < P.crouchSneakDist && crouchMoveS < P.crouchMaxS) { crouchMoveS += dt; return { ...a, crouch: true }; }
        if (d >= P.crouchSneakDist) crouchMoveS = 0;
        return a;
      }
      crouchMoveS = 0;
      return a;
    }

    function pickHideSpot(obs, api, me) {
      const fl = fleeingMates(obs, me);
      const cc = P.genClusterW !== 0 ? genCluster(obs, me) : null;
      const hkN = rescue.nearestHook(me);
      const R = P.hideMoveMaxM, W = M.w, Hh = M.h;
      const here = { x: me.x, z: me.z };
      if (R < 1.5) return here;
      const cands = [{ pt: here, d: 0 }];
      for (let rr = 2; rr <= R; rr += 2) {
        const n = Math.min(16, 6 + 2 * rr);
        for (let k = 0; k < n; k++) {
          const a = ((k + (rr % 4 ? 0.5 : 0)) / n) * 2 * Math.PI, x = me.x + Math.cos(a) * rr, z = me.z + Math.sin(a) * rr;
          const i = Math.floor(x), j = Math.floor(z);
          if (i < 0 || j < 0 || i >= W || j >= Hh || !belief.fine[j * W + i]) continue;
          cands.push({ pt: { x: i + 0.5, z: j + 0.5 }, d: rr });
        }
      }
      // cheap pre-score (cover - straight-line walk), then threat + path distance for the best few
      for (const c of cands) c.s = P.coverW * coverOf(c.pt) - 0.5 * c.d / R;
      cands.sort((a, b) => b.s - a.s);
      const top = beliefOn && P.exposeW > 0 ? belief.topCells(12) : null;
      // the hunter will come to check the generator I was working on: count it as a likely viewpoint too
      if (top && hide && hide.gen >= 0 && obs.gens[hide.gen].known) { const g = obs.gens[hide.gen], m = top.reduce((a, c) => a + c.p, 0); top.push({ x: g.x, z: g.z, p: m * P.hideGenFear }); }
      let best = here, bs = -Infinity, bestPv = { v: 0, look: null };
      const pts = peekTargets(obs);
      let tried = 0;
      for (const c of cands) {
        if (tried >= 6) break;
        if (c.d && !api.walkClear(me, c.pt)) continue;    // straight-line reachable only (cheap; no A*)
        tried++;
        const d = c.d;
        let s = P.coverW * coverOf(c.pt) - 0.5 * d / R - 2 * belief.threatAt(c.pt, P.hideThreatR);
        if (top) s -= P.exposeW * belief.exposure(api, c.pt, top, P.crouchHideW > 0.5);
        if (fl.length) s += P.followFleeW * 10 * alignTo(fl, me, c.pt);
        if (cc) s += P.genClusterW * 10 * clusterAt(cc, c.pt);
        if (hkN) s += rescue.fromHookTerm(me, hkN, c.pt);
        const pv = P.peekW > 0 && pts.length ? peekValue(api, c.pt, pts) : { v: 0, look: null };
        s += P.peekW * pv.v;
        if (hide && hide.spot && d2(c.pt, hide.spot) < 1.5) s += 0.1;     // keep the current spot unless clearly worse
        if (s > bs) { bs = s; best = c.pt; bestPv = pv; }
      }
      if (hide) { hide.look = bestPv.look; hide.peekV = bestPv.v; }
      return best;
    }

    function matesOnGens(obs) {
      const out = [];
      if (!obs.hud) return out;
      for (const x of obs.hud) {
        if (x.id === obs.self.id || x.activity !== 'repair') continue;
        const seen = obs.teammates.find((t) => t.id === x.id);
        const ls = obs.lastSeen[x.id];
        const pos = seen ?? (ls && obs.t - ls.t < 60 ? ls : null);
        if (pos) out.push({ x: pos.x, z: pos.z });
      }
      return out;
    }
    // distance to the map's outer wall (outline polygon), and the 0..1 "edge-ness" within 16 m of it
    const edgeDist = (pt) => {
      let best = Infinity; const o = M.outline;
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
        const ax = o[j][0], az = o[j][1], ex = o[i][0] - ax, ez = o[i][1] - az, L = ex * ex + ez * ez;
        const u = L > 0 ? Math.max(0, Math.min(1, ((pt.x - ax) * ex + (pt.z - az) * ez) / L)) : 0;
        best = Math.min(best, Math.hypot(ax + u * ex - pt.x, az + u * ez - pt.z));
      }
      return best;
    };
    const edgeness = (pt) => Math.max(0, 16 - edgeDist(pt)) / 16;
    const mateCloseness = (mates, c) => mates.reduce((a, m) => a + Math.max(0, 30 - d2(c, m)) / 30, 0);

    // ---- chase: run loops (circuits of windows / pallets) chosen by expected distance held (loops.js) ----
    const crossOK = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] !== 'broken') && !((occupiedUntil.get(a.k) ?? -1) > obs.t);
    // a visible standing teammate in the anchor's lane (within 1.5 m of the anchor or a side point): pick another
    const contested = (a, obs) => obs.teammates.some((t) => (t.state === 'healthy' || t.state === 'injured') && (d2(t, a.c) < 1.5 || d2(t, a.s[0]) < 1.2 || d2(t, a.s[1]) < 1.2));

    // ---- vault safety: 1D replay along the crossing axis (window at u = 0, my side u < 0) of my run-in + vault +
    // run-away vs the hunter closing in (it can't pass the window cell; it may also already be on the landing side),
    // with the real attack: plant within 90% range, windup (whole ticks) at lunge speed, hit if within range + margin.
    const HC = ctx.config.hunter, vS0 = ctx.config.survivor.runSpeed;
    // a window vault starts when my body is within R + 0.3 of the window cell (0.5 + 0.7 = 1.2 m from its centre); fast
    // needs a straight run-up of fastVaultRunupM (2.5 m) by then, + 0.2 m slack for steering
    const ACC = accelCosts(ctx.config), sAcc = ctx.config.survivor.accelMS2 ?? Infinity;   // re-acceleration after standing (accel.js)
    const SV = ctx.config.survivor, RUNUP_TO_CENTRE = (SV.fastVaultRunupM ?? 2.5) + 0.5 + (ctx.config.radius ?? 0.4) + 0.3 + 0.2;
    const range = HC.attackRange ?? 2.2, windup = Math.ceil((HC.windupS ?? 0.35) * 10 - 1e-9) / 10, lunge = HC.lungeSpeedMult ?? 1.5;
    function vaultSafe(a, c, me, hp, vH, tv, margin = P.vaultSafetyMarginM, hunterLead = 0) {
      const P0 = loops.sidePt[c], Q0 = loops.sidePt[c ^ 1];
      const ax = (Q0.x - P0.x) / 3.2, az = (Q0.z - P0.z) / 3.2;
      const u = (pt) => (pt.x - a.c.x) * ax + (pt.z - a.c.z) * az, w = (pt) => -(pt.x - a.c.x) * az + (pt.z - a.c.z) * ax;
      let us = Math.min(-1.0, u(me)), uh = u(hp) + hunterLead;
      let lat = Math.abs(w(hp));
      const hSide = uh < 0 ? -1 : 1, vS = me.boosted ? vS0 * 1.65 : vS0;
      const dt = 0.05, start = -1.0;
      let t = 0, tVault = -1, wind = -1, vNow = vS;
      for (let step = 0; step < 60; step++, t += dt) {
        // me
        if (tVault < 0) { us += vS * dt; if (us >= start) { us = start; tVault = t; } }
        else if (t - tVault < tv) { us = start + 2.0 * (t - tVault) / tv; vNow = tv <= (SV.vaultFastS ?? 0.5) + 1e-9 ? vS : 0; }
        else { vNow = Math.min(vS, vNow + sAcc * dt); us += vNow * dt; }   // a medium / slow vault lands at 0 and re-accelerates
        // hunter
        const du = us - uh, dist = Math.hypot(du, lat);
        const spd = wind >= 0 ? vH * lunge : vH;
        // the hunter closes in 2D: along the axis and sideways (it was only along the axis: a hunter coming from the
        // side never got close in the replay, so holding looked safe until it was on top of me)
        if (dist > 0.6) { const st = Math.min(dist - 0.6, spd * dt); uh += st * du / dist; lat -= st * lat / dist; if (hSide < 0) uh = Math.min(uh, -0.6); }
        if (wind < 0 && Math.hypot(us - uh, lat) <= 0.9 * range) wind = t;
        if (wind >= 0 && t - wind >= windup - 1e-9) return Math.hypot(us - uh, lat) > range + margin;
      }
      return true;
    }
    const fastTier = (c, from) => {          // will a vault of c started from `from` be fast (straight run-up >= 2.5 m)?
      const P0 = loops.sidePt[c], a = anchors[c >> 1];
      const vx = a.c.x - from.x, vz = a.c.z - from.z, L = Math.hypot(vx, vz) || 1;
      const ax = (loops.sidePt[c ^ 1].x - P0.x) / 3.2, az = (loops.sidePt[c ^ 1].z - P0.z) / 3.2;
      return L >= RUNUP_TO_CENTRE && (vx * ax + vz * az) / L >= Math.cos(((SV.fastVaultAngleDeg ?? 25) * Math.PI) / 180);
    };
    // fast-vault lineup for a running window crossing c (knobs vaultLineup / vaultApproachM / vaultDetourW / vaultFunnelDeg;
    // loops.lineup / inFunnel):
    // returns where to line up (my own position if I'm already in the funnel: run straight in), or null = take the entry
    // point (medium vault). The point is the lineup option angled toward me (loops.lineupExt). Lining up must be worth it (extra path x vaultDetourW < the 0.4 s a
    // fast vault saves, same rule as loops.tsIn prices circuits with) and stay safe (vaultSafe from the lineup point with
    // the hunter's lead over my run there); no lineup within revaultNoFastS of the hunter clearing the window (medium anyway)
    let lastWhy = null;   // diagnostics: why the last lineup decision went the way it did
    const lineupFor = (c, obs, me, hp, vH, lead, nav) => {
      const lu = loops.lineup[c];
      if (!lu) return null;
      const hv = hunterVaultT.get(c >> 1);
      if (hv !== undefined && obs.t - hv < (SV.revaultNoFastS ?? 2) + 0.2) { stats.lineup.revault++; lastWhy = 'revault'; return null; }
      if (loops.inFunnel(c, me)) { stats.lineup.funnel++; lastWhy = 'funnel'; return { x: me.x, z: me.z }; }
      const Pt = loops.sidePt[c], dP = nav.dist(me, Pt), x = loops.lineupExt(c, me, nav.dist(me, lu), dP);
      if (!x || !(x.ext < Infinity) || !loops.lineupWorth(x.ext)) { stats.lineup.cost++; lastWhy = 'cost'; return null; }
      // safety: no worse than the entry-point approach (both judged with the hunter's lead over my run there)
      const okL = vaultSafe(anchors[c >> 1], c, x, hp, vH, SV.vaultFastS ?? 0.5, P.vaultSafetyMarginM, lead(x.dT / vS0 + 0.3));
      if (!okL && vaultSafe(anchors[c >> 1], c, Pt, hp, vH, SV.vaultMediumS ?? 0.9, P.vaultSafetyMarginM, lead(dP / vS0 + 0.3))) { stats.lineup.unsafe++; lastWhy = 'unsafe'; return null; }
      stats.lineup.chosen++; lastWhy = 'chosen';
      return { x: x.x, z: x.z };
    };
    const hunterPos = (obs) => {             // visible hunter, else last sighting carried forward, else the belief's guess
      if (obs.hunter) return obs.hunter;
      const lh = obs.lastHunter;
      if (lh && obs.t - lh.t < 3) { const k = Math.min(1.5, obs.t - lh.t); return { x: lh.x + (lh.vx || 0) * k, z: lh.z + (lh.vz || 0) * k, vx: lh.vx, vz: lh.vz }; }
      return lh;   // (no belief guess here: fleeing from a wrong guess measured worse)
    };
    // entry race on the route fields (prepared by chooseRoute): path lengths around walls + the hunter's busy time
    // (pallet break), same loopRace margin; the Euclidean race above misjudges entries behind a wall
    const racePath = (Pt) => { const ds = routes.sDist(Pt.x, Pt.z), dh = routes.hDist(Pt.x, Pt.z); return ds < Infinity && ds < P.loopRace * dh; };
    // crossing c would land me on the hunter's side (path distances; nav.dist counts the hunter's vault / pallet costs)
    const landsBad = (api, me, hp, c) => {
      const Qt = loops.sidePt[c ^ 1];
      return landingOnHunterSide(api.nav.dist(me, Qt), api.nav.dist(hp, Qt) + (brk ? routes.vH0 * brk.remainS : 0), routes.reach);
    };
    function chooseCircuit(obs, api, me, hp, h, extra) {
      const vl = vaultsLeft(obs), ps = palletState(obs), R = P.loopTravelMaxM;
      const cands = [];
      for (const a of anchors) {
        if (!know.anchorKnown[a.k] || !crossOK(a, obs) || contested(a, obs) || d2(me, a.c) > R + 2 + P.strongTravelW * 45) continue;
        for (let d = 0; d < 2; d++) {
          const c = 2 * a.k + d, Pt = loops.sidePt[c];
          const dmE = d2(me, Pt), dhP = d2(hp, Pt);
          if (dmE > R + P.strongTravelW * 45 || !(dmE < P.loopRace * dhP) && !racePath(Pt)) continue;
          if (dmE > 1.5 && landsBad(api, me, hp, c)) continue;
          // the hunter is heading for it: it would cut us off there
          if (h && P.avoidHeading > 0.5) { const tx = Pt.x - h.x, tz = Pt.z - h.z, tl = Math.hypot(tx, tz) || 1; if ((h.vx * tx + h.vz * tz) / tl > 2.5 && dhP < dmE + 4) continue; }
          let best = null, be = 0;
          for (const o of loops.circuitsFrom(c)) {
            if (!o.seq.every((x) => crossOK(anchors[x >> 1], obs))) continue;
            // a useful partial plan: at most one anchor not seen yet (not the first): the camera will see it on the way
            const unk = o.seq.reduce((n, x) => n + (know.anchorKnown[x >> 1] ? 0 : 1), 0);
            if (unk > 1) continue;
            const ex = loops.expected(o, vl, ps) * (unk ? 0.6 : 1);
            if (ex > be) { be = ex; best = o; }
          }
          // strong loops: worth a longer run (strongTravelW m of extra path per m of expected distance held)
          if (best && dmE > R + P.strongTravelW * be) continue;
          if (best) cands.push({ o: best, ex: be, Pt, dhP, s: P.holdW * be - dmE + extra(Pt) });
        }
      }
      cands.sort((x, y) => y.s - x.s);
      return cands.slice(0, 4);
    }
    const newCirc = (c, obs) => ({ seq: c.o.seq.slice(), i: 0, phase: 'toP', lockT: obs.t + 1, holdT: 0, chosenT: obs.t, lap: c.o.lap, crossed: 0 });
    // ~1.3 Hz: where to run. Open points in 12 directions (at run speed x horizon) vs known loop entries, each scored by
    // the min survivor-hunter path gap (routes.js); loops add holdW x their distance held per lap if reached in time.
    // dry = { holdK }: evaluate only (no plan change), without pure holds at anchor holdK and without the current plan:
    // returns the best route value (the "run on" option when deciding whether to keep waiting at a window)
    function chooseRoute(obs, api, me, hp, h, extra, dry = null) {
      const chaseS = me.chased ? obs.t - blT0 : 0;
      // forecast lead: the seen hunter keeps its forecast course for fcLeadS, then pursues (pure pursuit at 0)
      let hpR = hp, delay = brk ? brk.remainS : 0;
      if (P.fcLeadS > 0 && h && !brk && !h.vaulting) { const pr = fc.predict(obs, api, me, P.fcLeadS); if (pr) { hpR = pr; delay = P.fcLeadS; } }
      if (!routes.prepare(obs, me, hpR, chaseS, delay)) return dry ? null : false;
      const Hz = P.holdHorizonS, r0 = Math.min(30, Math.max(6, routes.vS * Hz * 0.5));   // first leg ~ half the horizon
      // route lookahead (lookahead.js), in a chase only: open flee points also count the next resource I can still
      // reach from there and the bare ground before it (pallet broken just now: chainAfterBreakW on top)
      const laW = P.routeLookaheadW + (obs.t - lastBreakT < 6 ? P.chainAfterBreakW : 0);
      const useLA = me.chased && (laW > 0 || P.openGroundPenalty > 0) && P.lookaheadMaxM > 0 &&
        ahead.begin(obs, me, r0 + P.lookaheadMaxM + 2, (a) => crossOK(a, obs) && !contested(a, obs), (a) => anchorUsable(a, obs), vaultsLeft(obs), palletState(obs)) > 0;
      let best = null, bs = -Infinity;
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * 2 * Math.PI, ux = Math.cos(ang), uz = Math.sin(ang);
        let T = null;
        // farthest point along the ray that I can reach by a near-straight path (path <= 1.3 x straight): a wall or
        // corner ahead shortens the run, and the rollout then shows the gap collapsing there
        for (let r = 2; r <= r0; r += 2) {
          const x = me.x + ux * r, z = me.z + uz * r;
          if (!routes.reachable(x, z) || routes.sDist(x, z) > 1.3 * r + 2) break;
          T = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 };
        }
        if (!T) continue;
        const ro = routes.rollout(T.x, T.z, Hz, false, true, me);
        if (!ro) continue;
        let v = ro.gap + extra(T);
        // the lookahead weighs in as far as this route's own gap collapses within the horizon (doom 1 at <= 0 m, 0 from
        // LOOKAHEAD_DOOM_M up: a route that holds the gap all the way needs no rescue plan), and only for real flee
        // points (0 within LOOKAHEAD_NEAR_M of me, full 4 m farther: a point I reach at once is my position, and
        // re-planning on arrival then flip-flops between nearby points)
        const doom = useLA ? Math.min(1, Math.max(0, 1 - ro.gap / LOOKAHEAD_DOOM_M)) * Math.min(1, Math.max(0, (d2(me, T) - LOOKAHEAD_NEAR_M) / 4)) : 0;
        if (doom > 0) { const la = ahead.nextResource(routes, T, P.lookaheadMaxM); v += doom * (laW * la.v - P.openGroundPenalty * la.open); }
        if (!dry && !circ && fleePoint && d2(T, fleePoint) < 6) v += 2;   // hysteresis
        if (circ) v -= 2;                                                  // leaving a loop for open ground: needs a clear win
        if (v > bs) { bs = v; best = { kind: 'open', T, g: ro.gap }; }
      }
      // loops: roll out to the far side of the first crossing (my field includes the vault, the hunter's its vault /
      // break / detour), so the crossing's own gain counts
      for (const c of chooseCircuit(obs, api, me, hp, h, extra)) {
        if (dry && c.o.seq.every((x) => (x >> 1) === dry.holdK)) continue;  // waiting there is the other option
        if (!dry && obs.t < noHoldUntil && c.o.seq.every((x) => (x >> 1) === noHoldK)) continue;   // just left that wait
        const Qt = loops.sidePt[c.o.seq[0] ^ 1];
        const ro = routes.rollout(Qt.x, Qt.z, 15, true);
        if (!ro || ro.arrive * routes.vS > (P.loopTravelMaxM + P.strongTravelW * c.ex) * 1.3) continue;
        // a loop reached in time adds its distance held per lap, and strong loops (more laps left in the vault budget)
        // add strongLoopW x the rest of their expected distance held
        let v = ro.gap + (ro.gap > 0 ? P.holdW * c.o.lap + P.strongLoopW * Math.max(0, c.ex - c.o.lap) : 0) + extra(c.Pt);
        if (!dry && circ && circ.seq[circ.i] === c.o.seq[0]) v += 1;       // hysteresis
        if (v > bs) { bs = v; best = { kind: 'loop', c, g: ro.gap }; }
      }
      if (dry) return best ? { v: bs, g: best.g, best } : null;
      if (circ && circ.phase === 'toP') {                                  // the loop I'm already running to
        const Qt = loops.sidePt[circ.seq[circ.i] ^ 1], ro = routes.rollout(Qt.x, Qt.z, 15, true);
        if (ro) { const v = ro.gap + (ro.gap > 0 ? P.holdW * circ.lap : 0) + extra(Qt) + 1.5; if (v > bs) { bs = v; best = { kind: 'keep' }; } }
      }
      if (!best) return false;
      if (best.kind === 'open') { circ = null; fleePoint = best.T; fleeT = obs.t; }
      else if (best.kind === 'loop' && !(circ && circ.seq[circ.i] === best.c.o.seq[0])) { circ = newCirc(best.c, obs); fleePoint = null; }
      return true;
    }
    function reverseCirc(obs) {
      const k = circ.seq.length, prevIdx = (circ.i - 1 + k) % k;
      const rev = circ.seq.slice().reverse().map((c) => c ^ 1);
      // the crossing I just did, backwards, comes next (or, mid-crossing, the current one backwards)
      circ.i = circ.phase === 'cross' ? k - 1 - circ.i : k - 1 - prevIdx;
      circ.seq = rev; circ.phase = 'toP'; circ.lockT = obs.t + 1.5;
    }

    // at a standing pallet with the hunter coming: drop now vs keep it for later, by distance held.
    //   drop  = the pallet's distance held (hunter breaks or walks around) + a stun (2 s of hunter running) if the hunter
    //           will be in the stun zone when the drop lands (0.3 s);
    //   save  = gap now + one more lap of this loop with the pallet left standing; if that stays > 0 I can keep it:
    //           value = that lap + palletGreed x the pallet's distance held (worth having later).
    // Drop when saving gets me caught, or the drop beats saving by 1 m; then stunSeek times it (wait for a stun vs early).
    function palletDecision(obs, a, hp, h, me, dhm) {
      const vH = routes.hunterSpeed(me.chased ? obs.t - blT0 : 0);
      const gain = loops.palletGain(a.k);
      const p = a.p, al = ctx.config.hunter.palletStunAlongM ?? 1, axisX = p.axis === 'x';
      const hx = hp.x + (h ? h.vx * 0.3 : 0), hz = hp.z + (h ? h.vz * 0.3 : 0);
      const inStun = axisX ? (hx >= p.x0 - al && hx <= p.x1 + al && hz >= p.z0 && hz <= p.z1) : (hz >= p.z0 - al && hz <= p.z1 + al && hx >= p.x0 && hx <= p.x1);
      const dropV = gain + (inStun ? (ctx.config.hunter.palletStunS ?? 2) * vH : 0);
      const g = dhm - 2.0;
      const lapOpen = circ ? loops.evaluate(circ.seq, new Set([a.k])).lap : -Infinity;
      const saveGap = g < 1 ? -1 : g + Math.min(0, lapOpen);
      const saveV = saveGap > 0 ? lapOpen + prof.palletGreed(P.palletGreed) * gain : -Infinity;   // [killer profile] respect / abandon read
      if (!(saveGap <= 0 || dropV > saveV + 1)) return 'save';
      if (inStun) return 'drop';
      if (d2(hp, a.c) < 2.2 + (1 - prof.stunSeek(P.stunSeek)) * 4 || g < 1.5) return 'drop';   // [killer profile] runner: hold for the stun
      return 'wait';
    }

    // ---- forecast helpers ----
    // P(the forecast hunter is within its swing reach + fcEntryMarginM of crossing c's entry when I get there)
    function entryDanger(obs, api, me, c) {
      const Pt = loops.sidePt[c], dMe = api.nav.dist(me, Pt);
      if (!(dMe < Infinity)) return 1;
      const br = fc.branches(obs, api, me, dMe / routes.vS);
      if (!br) return 0;
      const R = routes.reach + P.fcEntryMarginM;
      let p = 0;
      for (const b of br) { if (Math.hypot(b.x - Pt.x, b.z - Pt.z) <= R && api.nav.dist(b, Pt) <= R) p += b.w; }
      return p;
    }
    // where to wait on my side of window a (crossing c = going back over it). Spots on the crossing axis at r m from the
    // window centre, valued in metres of margin under the forecast's P(through / around / stand):
    //   through: it vaults over to me; I run when I see it start:  r - 1 + vS * (vault - fcReactS) - reach
    //   around : it walks round; I vault back (fast from >= the run-up distance, else medium); it has to come back the
    //            cheaper of vaulting / walking round:              min(vault * vH, detour) - vH * (vault time + (r - 1.6) / vS)
    //   stand  : it waits on the far side:                         its path to the spot - reach
    // through / around also get the hunter's own path to the window (it has to get there first).
    let stationCache = null, noHoldK = -1, noHoldUntil = -99, leaveT = -99;
    function stationPlan(obs, api, me, h, hp, a, c, vH) {
      if (stationCache && stationCache.k === a.k && stationCache.c === c && obs.t - stationCache.t < 0.25) return stationCache;
      const P0 = loops.sidePt[c], Q0 = loops.sidePt[c ^ 1], ux = (P0.x - Q0.x) / 3.2, uz = (P0.z - Q0.z) / 3.2;
      const cm = fc.commit(obs, api, me, a, P0, Q0) || { through: 0.5, around: 0.5, stand: 0 };
      const hV = (HC.vaultS ?? 1.7) + ACC.hVaultLoss, vS = routes.vS, reach = routes.reach;   // + the hunter's re-acceleration after its vault
      const D = loops.detour(a.k), hw = Math.max(0, api.nav.dist(hp, a.c) - 1.6);
      let best = null;
      for (const r of [1.6, 2.6, 3.9]) {
        const S = { x: a.c.x + ux * r, z: a.c.z + uz * r };
        if (loops.solid[Math.floor(S.z) * M.w + Math.floor(S.x)] || (d2(me, S) > 0.5 && !api.walkClear(me, S))) continue;
        const tv = r >= RUNUP_TO_CENTRE - 0.05 ? (SV.vaultFastS ?? 0.5) : (SV.vaultMediumS ?? 0.9) + ACC.sLoss;   // medium: + re-acceleration
        const mThrough = hw + (r - 1) + vS * Math.max(0, hV - P.fcReactS) - reach;
        const mAround = hw + Math.min(hV * vH, D) - vH * (tv + Math.max(0, r - 1.6) / vS);
        const mStand = api.nav.dist(hp, S) - reach;
        const v = cm.through * mThrough + cm.around * mAround + cm.stand * mStand + (r < 2 ? 0 : -0.05 * r);
        if (!best || v > best.v) best = { S, v, r };
      }
      stationCache = best ? { ...best, k: a.k, c, t: obs.t } : { S: P0, v: 0, r: 1.6, k: a.k, c, t: obs.t };
      return stationCache;
    }
    // waiting at window a vs running on (the best route without a pure hold there), every 0.5 s: leave when running
    // on is worth more than the wait's expected margin + holdBiasM (then no pure hold at a for 3 s)
    function leaveHold(obs, api, me, hp, h, extra, a, station) {
      if (obs.t - leaveT < 0.5) return false;
      leaveT = obs.t;
      const r = chooseRoute(obs, api, me, hp, h, extra, { holdK: a.k });
      if (!r || !(r.g > station.v + P.holdBiasM)) return false;
      stats.holdLeaves++;
      noHoldK = a.k; noHoldUntil = obs.t + 3;
      circ = null; routeT = obs.t; chooseRoute(obs, api, me, hp, h, extra);
      return true;
    }

    function chase(obs, api, me, h, depth = 0) {
      if (depth > 3) return null;
      // the visible hunter is breaking a pallet: that pallet is as good as gone, and the break time is mine to run
      // (tileplay.js); a break that just started forces a re-plan instead of waiting behind the pallet
      brk = palletBreakInfo(obs, M, ctx.config);
      if (brk) { obs = withPalletGone(obs, brk.i); if (brkSeenT < obs.t - 0.25) routeT = -99; brkSeenT = obs.t; lastBreakT = obs.t; }
      // the visible hunter's body stands in a dropped pallet's lane (bodies collide: I can't get through it):
      // busy for now (not standing pallets: a hunter there is what a stun drop is for; windows: A/B'd worse)
      if (h && !h.vaulting) for (const a of anchors) if (a.kind === 'p' && obs.pallets[a.i] === 'dropped' && laneBlockedBy(h, a)) { occupiedUntil.set(a.k, Math.max(occupiedUntil.get(a.k) ?? -1, obs.t + 0.5)); if (circ && circ.seq.some((x) => (x >> 1) === a.k)) routeT = -99; }
      const mates = P.chaseToMatesW !== 0 ? matesOnGens(obs) : [];
      const fl = fleeingMates(obs, me);
      const cc = P.genClusterW !== 0 ? genCluster(obs, me) : null;
      const hp = hunterPos(obs);
      if (!hp) return null;
      if (fcOn) { fc.update(obs, api, me, circ ? loops.sidePt[circ.seq[circ.i] ^ 1] : fleePoint); if (h) fcLastSeenT = obs.t; }
      // mid-vault: committed until landing (no re-planning); keep pushing through
      if (me.vaulting) { const c = myVault ? myVault.c : null; return c !== null ? { moveTo: loops.sidePt[c ^ 1] } : {}; }
      const hk = rescue.nearestHook(me);
      const extra = (pt) => rescue.fromHookTerm(me, hk, pt) + P.chaseToMatesW * 10 * mateCloseness(mates, pt) - P.edgeAvoidW * 10 * edgeness(pt) + P.followFleeW * 10 * alignTo(fl, me, pt) + P.genClusterW * 10 * clusterAt(cc, pt);
      const dhm = d2(hp, me);
      if (circ && !circ.seq.every((x) => crossOK(anchors[x >> 1], obs))) circ = null;
      if (circ && circ.phase === 'toP' && d2(me, loops.sidePt[circ.seq[circ.i]]) > P.loopTravelMaxM + 8) circ = null;
      // re-plan at ~1.3 Hz (hunter in sight) unless I'm at / in a loop crossing (commit to it)
      // once I'm in a loop (made a crossing, at / in a crossing, or the hunter is close) the loop runner decides;
      // route evaluation picks how to start: which loop to run to, or open ground
      const committed = circ && (circ.crossed > 0 || circ.phase === 'cross' || d2(me, loops.sidePt[circ.seq[circ.i]]) <= 3 || dhm < 8);
      if (circ && circ.crossed > 0 && loops.expected({ seq: circ.seq, lap: circ.lap, lapNP: circ.lap }, vaultsLeft(obs), palletState(obs)) <= 0) circ = null;   // loop used up
      if (!committed && ((h && obs.t - routeT >= 0.75) || (!circ && !fleePoint))) { routeT = obs.t; chooseRoute(obs, api, me, hp, h, extra); }   // ~1.3 Hz while the hunter is in sight
      if (circ) {
        const c = circ.seq[circ.i], a = anchors[c >> 1], Pt = loops.sidePt[c], Qt = loops.sidePt[c ^ 1];
        // the hunter is vaulting this window (visible): if it comes to my side, run the next leg now; if it goes away
        // from me the window is busy (crossOK marks it occupied) -> re-plan
        if (h && h.vaulting && h.vault && a.kind === 'w' && h.vault.window === a.id) {
          const toMe = Math.hypot(h.vault.toX - me.x, h.vault.toZ - me.z) < Math.hypot(h.vault.fromX - me.x, h.vault.fromZ - me.z);
          if (toMe && circ.seq.length > 1) { circ.i = (circ.i + 1) % circ.seq.length; circ.phase = 'toP'; circ.holdT = 0; circ.lockT = obs.t + 1; return chase(obs, api, me, h, depth + 1); }
          circ = null; return chase(obs, api, me, h, depth + 1);
        }
        // the hunter is nearer my next entry than I am (it cut ahead / is on the far side): run the loop the other way
        const hP = api.nav.dist(hp, Pt), hQ = api.nav.dist(hp, Qt);   // path distances (fields to fixed points get cached)
        if (circ.phase === 'toP' && obs.t >= circ.lockT && hP + 0.5 < api.nav.dist(me, Pt) && hQ > hP && circ.seq.length > 1) { reverseCirc(obs); if (landsBad(api, me, hp, circ.seq[circ.i])) { circ = null; routeT = -99; } return chase(obs, api, me, h, depth + 1); }
        // mind game: the hunter (seen now) commits to the other way round -- moving toward my next crossing (either
        // side), nearer to it than to me (so it is not just following me) and within loopReverseDist of it: after
        // loopReactS of seeing that, reverse
        // (not for a hold crossing -- back over the anchor I just crossed: a hunter following me there heads for it too)
        const nk = circ.seq.length, prevC = circ.seq[(circ.i - 1 + nk) % nk];
        const revD = prof.reverseDist(P.loopReverseDist), revS = prof.reactS(P.loopReactS);   // [killer profile] mind-game read
        if (revD > 0) {
          let cutting = false;
          if (circ.phase === 'toP' && nk > 1 && (prevC >> 1) !== (c >> 1) && h && !h.vaulting) {
            const X = hP <= hQ ? Pt : Qt, hX = Math.min(hP, hQ), tx = X.x - h.x, tz = X.z - h.z, tl = Math.hypot(tx, tz);
            const toward = tl < 1 || ((h.vx || 0) * tx + (h.vz || 0) * tz) / tl > 1.0;
            cutting = toward && hX < revD && hX + 1 < api.nav.dist(hp, me);
          }
          // the seen-for clock restarts whenever the sighting breaks (unseen, other phase / crossing, not cutting)
          if (!cutting || (cutSeenT >= 0 && obs.t - cutLastT > 0.25)) cutSeenT = cutting ? obs.t : -1;
          else if (cutSeenT < 0) cutSeenT = obs.t;
          if (cutting) cutLastT = obs.t;
          if (cutting && obs.t - cutSeenT >= revS - 1e-9 && obs.t >= circ.lockT) {
            cutSeenT = -1; stats.loopReversals++; reverseCirc(obs);
            if (landsBad(api, me, hp, circ.seq[circ.i])) { circ = null; routeT = -99; }
            return chase(obs, api, me, h, depth + 1);
          }
        }
        // forecast: P(the hunter is at my next entry by the time I get there) -- it is cutting me off (a pursuer that
        // follows me never is); the other way round is clearly safer -> reverse; both ways covered -> leave the loop
        if (fcOn && P.fcReverseP <= 1 && circ.phase === 'toP' && nk > 1 && (prevC >> 1) !== (c >> 1) && obs.t >= circ.lockT && obs.t - fcLastSeenT < 1 && obs.t - fcCheckT >= 0.2 && d2(me, Pt) > 1.2) {
          fcCheckT = obs.t;
          const pBad = entryDanger(obs, api, me, c);
          if (pBad >= P.fcReverseP) {
            const revNext = prevC ^ 1, pRev = entryDanger(obs, api, me, revNext);
            if (pRev < pBad - 0.2) {
              stats.fcReversals++; reverseCirc(obs);
              if (landsBad(api, me, hp, circ.seq[circ.i])) { circ = null; routeT = -99; }
              return chase(obs, api, me, h, depth + 1);
            }
            if (pBad >= 0.95 && d2(me, Pt) > 3) { stats.fcLeaves++; circ = null; routeT = -99; return chase(obs, api, me, h, depth + 1); }
          }
        }
        if (circ.phase === 'toP') {
          // running crossing (a real leg leads into it): keep the momentum for a fast vault while the hunter is on us;
          // hold crossing (zero leg: mind-game at one anchor): wait at the entry until the hunter is close
          const kk = circ.seq.length, legIn = loops.L(circ.seq[(circ.i - 1 + kk) % kk] ^ 1, c);
          // the first crossing of a new plan with the hunter on me is a running crossing too (no stop-and-hold)
          const running = (legIn >= 2 || circ.crossed === 0) && dhm < 20;
          const vH = routes.hunterSpeed(me.chased ? obs.t - blT0 : 0);
          const lead = (dt) => -(vH * dt) * Math.sign((hp.x - a.c.x) * (loops.sidePt[c ^ 1].x - Pt.x) + (hp.z - a.c.z) * (loops.sidePt[c ^ 1].z - Pt.z) || 1);
          const isUp = a.kind === 'p' && obs.pallets[a.i] === 'up';
          // fast-vault approach (running window crossing): decided when the crossing becomes the next one (the earlier I
          // head for the lineup, the shorter the detour), dropped if the lineup stops being safe; in the funnel -> straight in
          let inFunnel = false;
          const luKey = c * 4096 + circ.crossed;
          // (re-checked every 0.3 s while too costly and still on the way: off -> on only, so it never flip-flops)
          const reLu = circ.luKey === luKey && circ.lineup !== c && circ.luWhy === 'cost' && obs.t - circ.luT >= 0.3 && d2(me, Pt) > 2;
          if (loops.lineup[c] && running && (circ.luKey !== luKey || reLu)) {
            const L = lineupFor(c, obs, me, hp, vH, lead, api.nav);
            if (!reLu) { circ.luKey = luKey; circ.luPt = L; circ.lineup = L ? c : null; circ.luWhy = lastWhy; }
            else if (L) { circ.luPt = L; circ.lineup = c; circ.luWhy = 'late'; }
            circ.luT = obs.t;
          }
          if (circ.luKey !== luKey) circ.luWhy = a.kind !== 'w' ? null : !loops.lineup[c] ? 'nolane' : 'notRunning';
          if (circ.lineup === c && circ.luKey === luKey && running) {
            inFunnel = loops.inFunnel(c, me);
            const lu = circ.luPt;
            // close to the lineup point and no longer safe from there (the hunter cut in): take the entry instead
            if (!inFunnel && d2(me, lu) < 4 && !vaultSafe(a, c, lu, hp, vH, SV.vaultFastS ?? 0.5, P.vaultSafetyMarginM, lead(d2(me, lu) / vS0 + 0.3))) { circ.lineup = null; stats.lineup.dropped++; circ.luWhy = 'dropped'; }
            else if (!inFunnel) return { moveTo: lu };
          }
          // after a vault, waiting to go back over this window (stationMode): the spot on my side with the best expected
          // margin against the forecast hunter (vault-back vs run-round), and whether waiting beats running on at all
          const station = P.stationMode > 0.5 && !running && legIn < 2 && circ.crossed > 0 && a.kind === 'w' ? stationPlan(obs, api, me, h, hp, a, c, vH) : null;
          if (!station && !inFunnel && d2(me, Pt) > (running ? 1.6 : 0.8)) return { moveTo: Pt };
          // at the entry: cross when the hunter is close behind; otherwise hold here (mind-game) for a while
          const pressing = h && dhm < 16 && ((h.vx * (me.x - h.x) + h.vz * (me.z - h.z)) / Math.max(0.1, dhm)) > 1.0;
          const onMySide = hP <= hQ;
          // hunter on the far side: run the loop the other way if that leads elsewhere, else hold here
          if (!onMySide && obs.t >= circ.lockT && circ.seq.length > 1) {
            const k = circ.seq.length;
            const revNext = circ.seq[(circ.i - 1 + k) % k] ^ 1;
            if (loops.sidePt[revNext] !== Pt) { reverseCirc(obs); if (landsBad(api, me, hp, circ.seq[circ.i])) { circ = null; routeT = -99; } return chase(obs, api, me, h, depth + 1); }
          }
          // vault safety (real attack envelope): go while a vault is still safe; a hold ends before it stops being
          // safe (the hunter 0.3 s closer); a window the hunter cleared moments ago (clearance) is not re-vaulted
          const tv = a.kind === 'w' ? (fastTier(c, me) || inFunnel ? 0.5 : 0.9) : 1.1;
          // a hold ends the moment waiting 0.3 s longer would make the vault unsafe (real attack envelope); waiting
          // after that only gets worse, so then go at once
          const safeSoon = isUp ? true : vaultSafe(a, c, me, hp, vH, tv, P.vaultSafetyMarginM, lead(0.3));
          const goNow = onMySide && (running || isUp || dhm < P.vaultDist || !safeSoon);
          if (goNow) { circ.phase = 'cross'; circ.holdT = 0; }
          else {
            circ.holdT = pressing ? 0 : circ.holdT + api.dt * (ctx.config.decisionEvery || 1);
            if (circ.holdT > P.holdMaxS) { circ = null; if (!me.chased) return null; routeT = -99; return chase(obs, api, me, h, depth + 1); }
            if (station) {
              if (leaveHold(obs, api, me, hp, h, extra, a, station)) return chase(obs, api, me, h, depth + 1);
              stats.stationTicks++;
              return { moveTo: station.S, face: hp };
            }
            return { moveTo: Pt, face: hp };
          }
        }
        // crossing
        if (a.kind === 'p' && obs.pallets[a.i] === 'up') {
          const p = a.p;
          const near = atPallet(me, p, ctx.config.reach.pallet ?? 1.2);
          const ms = d2(Pt, me) <= d2(Qt, me) ? 'P' : 'Q', hs = hP <= hQ ? 'P' : 'Q';
          if (near && (hs === 'P' || dhm < 2.5) && dhm < 12) {
            const dec = palletDecision(obs, a, hp, h, me, dhm);
            if (dec === 'drop') return { act: 'dropPallet', target: p.id };
            if (dec === 'save' && ms === 'Q') {               // keep the pallet standing and run the loop on
              circ.i = (circ.i + 1) % circ.seq.length; circ.phase = 'toP'; circ.holdT = 0; circ.crossed++;
              return chase(obs, api, me, h, depth + 1);
            }
          }
          if (d2(me, Qt) > 0.8) return { moveTo: Qt };
          // through, pallet still up: wait on the far side for the hunter to come close, then drop
          circ.holdT += api.dt * (ctx.config.decisionEvery || 1);
          if (circ.holdT > P.holdMaxS + 2) { circ = null; if (!me.chased) return null; routeT = -99; return chase(obs, api, me, h, depth + 1); }
          // stationMode: waiting here only while it beats running on. Waiting pays the pallet's distance held (+ a
          // stun) if the hunter comes through to me; a hunter that goes round or stands off just costs me the wait
          // (worth nothing); running on keeps the pallet for later (route value)
          if (P.palletRunOn > 0.5) {
            const cm = fc.commit(obs, api, me, a, Qt, Pt) || { through: 0.5, around: 0.5, stand: 0 };
            const vWait = cm.through * loops.palletGain(a.k);
            if (leaveHold(obs, api, me, hp, h, extra, a, { v: vWait })) return chase(obs, api, me, h, depth + 1);
          }
          return { moveTo: Qt, face: hp };
        }
        // windows / dropped pallets: run through (the engine vaults); the circuit advances on my observed landing
        // a lined-up window run: straight at the window face (moveDir) while still out in the lane, so the run-up
        // stays one straight line (the nav would bend it through the approach cell centre)
        if (a.kind === 'w' && circ.lineup === c && circ.luKey === c * 4096 + circ.crossed) {
          if (loops.straightIn(c, me)) {
            const ap = loops.aimPt(c), dx = ap.x - me.x, dz = ap.z - me.z, dl = Math.hypot(dx, dz) || 1;
            // the engine keeps the run-up's FIRST heading until a turn > fastVaultAngleDeg: entering the run with a
            // smaller turn from an off-axis heading would keep that heading (an "angled" medium vault). Then one short
            // step (< 60% of a stride resets the run-up) so the run-up restarts on this straight line; once per crossing
            const vl = Math.hypot(me.vx || 0, me.vz || 0), cone = Math.cos((((SV.fastVaultAngleDeg ?? 25) - 3) * Math.PI) / 180);
            const q = loops.laneUW(c, me), nx = -q.ux, nz = -q.uz;
            if (circ.realign !== circ.luKey && vl > 1) {
              circ.realign = circ.luKey;
              const vx = me.vx / vl, vz = me.vz / vl;
              if (vx * nx + vz * nz < cone && (vx * dx + vz * dz) / dl > Math.cos((((SV.fastVaultAngleDeg ?? 25) + 2) * Math.PI) / 180)) { stats.lineup.realign++; return { moveTo: { x: me.x + (0.12 * dx) / dl, z: me.z + (0.12 * dz) / dl } }; }
            }
            return { moveDir: { x: dx, z: dz } };
          }
        }
        if (d2(me, Qt) > 0.8 && !(d2(me, Qt) < d2(me, Pt) - 1.5)) return { moveTo: Qt };
        circ.i = (circ.i + 1) % circ.seq.length; circ.phase = 'toP'; circ.holdT = 0; circ.crossed++;
        return chase(obs, api, me, h, depth + 1);
      }
      // open flee (route chosen above); fallback when the route fields are unusable: a far, reachable point
      if (fleePoint && d2(me, fleePoint) < 1.5) fleePoint = null;
      if (!fleePoint && obs.t - fleeT > 1) {
        fleeT = obs.t;
        let bs = -Infinity;
        const cands = [...obs.gens.filter((g) => g.known), ...M.hooks, ...anchors.filter((a) => know.anchorKnown[a.k] && anchorUsable(a, obs) && d2(a.c, me) < 30).map((a) => ({ x: a.c.x, z: a.c.z, q: detourOf(a) }))];
        for (const c of cands) {
          const s = d2(c, hp) - 0.6 * d2(c, me) + P.holdW * 0.3 * Math.min(30, c.q ?? 0) + extra(c);
          if (d2(c, hp) < d2(me, hp)) continue;
          if (s > bs) { bs = s; fleePoint = { x: c.x, z: c.z }; }
        }
      }
      if (fleePoint) return { moveTo: fleePoint };
      return { moveDir: { x: me.x - hp.x, z: me.z - hp.z } };
    }

    // shortest closed tour through 3 of the generators I've found that are still unfinished, leaving out gen `skip`
    // (Infinity with fewer than 3): how compact a three-gen the remaining known gens make. Known positions only.
    function knownTriTour(gens, skip) {
      const k = [];
      for (let i = 0; i < gens.length; i++) { const g = gens[i]; if (i !== skip && g.known && !g.done && !g.blocked) k.push(g); }
      let best = Infinity;
      for (let a = 0; a < k.length; a++) for (let b = a + 1; b < k.length; b++) for (let c = b + 1; c < k.length; c++)
        best = Math.min(best, d2(k[a], k[b]) + d2(k[b], k[c]) + d2(k[a], k[c]));
      return best;
    }

    // ---- exploring toward public generator-candidate wrecks (candidateSearchW): the best unresolved candidate by
    // P(gen) - distance (+ jitter, - a teammate nearer to it), as a walkable point ~2 m short of the wreck on my side
    // (the wreck itself is solid; within 2.5 m body awareness resolves it whatever the camera does)
    // own taste per candidate: a hash of (my id, candidate) - no extra rng draws, so knobs at 0 replay the old streams
    const candJit = (k) => (((k + 1) * 2654435761 + (ctx.id + 1) * 40503) >>> 0) % 1000 / 1000;
    function candTarget(obs, api, me) {
      if (know.nUnres <= 0) return null;
      const near = (c) => obs.teammates.some((t) => Math.hypot(c.x - t.x, c.z - t.z) < Math.hypot(c.x - me.x, c.z - me.z) - 2);
      const k = know.pickCand(me, P.exploreRadM, (k) => 0.3 * candJit(k) - (near(know.cands[k]) ? 0.5 : 0));
      if (k === null) return null;
      const c = know.cands[k];
      for (const r of [2, 1.6, 2.4]) for (let s = 0; s < 8; s++) {
        const a = Math.atan2(me.z - c.z, me.x - c.x) + (s % 2 ? 1 : -1) * Math.ceil(s / 2) * (Math.PI / 4);
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        if (isFinite(api.nav.dist(me, { x, z })) && !loops.solid[Math.floor(z) * M.w + Math.floor(x)]) return { x, z, cand: k };
      }
      return null;
    }

    // ---- where the camera looks (if the action didn't say): the hunter if seen (slightly ahead), where it should be if
    // just lost, the belief's guess when it's close / the terror radius is heard; otherwise along my path (default) with
    // glances (glanceRate) toward the likeliest hunter cells or sweeping around
    let glanceUntil = -99, nextGlance = 0, glanceLook = null, sweepYaw = ctx.rng.next() * 6.283;
    // taskGlanceS: in work mode (not chased, hunter not seen for 5 s) every taskGlanceS s look ~1.2 s at the nearest
    // unresolved candidate wreck in line of sight within MapKnowledge's candSeeR: that's how unfound gens get found
    let taskUntil = -99, nextTask = 0, taskLook = null;
    function taskGlance(obs, api) {
      const me = obs.self;
      if (P.taskGlanceS <= 0 || mode !== 'work' || me.chased || !api || know.nUnres <= 0) return null;
      if (obs.t < taskUntil && taskLook && know.candRes[taskLook.k] === 0) return taskLook;
      if (obs.t < nextTask) return null;
      nextTask = obs.t + 0.5;                               // nothing in view: try again shortly
      let best = null, bd = know.candSeeR;
      for (let k = 0; k < know.cands.length; k++) {
        if (know.candRes[k]) continue;
        const c = know.cands[k], d = Math.hypot(c.x - me.x, c.z - me.z);
        if (d < 2.5 || d >= bd || !api.los(me, c)) continue;   // (within 2.5 m body awareness sees it anyway)
        bd = d; best = { x: c.x, z: c.z, k };
      }
      if (!best) return null;
      taskLook = best; taskUntil = obs.t + 1.2; nextTask = obs.t + P.taskGlanceS; stats.taskGlances++;
      return best;
    }
    function withLook(obs, a, api) {
      if (!CAM.enabled || !a || a.look) return a;
      const me = obs.self, h = obs.hunter;
      const L = (x, z) => ({ ...a, look: { x, z } });
      if (h) return L(h.x + (h.vx || 0) * 0.4, h.z + (h.vz || 0) * 0.4);
      const lh = obs.lastHunter;
      if (lh && obs.t - lh.t < 5) { const k = Math.min(2, obs.t - lh.t); return L(lh.x + (lh.vx || 0) * k, lh.z + (lh.vz || 0) * k); }
      if (me.state === 'downed' || me.state === 'carried' || me.state === 'hooked') return a;
      const tg = taskGlance(obs, api);
      if (tg) return L(tg.x, tg.z);
      if (beliefOn && (obs.terror || myThreat(me) > 0.3)) { const e = belief.expectedPos(); if (e) return L(e.x, e.z); }
      if (obs.t < glanceUntil && glanceLook) return L(glanceLook.x, glanceLook.z);
      if (obs.t >= nextGlance) {
        const top = beliefOn ? belief.topCells(3) : [];
        if (top.length && ctx.rng.next() < 0.5) glanceLook = top[ctx.rng.int(top.length)];
        else { sweepYaw += 2.1; glanceLook = { x: me.x + 5 * Math.cos(sweepYaw), z: me.z + 5 * Math.sin(sweepYaw) }; }
        glanceUntil = obs.t + 1.0;
        nextGlance = obs.t + 1.0 + (1 - P.glanceRate) * 9 + 0.5;
        return L(glanceLook.x, glanceLook.z);
      }
      // standing still (repairing / healing / holding): keep facing the work; the engine keeps the yaw
      return a;
    }

    // body-blocked by a teammate (moving, no progress, a teammate within 1.2 m) for 0.6 s: sidestep for 0.5 s
    let blockedT = 0, sideUntil = -99, sideDir = null;
    function unblock(obs, a) {
      const me = obs.self;
      if (obs.t < sideUntil && sideDir) return { moveDir: sideDir };
      const mt = a && a.moveTo;
      const mate = obs.teammates.find((t) => d2(t, me) < 1.2 && (t.state === 'healthy' || t.state === 'injured'));
      if (!mt || a.act || d2(mt, me) < 1 || !mate || Math.hypot(me.vx, me.vz) > 0.3) { blockedT = 0; return a; }
      if (circ && d2(me, loops.sidePt[circ.seq[circ.i]]) < 4) { blockedT = 0; return a; }   // in a vault lane: re-plan, don't sidestep
      blockedT += (ctx.config.decisionEvery || 1) / (ctx.config.tickHz || 10);
      if (blockedT < 0.6) return a;
      blockedT = 0; sideUntil = obs.t + 0.5;
      const gx = mt.x - me.x, gz = mt.z - me.z, L = Math.hypot(gx, gz) || 1;
      const sgn = ((mate.x - me.x) * -gz + (mate.z - me.z) * gx) > 0 ? -1 : 1;   // step to the side away from the teammate
      sideDir = { x: (-gz / L) * sgn + (gx / L) * 0.3, z: (gx / L) * sgn + (gz / L) * 0.3 };
      return { moveDir: sideDir };
    }

    // per-decision bookkeeping (belief / map knowledge / chase + vault tracking); called first by every decide
    function observe(obs, api) {
      const me = obs.self;
      belief.update(obs, api, 2.0, beliefFull);   // heavy belief step every 2 s (sightings, hooks, auras, layer changes apply at once)
      stats.decides++;
      if (me.chased && !wasChased) { stats.chases++; if (obs.t - lastHideTickT < 5) stats.found++; if (obs.t - lastPeekT < 5) stats.peekFound++; }   // chase on me began within 5 s of hiding
      wasChased = !!me.chased;
      know.update(obs, api, 1.0);
      if (me.chased && !wasChasedR) chaseStartT = obs.t;
      wasChasedR = !!me.chased;
      // window vaults in the current engine chase (entity blocker: 3 vaults of one window per chase; a new chase - my
      // chase music starting again - restarts the count; blocks themselves expire via obs.blockedWindows)
      if (me.chased && !wasChasedV) { vaultCount.clear(); blT0 = obs.t; fc.reset(); }
      if (me.chased) lastChasedT = obs.t;
      wasChasedV = !!me.chased;
      // Bloodlust resets on a hit and on a pallet break (observed)
      if (me.state !== prevMyState && (me.state === 'injured' || me.state === 'downed')) blT0 = obs.t;
      prevMyState = me.state;
      if (prevPal && obs.pallets.some((st, i) => st === 'broken' && prevPal[i] !== 'broken')) { blT0 = obs.t; lastBreakT = obs.t; }
      prevPal = obs.pallets.slice();
      // visible hunter vaults: that window is occupied now and for vaultClearanceS after
      if (obs.hunter && obs.hunter.vaulting && obs.hunter.vault && obs.hunter.vault.window) {
        const a = anchors.find((x) => x.kind === 'w' && x.id === obs.hunter.vault.window);
        if (a) { occupiedUntil.set(a.k, obs.t + 0.3 + P.vaultClearanceS); hunterVaultT.set(a.k, obs.t); }
      }
      // my own vaults = real crossings: the circuit follows what actually happened (auto-vaults included)
      if (me.vaulting && !wasVaulting) {
        let bk = -1, bd = 2.6;
        for (const a of anchors) if (a.kind === 'w' || obs.pallets[a.i] === 'dropped') { const d = d2(a.c, me); if (d < bd) { bd = d; bk = a.k; } }
        if (bk >= 0) {
          const a = anchors[bk], c = 2 * bk + (d2(me, a.s[0]) <= d2(me, a.s[1]) ? 0 : 1);
          myVault = { c, t: obs.t };
          if (me.chased && a.kind === 'w') vaultCount.set(bk, (vaultCount.get(bk) || 0) + 1);
          if (circ) {
            let idx = circ.seq.indexOf(c);
            if (idx < 0 && circ.seq.indexOf(c ^ 1) >= 0) { circ.seq = circ.seq.slice().reverse().map((x) => x ^ 1); idx = circ.seq.indexOf(c); }
            if (idx >= 0) { circ.i = idx; circ.phase = 'cross'; }
            else circ = null;                                // a crossing that isn't in the plan: re-plan after landing
          }
        }
      }
      if (!me.vaulting && wasVaulting && myVault) {
        if (circ && circ.seq[circ.i] === myVault.c && circ.phase === 'cross') {
          circ.i = (circ.i + 1) % circ.seq.length; circ.phase = 'toP'; circ.holdT = 0; circ.crossed++; circ.lockT = Math.max(circ.lockT, obs.t + 0.6);
        }
        myVault = null;
      }
      wasVaulting = !!me.vaulting;
    }

    // endgame: open a gate and leave (action, or null when no gate is usable)
    function gateStep(obs, api, holdProtection) {
      const me = obs.self, nav = api.nav;
      if (obs.gatesPowered) {
        let best = null, bd = Infinity;
        for (const g of obs.gates) {
          const gd = M.exitGates.find((x) => x.id === g.id);
          let d = nav.dist(me, g.open ? gd.exit : gd.lever);
          if (!g.open && obs.teammates.some((t) => d2(t, gd.lever) < 1.6) && d2(me, gd.lever) > 1.6) d += 60; // lever taken: one opener per lever
          if (d < bd) { bd = d; best = { g, gd }; }
        }
        if (best) {
          const { g, gd } = best;
          if (g.open) return { moveTo: gd.exit };
          if (d2(gd.lever, me) <= 1.4 && !holdProtection) return { act: 'openGate', target: g.id };
          return { moveTo: gd.lever };
        }
      }
      return null;
    }

    // generators (only the ones I've found) vs exploring for more. only: undefined (combined choice) | 'gen' | 'explore'
    function workStep(obs, api, walk, holdProtection, only, wctx) {
      const me = obs.self, h = obs.hunter, nav = api.nav;
      const dh = h ? d2(h, me) : Infinity;
      const busyElsewhere = !!(wctx && wctx.busyElsewhere);   // the cascade passes its 'hunter busy with a teammate' read; goal brains don't (finishRiskW only)
      if (only === 'gen' && genTarget === -2) { genTarget = -1; exploreTo = null; }
      if (only === 'explore' && genTarget >= 0) genTarget = -1;
        const gens = obs.gens;
        if (genTarget >= 0 && (gens[genTarget].done || gens[genTarget].blocked || !gens[genTarget].known)) genTarget = -1;
        const unknownGens = gens.reduce((n, g) => n + (g.known ? 0 : 1), 0);
        const exploreLeft = unknownGens > 0 && know.fraction() < 0.98;
        if (exploreTo && (d2(me, exploreTo) < 3 || obs.t - exploreT > 25 || (exploreTo.cand >= 0 ? know.candRes[exploreTo.cand] !== 0 : know.explored(exploreTo.x, exploreTo.z)))) exploreTo = null;
        if (genTarget === -2 && !exploreTo) genTarget = -1;
        if (genTarget === -1 || obs.tick % 50 === 0) {
          let bs = Infinity, bi = -1;
          // repairersTargetW: teammates I last saw repairing a gen, still repairing per the HUD (anchored MateTracker fix)
          const anch = P.repairersTargetW !== 0 ? rescue.tracker.repairFixes() : null;
          const repairingCur = me.act === 'repair' && genTarget >= 0;
          // remainingClusterW: min closed 3-gen tour over the known unfinished gens, with and without each candidate gen
          const triBase = P.remainingClusterW > 0 ? knownTriTour(gens, -1) : Infinity;
          // finishRiskW: only while nobody's on me and the hunter isn't seen coming at me (else safety first)
          const finishOK = P.finishRiskW > 0 && !me.chased && (!h || busyElsewhere || dh > P.fleeSeenDist);
          for (let i = 0; i < gens.length; i++) {
            const g = gens[i];
            if (!g.known || g.done || g.blocked || only === 'explore') continue;
            let s = P.genDistW * nav.dist(me, g) / 20 - P.genProgW * g.progress * 3;
            const others = g.workers ? g.workers.filter((w) => w !== me.id).length : 0;   // only for gens currently seen
            // visible teammates standing at it (not yet repairing) or running toward it: they'll take it
            let headed = 0;
            for (const t of obs.teammates) {
              if (g.workers && g.workers.includes(t.id)) continue;
              const dx = g.x - t.x, dz = g.z - t.z, dg = Math.hypot(dx, dz), v = Math.hypot(t.vx || 0, t.vz || 0);
              if (dg < 4 || (dg < 40 && v > 1 && (t.vx * dx + t.vz * dz) > 0.9 * v * dg && dg < d2(g, me) + 6)) headed++;
            }
            s += P.spreadW * (others + headed);
            if (anch && !g.workers) { let n = 0; for (const f of anch) if (Math.abs(f.x - g.x) < 2.5 && Math.abs(f.z - g.z) < 2.5) n++; s += P.repairersTargetW * n; }
            const hpos = h ?? (obs.lastHunter && obs.t - obs.lastHunter.t < 90 ? obs.lastHunter : null);
            if (hpos) s -= P.farFromHunterW * Math.min(60, d2(g, hpos)) / 20;
            s += P.genJitter * jitter[i];
            if (obs.lastHunter && obs.t - obs.lastHunter.t < 60) s += P.hunterAvoidW * Math.max(0, 25 - d2(g, obs.lastHunter)) / 10;
            if (P.genCoverW !== 0) s -= P.genCoverW * 3 * genCoverOf(g, i);
            if (P.genThreatW > 0 && beliefOn) s += P.genThreatW * 3 * belief.pHunterWithin(g, 24);
            if (finishOK && g.progress > 0) {
              let danger = 0;
              if (hpos) danger += P.farFromHunterW * (3 - Math.min(60, d2(g, hpos)) / 20);
              if (obs.lastHunter && obs.t - obs.lastHunter.t < 60) danger += P.hunterAvoidW * Math.max(0, 25 - d2(g, obs.lastHunter)) / 10;
              if (P.genThreatW > 0 && beliefOn) danger += P.genThreatW * 3 * belief.pHunterWithin(g, 24);
              s -= Math.min(1, P.finishRiskW * g.progress) * danger;
            }
            if (isFinite(triBase)) { const tr = knownTriTour(gens, i); if (isFinite(tr)) s -= P.remainingClusterW * (Math.min(150, tr) - Math.min(150, triBase)) / 30; }
            if (i === genTarget) s -= 0.5 + (repairingCur ? P.repairAbandonMarginS / 5 : 0); // hysteresis (+ abandon cost: 1 unit ~ 20 m ~ 5 s of running)
            if (s < bs) { bs = s; bi = i; }
          }
          // explore option: always when no gen is known; otherwise a propensity that grows with the gens still unfound
          const committed = bi >= 0 && genTarget >= 0 && obs.t - genCommitT < P.genCommitS;
          if (exploreLeft && only !== 'gen' && (bi < 0 || (P.exploresMap > 0 && !committed))) {
            if (!exploreTo && P.candidateSearchW > 0) { exploreTo = candTarget(obs, api, me); exploreT = obs.t; }
            if (!exploreTo) { exploreTo = know.pickTarget(me, P.exploreRadM, (c) => exploreJit[c] + scoutBonus(c) - (obs.teammates.some((t) => Math.hypot(know.cx[c] - t.x, know.cz[c] - t.z) < Math.hypot(know.cx[c] - me.x, know.cz[c] - me.z) - 2) ? 0.3 : 0)); exploreT = obs.t; }
            if (exploreTo) {
              let se = P.genDistW * d2(me, exploreTo) / 20 + 1.5 - P.exploresMap * (1 + 3 * unknownGens / gens.length);
              if (exploreTo.cand >= 0) se -= P.candidateSearchW * know.candP();   // a likely gen spot is worth more than a generic area
              if (genTarget === -2) se -= 0.5;
              if (me.act === 'repair' && bi >= 0) se += 1 + P.repairAbandonMarginS / 5;      // don't walk off a gen I'm repairing on a whim
              if (bi < 0 || se < bs) { bs = se; bi = -2; }
            }
          }
          if (bi !== -2) exploreTo = genTarget === -2 && bi >= 0 ? null : exploreTo;
          if (bi >= 0 && bi !== genTarget) genCommitT = obs.t;
          if (bi === -2 && genTarget !== -2 && exploreTo && exploreTo.cand >= 0) stats.candExplores++;
          genTarget = bi;
        }
        if (genTarget >= 0) return slots.act(obs, genTarget, gens[genTarget], { walk, hold: holdProtection });
        if (genTarget === -2 && exploreTo) return { moveTo: exploreTo, walk };
        return only ? null : {};
    }

    return {
      stats,
      // diagnostics only (scripts/diag-fastvault.js): the loop runner's current crossing, null when not running a loop
      get chaseDbg() { return circ ? { phase: circ.phase, c: circ.seq[circ.i], crossed: circ.crossed, lineup: circ.lineup ?? null, luWhy: circ.luWhy ?? null } : null; },
      know,
      loops,
      belief,
      rescue,
      heal,
      profile: prof,
      // motor skills + the state they share, for brains that pick goals themselves (survivor-goal.js); the cascade
      // below doesn't use this object
      skills: {
        observe, workStep, gateStep, chase, findHide, pickHideSpot, hunterCouldSee, hunterPos, unblock, withLook, myThreat, slots, routes, beliefOn, beliefFull,
        get mode() { return mode; }, set mode(v) { mode = v; },
        get circ() { return circ; }, set circ(v) { circ = v; },
        get hide() { return hide; }, set hide(v) { hide = v; },
        get hiddenUntil() { return hiddenUntil; }, set hiddenUntil(v) { hiddenUntil = v; },
        get genTarget() { return genTarget; }, set genTarget(v) { genTarget = v; },
        get exploreTo() { return exploreTo; },
      },
      decide(obs, api) {
        let a = this.decideInner(obs, api);
        const st = obs.self.state;
        if (st === 'healthy' || st === 'injured') a = crouchPost(obs, unblock(obs, a));
        return withLook(obs, a, api);
      },
      decideInner(obs, api) {
        const me = obs.self, h = obs.hunter, nav = api.nav;
        prof.update(obs);                            // [killer profile] own observations (HUD-only while hooked / carried)
        // hooked brains are called now (minimal obs): take the Resolve self-unhook when offered (was automatic before)
        if (me.state === 'hooked') return me.canSelfUnhook ? { act: 'selfUnhook' } : {};
        if (me.state === 'carried') return { act: 'wiggle' };
        observe(obs, api);
        if (me.state === 'downed') {
          // crawl out through an open gate if one is close
          if (obs.gates) for (const g of obs.gates) {
            if (!g.open) continue;
            const gd = M.exitGates.find((x) => x.id === g.id);
            if (gd && nav.dist(me, gd.exit) < 30) return { moveTo: gd.exit };
          }
          // otherwise lie still to recover (to 95%) unless the hunter is close
          if (h && d2(h, me) < P.downedStillDist) return { moveDir: { x: me.x - h.x, z: me.z - h.z } };
          return {};
        }
        const canSay = !(me.intentCooldownS > 0);
        const say = (a, msg) => (canSay ? { ...a, intent: msg } : a);

        // ---- HUD bookkeeping ----
        const hud = obs.hud || null;
        rescue.update(obs);
        heal.update(obs);
        const otherChased = !!hud && hud.some((x) => x.id !== me.id && x.chased);

        // ---- threat state ----
        const dh = h ? d2(h, me) : Infinity;
        // otherChaseTrustDist: the HUD shows the hunter chasing a teammate, I'm not chased, I can see it, it's farther than
        // the trust distance and not closing on me (velocity toward me < 1.5 m/s): it's busy - keep working. Already in chase
        // mode: only past trust + 4 m (hysteresis: no chase/work flip-flop at the threshold)
        const busyElsewhere = !!h && !me.chased && otherChased && P.otherChaseTrustDist < 40 && dh > P.otherChaseTrustDist + (mode === 'chase' ? 4 : 0) &&
          ((h.vx || 0) * (me.x - h.x) + (h.vz || 0) * (me.z - h.z)) < 1.5 * Math.max(dh, 1e-6) && !(h.carrying);
        if (busyElsewhere) stats.trustTicks++;
        // a teammate is healing me: stand still (healing needs an idle patient) unless the hunter is close
        if (hud && hud[me.id] && hud[me.id].beingHealed && !(h && dh < 10)) return {};
        // hiding / holding out of view and the hunter appears but can't see me (and isn't close): don't bolt (running is what starts a chase)
        if ((hide || obs.t < hiddenUntil) && h && !me.chased && dh >= P.hideNerveM && !hunterCouldSee(api, h, me)) {
          if (hide) { hide.lastTrig = obs.t; stats.hideTicks++; lastHideTickT = obs.t; }
          if (!api.los(h, me)) { stats.peekTicks++; if (obs.t - lastPeekT > 3) stats.peeks++; lastPeekT = obs.t; }
          return { look: { x: h.x + (h.vx || 0) * 0.5, z: h.z + (h.vz || 0) * 0.5 } };   // frozen, watching it
        }
        if (me.chased) { mode = 'chase'; lastThreatT = obs.t; }      // chase music: the hunter is on me even if I can't see it
        else if (h && dh < prof.fleeSeenDist(obs, P.fleeSeenDist) && !busyElsewhere)   /* [killer profile] after my unhook vs a tunneller */ { mode = 'chase'; lastThreatT = obs.t; }
        else if (busyElsewhere && mode === 'chase' && obs.t - lastChasedT > P.calmS) { mode = 'work'; circ = null; }   // it's busy with a teammate: back to work now
        else if (!h && obs.terror !== null && obs.terror.approx < prof.fleeTR(obs, P.fleeTR) && !(otherChased && P.trustChase > 0.5) && !(mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS)) {
          if (mode !== 'chase' && mode !== 'sneak') { mode = 'sneak'; sneakStart = obs.t; }
          lastThreatT = obs.t;
        }
        else if (mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS) { mode = 'work'; circ = null; }
        else if (obs.t - lastThreatT > P.calmS) { mode = 'work'; circ = null; }

        // ---- kicked / threatened gen (kickplan.js): hide near it and return once the hunter leaves, or leave ----
        kick.note(obs, genTarget);
        {
          const threat = mode === 'sneak' || mode === 'chase' || (!!h && dh < P.hideDist && hunterCouldSee(api, h, me));
          const ka = kick.decide(obs, api, threat);
          if (kick.active) genTarget = kick.gen;
          if (ka) return ka;
        }

        // ---- stealth: the hunter is around but not on me -> get out of its view (and back to work once it's gone) ----
        if (mode !== 'chase' && h && dh < P.hideDist && !me.chased && !busyElsewhere) {
          if (hunterCouldSee(api, h, me)) {
            const spot = findHide(obs, api, me, h);
            if (spot) { hiddenUntil = obs.t + P.hideHoldS; return { moveTo: spot, walk: P.hideWalk > 0.5, look: h }; }
          } else if (obs.t < hiddenUntil) {                   // out of view: hold still and watch it pass (peek)
            if (!api.los(h, me)) { stats.peekTicks++; if (obs.t - lastPeekT > 3) stats.peeks++; lastPeekT = obs.t; }
            return { look: { x: h.x + (h.vx || 0) * 0.5, z: h.z + (h.vz || 0) * 0.5 } };
          }
        }

        if (mode === 'chase') {
          const a = chase(obs, api, me, h);
          if (a) { if (me.chased && obs.t - chaseSentT > 30) { chaseSentT = obs.t; return say(a, 'chasingMe'); } return a; }
          if (me.chased) {                                   // chase music: never relax into work / sneak
            const hp = hunterPos(obs);
            if (hp) return { moveDir: { x: me.x - hp.x, z: me.z - hp.z } };
          }
          mode = 'sneak'; sneakStart = obs.t;
        }

        // ---- hide from an unseen hunter that my belief / the terror radius says is close or closing in ----
        if (mode === 'chase' || h || me.chased || obs.gatesPowered) {
          hide = null;
        } else {
          const trig = hideTrigger(obs, me, !!hide);
          if (trig && !hide && obs.t >= hideCooldownUntil) { hide = { start: obs.t, lastTrig: obs.t, spot: null, spotT: -99, gen: me.act === 'repair' || (genTarget >= 0 && obs.gens[genTarget].known && d2(me, obs.gens[genTarget]) < 4) ? genTarget : -1 }; stats.hides++; }
          if (hide) {
            if (trig) hide.lastTrig = obs.t;
            if (obs.t - hide.lastTrig > P.hideStayS) hide = null;
            else if (obs.t - hide.start > P.hideMaxS) { hide = null; hideCooldownUntil = obs.t + 10; }
          }
          if (hide) {
            stats.hideTicks++; lastHideTickT = obs.t;
            if (!hide.spot || obs.t - hide.spotT >= 2) { hide.spot = pickHideSpot(obs, api, me); hide.spotT = obs.t; }
            const lk = hide.look || (beliefOn ? belief.expectedPos() : null);
            if (hide.peekV > 0.2) { stats.peekTicks++; if (!hide.peeked) { hide.peeked = true; stats.peeks++; } lastPeekT = obs.t; }
            if (d2(me, hide.spot) > 0.6) return { moveTo: hide.spot, walk: P.coverRun <= 0.5 };
            return lk ? { look: lk } : {};
          }
        }
        const walk = P.walkWhenTR > 0.5 && obs.terror !== null;

        // ---- Deep Wound: mend (stand still) unless the hunter is close ----
        if (me.deepWoundS !== null && me.deepWoundS !== undefined && !(h && dh < P.mendRiskDist)) return { act: 'mend' };
        // ---- fresh off the hook: keep the protections (no conspicuous actions) for a while ----
        const holdProtection = me.protectedS !== null && me.protectedS !== undefined && me.protectedS > 10 - P.protectHoldS;

        // ---- endgame: open a gate and leave ----
        if (obs.gatesPowered) { const ga = gateStep(obs, api, holdProtection); if (ga) return ga; }

        if (mode === 'sneak') {
          // move away from the last sighting toward the farthest unfinished gen
          const ref = obs.lastHunter ?? me;
          let far = null, fd = -Infinity;
          for (let i = 0; i < obs.gens.length; i++) {
            const g = obs.gens[i];
            if (!g.known || g.done || g.blocked) continue;
            const d = d2(g, ref) - 0.3 * d2(g, me) + (i === sneakGen ? 3 : 0);   // hysteresis: two near-equal gens flipped every tick
            if (d > fd) { fd = d; far = i; }
          }
          sneakGen = far ?? -1;
          if (far !== null) return slots.act(obs, far, obs.gens[far], { walk, hold: holdProtection });
        }

        // ---- altruism: rescue (utility: am I the closest, stage urgency, camping, busy hunter, claims, own risk; rescue.js) ----
        if (P.altruism > 0.25) {
          const ra = rescue.decide(obs, api, { holdProtection, say, beliefFull, profileTerm: prof.rescueTerm() });   // [killer profile] camper / leaver
          if (ra) return ra;
        }

        // ---- injured: a visible teammate said "healing" and is coming to me -> pause and be healed (healplan.js) ----
        const pa = heal.patient(obs);
        if (pa) return pa;

        // ---- injured: go get healed by a visible healthy teammate ----
        if (me.state === 'injured' && P.seekHeal > 0.5 && !h) {
          const mate = obs.teammates.filter((t) => t.state === 'healthy').sort((a, b) => d2(a, me) - d2(b, me))[0];
          if (mate && d2(mate, me) < P.healDist) {
            if (d2(mate, me) <= 1.5) return obs.t - helpSentT > 20 ? (helpSentT = obs.t, say({}, 'help')) : {};
            return { moveTo: approach(mate, me) };
          }
        }

        // ---- heal teammates / pick up downed ones (priorities, threat, gen progress, handshake: healplan.js) ----
        if (P.altruism > 0.15) {
          const ha = heal.healer(obs, { healDist: prof.healDist(P.healDist), holdProtection, say, joinGen: (gi) => slots.act(obs, gi, obs.gens[gi], { walk: false, hold: holdProtection }) });
          if (ha) return ha;
        }

        // ---- generators (only the ones I've found) vs exploring for more ----
        return workStep(obs, api, walk, holdProtection, undefined, { busyElsewhere });
      },
      // ---- viewer debug layers (viewer/layers.js): read-only snapshot of existing state as plain copies; never called by
      // the sim, mutates nothing a decision reads (the opt-in parts only fill deterministic lazy memos). t = match time.
      debug(t = 0, opts = {}) {
        const cp = (o) => (o ? { ...o } : null);
        const goal = circ ? loops.sidePt[circ.seq[circ.i]] : fleePoint;
        const out = {
          id: ctx.id, mode, genTarget, exploreTo: cp(exploreTo), fleePoint: cp(fleePoint), fleeT, routeT, brk: cp(brk), hide: hide ? { ...hide, spot: cp(hide.spot) } : null,
          circ: circ ? { ...circ, seq: circ.seq.slice(), pts: circ.seq.map((x) => [loops.sidePt[x], loops.sidePt[x ^ 1]]), anchors: circ.seq.map((x) => loops.anchors[x >> 1].id) } : null,
          myVault: myVault ? { t: myVault.t, c: myVault.c } : null, goal: cp(goal),
          route: goal ? { W: routes.W, cells: routes.path(goal.x, goal.z) } : null,
          know: { W: know.W, H: know.H, cs: know.cs, open: Uint8Array.from(know.open), seen: Uint8Array.from(know.seen), fraction: know.fraction(),
            anchors: loops.anchors.map((a, k) => ({ id: a.id, kind: a.kind, x: a.c.x, z: a.c.z, known: !!know.anchorKnown[k] })) },
          hb: { W: belief.W, H: belief.H, cs: belief.cs, heat: belief.heat(), lastSeen: cp(belief.lastSeen), seenNow: belief.seenNow },
          mates: [0, 1, 2, 3].map((j) => (j === ctx.id ? null : { ...rescue.tracker.est(j, t), state: rescue.tracker.state[j], intent: cp(rescue.tracker.intent[j]) })),
        };
        if (opts.fields) out.fields = { W: routes.W, H: routes.H, fS: Int32Array.from(routes.fS), fH: Int32Array.from(routes.fH) };
        if (opts.cover) { const W = belief.W, H = belief.H, c = new Float32Array(W * H); for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) c[j * W + i] = belief.walk[j * W + i] ? belief.coverAt((i + 0.5) * belief.cs, (j + 0.5) * belief.cs) : -1; out.cover = { W, H, cs: belief.cs, v: c }; }
        if (opts.loops) out.loops = loops.anchors.map((a, k) => ({ id: a.id, kind: a.kind, x: a.c.x, z: a.c.z, held: loops.detour(k) }));
        return out;
      },
    };
  };
}
