// Parametric survivor. Solo-queue rules: no module-level mutable state; everything lives in the closure.
// Knobs are hill-climbed; `space` = { name: [min, max, default] }.

export const survivorSpace = {
  fleeSeenDist:  [6, 40, 20],    // hunter seen within this -> chase mode
  fleeTR:        [0, 32, 12],    // abandon a gen when the heard terror layer's midpoint (26.7 / 16 / 5.3 m) is below this
  calmS:         [1, 12, 4],     // seconds without sighting (and terror > fleeTR) before calming down
  walkWhenTR:    [0, 1, 0.5],    // >0.5: walk (no scratch marks) when sneaking away from terror
  palletDropDist:[1.5, 6, 3],    // drop an up pallet when the hunter is this close to it
  vaultDist:     [1.5, 8, 4],    // cross a window/dropped pallet when hunter on our side within this
  loopRace:      [0.4, 1.2, 0.8],// take a loop only if my path to its entry < loopRace * the hunter's distance to it
  altruism:      [0, 1, 0.6],    // willingness to rescue / heal
  rescueDelayS:  [0, 40, 8],     // wait after spotting a hooked teammate (anti-camp)
  campAvoidDist: [0, 20, 8],     // don't approach a hook while the hunter is seen within this of it
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
  rescueSlack:   [0, 40, 10],    // go for a rescue if my distance <= the closest teammate's estimated distance + this
  unknownDist:   [10, 80, 40],   // assumed distance to a hook for a teammate whose whereabouts the HUD doesn't reveal
  rescueWhenChased: [0, 1, 0.6], // >0.5: skip the rescue delay while another survivor is being chased (hunter busy)
  trustChase:    [0, 1, 0.6],    // >0.5: don't abandon my gen on terror while another survivor is being chased
  downedStillDist: [0, 40, 12],  // downed: lie still (auto-recover to 95%) unless the hunter is seen within this; then crawl away
  seekHeal:      [0, 1, 0.4],    // >0.5: when injured, walk to a visible healthy teammate and stand still to be healed
  trustIntent:   [0, 1, 0.6],    // >0.5: skip a rescue if a teammate just said "going for unhook" (unless I'm right there)
  // ---- generator choice ----
  farFromHunterW: [0, 2, 0.5],   // prefer gens far from the hunter's last known position (linear up to 60 m)
  genJitter:     [0, 2, 0.3],    // per-survivor fixed random preference per gen (breaks the four-identical-bots symmetry)
  // ---- stealth: use line of sight ----
  hideDist:      [0, 75, 40],    // hunter seen within this, not chasing me, and it could see me -> slip out of its view
  hideSearchR:   [4, 20, 10],    // how far to look for a hiding spot (m)
  hideWalk:      [0, 1, 0.6],    // >0.5: walk (no scratch marks) while slipping out of view
  hideHoldS:     [0, 8, 2],      // once out of view, stay put this long while the hunter is still around
  // ---- chase: loops scored by "equivalent distance held" (loops.js) ----
  loopTravelMaxM:[5, 50, 25],    // max path distance I'll run to reach a loop's entry
  holdW:         [0, 3, 1],      // loop score = holdW * expected distance held per chase (m) - path distance to its entry (m)
  avoidHeading:  [0, 1, 0.6],    // >0.5: skip loop entries the hunter is heading toward (it would cut us off)
  chaseToMatesW: [-1, 1, 0],     // in a chase: >0 run toward teammates known to be repairing, <0 lead the hunter away from them
  edgeAvoidW:    [-1, 1, 0],     // in a chase: >0 avoid loops / flee points within 16 m of the map's outer wall, <0 prefer them
  followFleeW:   [-1, 1, 0],     // fleeing (chase flee point / loop anchor / hide spot): >0 run the same way as a visible teammate who's fleeing the hunter, <0 diverge
  genClusterW:   [-1, 1, 0],     // fleeing (flee point / loop anchor / hide spot): >0 toward the tightest cluster of unfinished gens I've perceived, <0 away
  weakPalletM:   [0, 20, 8],     // a pallet whose hunter detour is below this is "weak"...
  weakDropDist:  [1.5, 8, 4],    // ...and gets dropped as soon as the hunter is this close (no holding for a stun)
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
  // ---- exploration (survivors only know the generators / loop anchors they have found) ----
  exploresMap:   [0, 1, 0.5],      // propensity to explore unexplored areas instead of working a known gen (0 = only when no gen is known)
  exploreRadM:   [10, 80, 35],     // preferred distance of exploration targets (score = unexplored share - distance / this)
};

import { makeSlotPicker } from '../sim/slotpick.js';
import { HunterBelief } from './hunterbelief.js';
import { LoopModel } from './loops.js';
import { MapKnowledge } from './mapknow.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b);
const d2 = (a, b) => hyp(a.x - b.x, a.z - b.z);
function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return hyp(dx, dz);
}

export function makeSurvivor(P) {
  return (ctx) => {
    const M = ctx.map;
    // survivors don't know where the generators are: obs.gens[i] gets id / position / slots once found (engine).
    const loops = new LoopModel(ctx);            // anchors + distance-held circuits (static parts lazily, once per match)
    const anchors = loops.anchors;
    const know = new MapKnowledge(ctx, anchors);  // explored area + anchors seen
    const exploreJit = Float32Array.from({ length: know.seen.length }, () => 0.15 * ctx.rng.next());   // own taste per area
    const detourOf = (a) => Math.max(0, loops.detour(a.k) - 3.2);
    const jitter = M.generators.map(() => ctx.rng.next());   // this survivor's own taste per gen (own seeded stream)
    let mode = 'work';          // work | chase | sneak
    let lastThreatT = -99;
    let circ = null;            // running loop: { seq, i, phase: 'toP' | 'cross', lockT, holdT }
    let genTarget = -1;         // >= 0 gen index, -2 = exploring
    let exploreTo = null, exploreT = -99;
    const vaultCount = new Map(); let wasVaulting = false, lastChasedT = -99;   // window vaults in the current chase (entity blocker)
    const slots = makeSlotPicker(ctx.config.reach.repairSlot);   // generator side slots (one repairer per side)
    let fleePoint = null, fleeT = -99;
    let sneakStart = -1;
    const hookedAt = {};          // teammate id -> { hookId, x, z, t } from the HUD hook notifications
    let notesRead = 0;
    let unhookIntentT = -99;      // last time a teammate said "going for unhook"
    const sentUnhookFor = {};     // hooked teammate id -> hook time we announced for
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
      return api.visibility(h, pt) >= 0.5;
    }
    function findHide(obs, api, me, h) {
      if (hideSpot && obs.t - hideT < 1 && !hunterCouldSee(api, h, hideSpot)) return hideSpot;
      hideT = obs.t; hideSpot = null;
      let best = null, bd = Infinity;
      for (let rr = 2; rr <= P.hideSearchR; rr += 2) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * 2 * Math.PI, pt = { x: me.x + Math.cos(a) * rr, z: me.z + Math.sin(a) * rr };
          if (hunterCouldSee(api, h, pt) || d2(pt, h) < d2(me, h) - 2) continue;   // hidden, and not toward the hunter
          const d = api.nav.dist(me, pt);
          if (d < bd) { bd = d; best = pt; }
        }
        if (best) break;
      }
      hideSpot = best;
      return best;
    }

    // ---- hiding from an UNSEEN hunter: own belief map + static cover ----
    const belief = new HunterBelief(ctx, { spread: P.hbSpread });
    const beliefOn = P.hideThreat <= 1 || P.genThreatW > 0;   // otherwise only the terror trend is tracked
    let hide = null;              // { start, lastTrig, spot, spotT }
    let hideCooldownUntil = -99;
    const stats = { decides: 0, hideTicks: 0, hides: 0, found: 0, chases: 0 };   // diagnostics (read by scripts via brain.stats)
    let wasChased = false, lastHideTickT = -99;
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

    function pickHideSpot(obs, api, me) {
      const fl = fleeingMates(obs, me);
      const cc = P.genClusterW !== 0 ? genCluster(obs, me) : null;
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
      for (const c of cands) c.s = P.coverW * belief.coverAt(c.pt.x, c.pt.z) - 0.5 * c.d / R;
      cands.sort((a, b) => b.s - a.s);
      const top = beliefOn && P.exposeW > 0 ? belief.topCells(12) : null;
      // the hunter will come to check the generator I was working on: count it as a likely viewpoint too
      if (top && hide && hide.gen >= 0 && obs.gens[hide.gen].known) { const g = obs.gens[hide.gen], m = top.reduce((a, c) => a + c.p, 0); top.push({ x: g.x, z: g.z, p: m * P.hideGenFear }); }
      let best = here, bs = -Infinity;
      let tried = 0;
      for (const c of cands) {
        if (tried >= 6) break;
        if (c.d && !api.walkClear(me, c.pt)) continue;    // straight-line reachable only (cheap; no A*)
        tried++;
        const d = c.d;
        let s = P.coverW * belief.coverAt(c.pt.x, c.pt.z) - 0.5 * d / R - 2 * belief.threatAt(c.pt, P.hideThreatR);
        if (top) s -= P.exposeW * belief.exposure(api, c.pt, top);
        if (fl.length) s += P.followFleeW * 10 * alignTo(fl, me, c.pt);
        if (cc) s += P.genClusterW * 10 * clusterAt(cc, c.pt);
        if (hide && hide.spot && d2(c.pt, hide.spot) < 1.5) s += 0.1;     // keep the current spot unless clearly worse
        if (s > bs) { bs = s; best = c.pt; }
      }
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
    const crossOK = (a, obs) => (a.kind === 'w' ? !obs.blockedWindows.includes(a.id) : obs.pallets[a.i] !== 'broken');
    function chooseCircuit(obs, api, me, hp, h, extra) {
      const vl = vaultsLeft(obs), ps = palletState(obs), R = P.loopTravelMaxM;
      const cands = [];
      for (const a of anchors) {
        if (!know.anchorKnown[a.k] || !crossOK(a, obs) || d2(me, a.c) > R + 2) continue;
        for (let d = 0; d < 2; d++) {
          const c = 2 * a.k + d, Pt = loops.sidePt[c];
          const dmE = d2(me, Pt), dhP = d2(hp, Pt);
          if (dmE > R || !(dmE < P.loopRace * dhP)) continue;
          // the hunter is heading for it: it would cut us off there
          if (h && P.avoidHeading > 0.5) { const tx = Pt.x - h.x, tz = Pt.z - h.z, tl = Math.hypot(tx, tz) || 1; if ((h.vx * tx + h.vz * tz) / tl > 2.5 && dhP < dmE + 4) continue; }
          let best = null, be = 0;
          for (const o of loops.circuitsFrom(c)) {
            if (!o.seq.every((x) => know.anchorKnown[x >> 1] && crossOK(anchors[x >> 1], obs))) continue;
            const ex = loops.expected(o, vl, ps);
            if (ex > be) { be = ex; best = o; }
          }
          if (best) cands.push({ o: best, ex: be, Pt, dhP, s: P.holdW * be - dmE + extra(Pt) });
        }
      }
      cands.sort((x, y) => y.s - x.s);
      let pick = null, bs = -Infinity;
      for (const c of cands.slice(0, 4)) {               // path distances only for the best few
        const dm = api.nav.dist(me, c.Pt);
        if (!(dm <= R * 1.2) || !(dm < P.loopRace * c.dhP + 1)) continue;
        const s = c.s + d2(me, c.Pt) - dm;
        if (s > bs) { bs = s; pick = c; }
      }
      return pick ? { seq: pick.o.seq.slice(), i: 0, phase: 'toP', lockT: obs.t + 1, holdT: 0, chosenT: obs.t, ex: pick.ex } : null;
    }
    function reverseCirc(obs) {
      const k = circ.seq.length, prevIdx = (circ.i - 1 + k) % k;
      const rev = circ.seq.slice().reverse().map((c) => c ^ 1);
      // the crossing I just did, backwards, comes next (or, mid-crossing, the current one backwards)
      circ.i = circ.phase === 'cross' ? k - 1 - circ.i : k - 1 - prevIdx;
      circ.seq = rev; circ.phase = 'toP'; circ.lockT = obs.t + 1.5;
    }

    function chase(obs, api, me, h, depth = 0) {
      if (depth > 3) return null;
      const mates = P.chaseToMatesW !== 0 ? matesOnGens(obs) : [];
      const fl = fleeingMates(obs, me);
      const cc = P.genClusterW !== 0 ? genCluster(obs, me) : null;
      const hp = h ?? obs.lastHunter;
      if (!hp) return null;
      const extra = (pt) => P.chaseToMatesW * 10 * mateCloseness(mates, pt) - P.edgeAvoidW * 10 * edgeness(pt) + P.followFleeW * 10 * alignTo(fl, me, pt) + P.genClusterW * 10 * clusterAt(cc, pt);
      const dhm = d2(hp, me);
      if (circ && !circ.seq.every((x) => crossOK(anchors[x >> 1], obs))) circ = null;
      if (circ && circ.phase === 'toP' && d2(me, loops.sidePt[circ.seq[circ.i]]) > P.loopTravelMaxM + 8) circ = null;
      if (!circ || (obs.t - circ.chosenT > 4 && circ.phase === 'toP' && d2(me, loops.sidePt[circ.seq[circ.i]]) > 6)) circ = chooseCircuit(obs, api, me, hp, h, extra) ?? (circ && circ.phase === 'toP' ? null : circ);
      if (circ) {
        const c = circ.seq[circ.i], a = anchors[c >> 1], Pt = loops.sidePt[c], Qt = loops.sidePt[c ^ 1];
        // hunter mid-vault through this anchor: it's blocked for it; use the head start and run
        if (h && h.vaulting && d2(h, a.c) < 2.5) { circ = null; return { moveDir: { x: me.x - h.x, z: me.z - h.z } }; }
        // the hunter is nearer my next entry than I am (it cut ahead / is on the far side): run the loop the other way
        const hP = api.nav.dist(hp, Pt), hQ = api.nav.dist(hp, Qt);   // path distances (fields to fixed points get cached)
        if (circ.phase === 'toP' && obs.t >= circ.lockT && hP + 0.5 < api.nav.dist(me, Pt) && hQ > hP && circ.seq.length > 1) { reverseCirc(obs); return chase(obs, api, me, h, depth + 1); }
        if (circ.phase === 'toP') {
          // running crossing (a real leg leads into it): keep the momentum for a fast vault while the hunter is on us;
          // hold crossing (zero leg: mind-game at one anchor): wait at the entry until the hunter is close
          const kk = circ.seq.length, legIn = loops.L(circ.seq[(circ.i - 1 + kk) % kk] ^ 1, c);
          const running = legIn >= 2 && dhm < 20;
          if (d2(me, Pt) > (running ? 1.6 : 0.8)) return { moveTo: Pt };
          // at the entry: cross when the hunter is close behind; otherwise hold here (mind-game) for a while
          const pressing = h && dhm < 16 && ((h.vx * (me.x - h.x) + h.vz * (me.z - h.z)) / Math.max(0.1, dhm)) > 1.0;
          const onMySide = hP <= hQ;
          // hunter on the far side: run the loop the other way if that leads elsewhere, else hold here
          if (!onMySide && obs.t >= circ.lockT && circ.seq.length > 1) {
            const k = circ.seq.length;
            const revNext = circ.seq[(circ.i - 1 + k) % k] ^ 1;
            if (loops.sidePt[revNext] !== Pt) { reverseCirc(obs); return chase(obs, api, me, h, depth + 1); }
          }
          const goNow = onMySide && (running || (a.kind === 'p' && obs.pallets[a.i] === 'up') || dhm < P.vaultDist);
          if (goNow) { circ.phase = 'cross'; circ.holdT = 0; }
          else {
            circ.holdT = pressing ? 0 : circ.holdT + api.dt * (ctx.config.decisionEvery || 1);
            if (circ.holdT > P.holdMaxS) { circ = null; return null; }
            return { moveTo: Pt, face: hp };
          }
        }
        // crossing
        if (a.kind === 'p' && obs.pallets[a.i] === 'up') {
          const p = a.p;
          const near = rectDist(me.x, me.z, p.x0, p.z0, p.x1, p.z1) <= 1.1;
          const ms = d2(Pt, me) <= d2(Qt, me) ? 'P' : 'Q', hs = hP <= hQ ? 'P' : 'Q';
          const dropAt = detourOf(a) < P.weakPalletM ? Math.max(P.palletDropDist, P.weakDropDist) : P.palletDropDist;   // weak pallet: drop early
          if (near && ms === 'Q' && hs === 'P' && d2(hp, a.c) < dropAt) return { act: 'dropPallet', target: p.id };
          if (near && dhm < P.palletDropDist * 0.6) return { act: 'dropPallet', target: p.id };
          if (d2(me, Qt) > 0.8) return { moveTo: Qt };
          // through, pallet still up: wait on the far side for the hunter to come close, then drop
          circ.holdT += api.dt * (ctx.config.decisionEvery || 1);
          if (circ.holdT > P.holdMaxS + 2) { circ = null; return null; }
          return { moveTo: Qt, face: hp };
        }
        if (d2(me, Qt) > 0.8) return { moveTo: Qt };
        circ.i = (circ.i + 1) % circ.seq.length; circ.phase = 'toP'; circ.holdT = 0;
        return chase(obs, api, me, h, depth + 1);
      }
      // open flee: pick a far, reachable point; refresh every 1 s
      if (!fleePoint || obs.t - fleeT > 1 || d2(me, fleePoint) < 2) {
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

    return {
      stats,
      know,
      loops,
      belief,
      decide(obs, api) {
        const me = obs.self, h = obs.hunter, nav = api.nav;
        // hooked brains are called now (minimal obs): take the Resolve self-unhook when offered (was automatic before)
        if (me.state === 'hooked') return me.canSelfUnhook ? { act: 'selfUnhook' } : {};
        if (me.state === 'carried') return { act: 'wiggle' };
        belief.update(obs, api, 2.0, beliefOn);   // heavy belief step every 2 s (sightings, hooks, auras, layer changes apply at once)
        stats.decides++;
        if (me.chased && !wasChased) { stats.chases++; if (obs.t - lastHideTickT < 5) stats.found++; }   // chase on me began within 5 s of hiding
        wasChased = !!me.chased;
        know.update(obs, api, 1.0);
        // window vaults in the current chase (entity blocker: 3 vaults of one window per chase per survivor)
        if (me.chased) lastChasedT = obs.t;
        else if (obs.t - lastChasedT > 3 && vaultCount.size) vaultCount.clear();
        if (me.vaulting && !wasVaulting && me.chased) {
          let bk = -1, bd = 2.5;
          for (const a of anchors) if (a.kind === 'w') { const d = d2(a.c, me); if (d < bd) { bd = d; bk = a.k; } }
          if (bk >= 0) vaultCount.set(bk, (vaultCount.get(bk) || 0) + 1);
        }
        wasVaulting = !!me.vaulting;
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
        const notes = obs.notifications || [];
        for (; notesRead < notes.length; notesRead++) {
          const n = notes[notesRead];
          if (n.type === 'hooked') hookedAt[n.who] = { hookId: n.hookId, x: n.x, z: n.z, t: n.t };
          else if (n.type === 'unhooked' || n.type === 'died') delete hookedAt[n.who];
          else if (n.type === 'intent' && n.intent === 'goingForUnhook') unhookIntentT = n.t;
        }
        if (hud) for (const k of Object.keys(hookedAt)) if (hud[k] && hud[k].state !== 'hooked') delete hookedAt[k];
        const otherChased = !!hud && hud.some((x) => x.id !== me.id && x.chased);

        // ---- threat state ----
        const dh = h ? d2(h, me) : Infinity;
        // a teammate is healing me: stand still (healing needs an idle patient) unless the hunter is close
        if (hud && hud[me.id] && hud[me.id].beingHealed && !(h && dh < 10)) return {};
        // hiding and the hunter appears but can't see me (and isn't close): don't bolt (running is what starts a chase)
        if (hide && h && !me.chased && dh >= P.hideNerveM && !hunterCouldSee(api, h, me)) {
          hide.lastTrig = obs.t; stats.hideTicks++; lastHideTickT = obs.t;
          return {};
        }
        if (h && dh < P.fleeSeenDist) { mode = 'chase'; lastThreatT = obs.t; }
        else if (!h && obs.terror !== null && obs.terror.approx < P.fleeTR && !(otherChased && P.trustChase > 0.5) && !(mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS)) {
          if (mode !== 'chase' && mode !== 'sneak') { mode = 'sneak'; sneakStart = obs.t; }
          lastThreatT = obs.t;
        }
        else if (mode === 'sneak' && obs.t - sneakStart > P.sneakMaxS) { mode = 'work'; circ = null; }
        else if (obs.t - lastThreatT > P.calmS) { mode = 'work'; circ = null; }

        // ---- stealth: the hunter is around but not on me -> get out of its view (and back to work once it's gone) ----
        if (mode !== 'chase' && h && dh < P.hideDist && !me.chased) {
          if (hunterCouldSee(api, h, me)) {
            const spot = findHide(obs, api, me, h);
            if (spot) { hiddenUntil = obs.t + P.hideHoldS; return { moveTo: spot, walk: P.hideWalk > 0.5 }; }
          } else if (obs.t < hiddenUntil) return {};          // out of view: hold still while the hunter passes
        }

        if (mode === 'chase') {
          const a = chase(obs, api, me, h);
          if (a) { if (me.chased && obs.t - chaseSentT > 30) { chaseSentT = obs.t; return say(a, 'chasingMe'); } return a; }
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
            if (d2(me, hide.spot) > 0.6) return { moveTo: hide.spot, walk: P.coverRun <= 0.5 };
            return {};
          }
        }
        const walk = P.walkWhenTR > 0.5 && obs.terror !== null;

        // ---- Deep Wound: mend (stand still) unless the hunter is close ----
        if (me.deepWoundS !== null && me.deepWoundS !== undefined && !(h && dh < P.mendRiskDist)) return { act: 'mend' };
        // ---- fresh off the hook: keep the protections (no conspicuous actions) for a while ----
        const holdProtection = me.protectedS !== null && me.protectedS !== undefined && me.protectedS > 10 - P.protectHoldS;

        // ---- endgame: open a gate and leave ----
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

        if (mode === 'sneak') {
          // move away from the last sighting toward the farthest unfinished gen
          const ref = obs.lastHunter ?? me;
          let far = null, fd = -Infinity;
          for (let i = 0; i < obs.gens.length; i++) {
            const g = obs.gens[i];
            if (!g.known || g.done || g.blocked) continue;
            const d = d2(g, ref) - 0.3 * d2(g, me);
            if (d > fd) { fd = d; far = i; }
          }
          if (far !== null) return slots.act(obs, far, obs.gens[far], { walk, hold: holdProtection });
        }

        // ---- altruism: rescue (the HUD announces every hook with its location) ----
        if (P.altruism > 0.25) {
          for (const k of Object.keys(hookedAt)) {
            const j = +k, hk = hookedAt[k];
            if (j === me.id) continue;
            const waited = obs.t - hk.t;
            const busy = otherChased && P.rescueWhenChased > 0.5;
            if (waited < P.rescueDelayS * (1.2 - P.altruism) && !busy) continue;
            if (h && d2(h, hk) < P.campAvoidDist) continue;
            // am I (roughly) the closest? teammates seen recently are near their last sighting; others unknown
            // (the HUD shows activity type only, not which generator)
            const myD = nav.dist(me, hk);
            let best = Infinity;
            if (hud) for (const x of hud) {
              if (x.id === me.id || x.id === j || x.state === 'dead' || x.state === 'escaped' || x.state === 'hooked' || x.state === 'carried' || x.state === 'downed') continue;
              const ls = obs.lastSeen[x.id];
              const est = ls && obs.t - ls.t < 15 ? d2(ls, hk) : P.unknownDist;
              if (est < best) best = est;
            }
            if (myD > best + P.rescueSlack) continue;
            const claimedByOther = P.trustIntent > 0.5 && obs.t - unhookIntentT < 20 && sentUnhookFor[j] !== hk.t && myD > 12;
            if (claimedByOther) continue;
            if (d2(me, hk) <= 1.6 && !holdProtection) return { act: 'rescue', target: j };
            if (sentUnhookFor[j] !== hk.t) { sentUnhookFor[j] = hk.t; return say({ moveTo: { x: hk.x, z: hk.z } }, 'goingForUnhook'); }
            return { moveTo: { x: hk.x, z: hk.z } };
          }
        }

        // ---- injured: go get healed by a visible healthy teammate ----
        if (me.state === 'injured' && P.seekHeal > 0.5 && !h) {
          const mate = obs.teammates.filter((t) => t.state === 'healthy').sort((a, b) => d2(a, me) - d2(b, me))[0];
          if (mate && d2(mate, me) < P.healDist) {
            if (d2(mate, me) <= 1.4) return obs.t - helpSentT > 20 ? (helpSentT = obs.t, say({}, 'help')) : {};
            return { moveTo: { x: mate.x, z: mate.z } };
          }
        }

        // ---- heal teammates ----
        if (me.state === 'healthy' && P.altruism > 0.15) {
          const cands = [...obs.teammates];
          for (const a of obs.downedAuras || []) if (!cands.some((t) => t.id === a.id)) cands.push({ id: a.id, x: a.x, z: a.z, state: 'downed' });
          for (const tm of cands) {
            if (hud && hud[tm.id] && hud[tm.id].beingHealed && !(me.act === 'heal')) continue;   // someone's on it
            if ((tm.state === 'injured' || tm.state === 'downed') && d2(tm, me) < P.healDist) {
              if (d2(tm, me) <= 1.4 && !holdProtection) return { act: 'heal', target: tm.id };
              return { moveTo: { x: tm.x, z: tm.z } };
            }
          }
        }

        // ---- generators (only the ones I've found) vs exploring for more ----
        const gens = obs.gens;
        if (genTarget >= 0 && (gens[genTarget].done || gens[genTarget].blocked || !gens[genTarget].known)) genTarget = -1;
        const unknownGens = gens.reduce((n, g) => n + (g.known ? 0 : 1), 0);
        const exploreLeft = unknownGens > 0 && know.fraction() < 0.98;
        if (exploreTo && (d2(me, exploreTo) < 3 || obs.t - exploreT > 25 || know.explored(exploreTo.x, exploreTo.z))) exploreTo = null;
        if (genTarget === -2 && !exploreTo) genTarget = -1;
        if (genTarget === -1 || obs.tick % 50 === 0) {
          let bs = Infinity, bi = -1;
          for (let i = 0; i < gens.length; i++) {
            const g = gens[i];
            if (!g.known || g.done || g.blocked) continue;
            let s = P.genDistW * nav.dist(me, g) / 20 - P.genProgW * g.progress * 3;
            const others = g.workers ? g.workers.filter((w) => w !== me.id).length : 0;   // only for gens currently seen
            s += P.spreadW * others;
            const hpos = h ?? (obs.lastHunter && obs.t - obs.lastHunter.t < 90 ? obs.lastHunter : null);
            if (hpos) s -= P.farFromHunterW * Math.min(60, d2(g, hpos)) / 20;
            s += P.genJitter * jitter[i];
            if (obs.lastHunter && obs.t - obs.lastHunter.t < 60) s += P.hunterAvoidW * Math.max(0, 25 - d2(g, obs.lastHunter)) / 10;
            if (P.genCoverW !== 0) s -= P.genCoverW * 3 * genCoverOf(g, i);
            if (P.genThreatW > 0 && beliefOn) s += P.genThreatW * 3 * belief.pHunterWithin(g, 24);
            if (i === genTarget) s -= 0.5; // hysteresis
            if (s < bs) { bs = s; bi = i; }
          }
          // explore option: always when no gen is known; otherwise a propensity that grows with the gens still unfound
          if (exploreLeft && (bi < 0 || P.exploresMap > 0)) {
            if (!exploreTo) { exploreTo = know.pickTarget(me, P.exploreRadM, (c) => exploreJit[c]); exploreT = obs.t; }
            if (exploreTo) {
              let se = P.genDistW * d2(me, exploreTo) / 20 + 1.5 - P.exploresMap * (1 + 3 * unknownGens / gens.length);
              if (genTarget === -2) se -= 0.5;
              if (me.act === 'repair' && bi >= 0) se += 1;      // don't walk off a gen I'm repairing on a whim
              if (bi < 0 || se < bs) { bs = se; bi = -2; }
            }
          }
          if (bi !== -2) exploreTo = genTarget === -2 && bi >= 0 ? null : exploreTo;
          genTarget = bi;
        }
        if (genTarget >= 0) return slots.act(obs, genTarget, gens[genTarget], { walk, hold: holdProtection });
        if (genTarget === -2 && exploreTo) return { moveTo: exploreTo, walk };
        return {};
      },
    };
  };
}
