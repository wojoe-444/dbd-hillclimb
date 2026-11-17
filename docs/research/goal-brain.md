# The 'goal' survivor: a learned goal layer over hand-written motor skills

Branch `feat/goal-brain`. Step 3 of the recommended path in [emergent-behaviour.md](emergent-behaviour.md):
replace the survivor's fixed priority cascade with goals scored by evolvable weights over a shared feature vector,
keeping the motor skills hand-written. Run it with `--survivor goal` (evolve.js, matchup.js, ab-brains.js, diag-*.js).

## How it decides

Every decision tick, for each of 14 goals `g`:

```
score_g = Σ_j w[g][j] · f_j          (45 shared features, f_0 = 1 is the bias)
        + goalStick                   if g is the current goal (hysteresis)
        + fatigue_g · min(1, s in g / 30)   current goal only
```

The best **feasible** goal runs its motor routine. Feasibility is physical only, never a habit: is a teammate
hooked, do I know a workable gen, are the gates powered. If the routine has nothing to do this tick (returns null),
the next best goal runs. Hooked / carried / downed are reflexes, not goals.

Every `w[g][j]` is a knob `g_<goal>_<feature>` in [-6, 6]. Defaults are hand-set so the brain plays about like
`param` (results below). **A new idea becomes a feature (an observable) or a goal (a primitive with a motor routine),
never a decision rule.**

### Goals and their motor routines

| goal | motor routine |
|---|---|
| `repair` | work the best known generator (gen choice + side slots: workStep) |
| `explore` | explore for unfound generators (know.pickTarget) |
| `kicked` | return to a generator I saw kicked / regressing |
| `flee` | run: loops / crossings / vaults / pallets / open-field routes (chase) |
| `hide` | break line of sight of a seen hunter (findHide), or hide from the believed one (pickHideSpot) |
| `watch` | hold still and watch the hunter / where it should be |
| `sneak` | leave quietly: away from the last sighting toward the farthest known gen |
| `rescue` | unhook a teammate (rescue.js picks which / executes) |
| `heal` | heal an injured teammate / pick up a downed one (healplan.js handshake) |
| `pickup` | go straight to the nearest downed teammate and pick it up |
| `getHealed` | injured: stand still while healed / accept a heal offer / walk to a healthy teammate |
| `mend` | mend my Deep Wound |
| `gate` | open an exit gate / leave |
| `protect` | body-block: stand between the seen hunter and the teammate nearest to it |

### Features (solo-queue legal: own obs, HUD, own sight, notifications, own belief)

All in [0, 1] except `hClosing` (−1..1). The hunter sight features are short memories (~1 s time constant;
`hMem` 5 s). The first version used the raw "seen this tick" values, and one-tick sighting flickers at the cone edge,
during camera turns or behind occluders flipped flee ↔ repair on alternate ticks: 3.0 flip-backs per survivor-minute,
down to 0.6 after smoothing.

| feature | meaning |
|---|---|
| `bias` | constant 1 |
| `injured` | I am injured |
| `hookStages` | my hook stages consumed / 2 |
| `deepWound` | I have Deep Wound |
| `protected` | unhook protection left / 10 s |
| `beingHealed` | a teammate is healing me (HUD) |
| `chased` | chase music: the hunter is chasing me |
| `repairing` | I am repairing right now |
| `hVisible` | I see the hunter (1; fades over ~1 s after losing sight) |
| `hNear` | seen hunter proximity: 1 at 0 m .. 0 at 40 m (x hVisible) |
| `hMem` | hunter memory: proximity of the last sighting to me now, decaying (5 s time constant) |
| `hClosing` | seen hunter speed toward me / 4.6 m/s (-1..1) |
| `hCanSee` | the seen hunter could see me (cone + line of sight); decays over ~1 s after it stops |
| `terror` | terror radius layer heard / 3 |
| `terrorUp` | the terror layer got closer within 4 s |
| `threat` | my belief: hunter within 16 m of me (soft probability) |
| `hBusy` | another teammate is chased or carried (HUD) |
| `gens` | generators done / needed |
| `genAvail` | known workable gens / 2 (capped) |
| `genNear` | nearest known workable gen: 1 at 0 m .. 0 at 60 m (path) |
| `genProg` | best progress among known workable gens (last seen) |
| `kicked` | progress of a known gen I saw regressing / losing progress in the last 120 s |
| `unexplored` | gens not found yet / all (0 once the map is explored) |
| `gatesPowered` | exit gates powered |
| `gateOpen` | an exit gate is open |
| `collapse` | endgame collapse elapsed share |
| `hooked` | teammates on a hook / 3 (HUD) |
| `hookUrgency` | hooked teammate: share of the stage gone (x2 in struggle) / 2, max |
| `hookNear` | nearest hooked teammate: 1 at 0 m .. 0 at 60 m (path) |
| `hookCamp` | P(the hunter is near that hook): sighting / Resolve rising / belief |
| `claimed` | another teammate claimed / is doing that rescue (intent / HUD) |
| `iClosest` | P(I am the closest standing teammate to that hook) |
| `downedNear` | nearest downed teammate (aura): 1 at 0 m .. 0 at 40 m |
| `injuredNear` | nearest visible injured teammate: 1 at 0 m .. 0 at 30 m |
| `healthyNear` | nearest visible healthy teammate: 1 at 0 m .. 0 at 30 m |
| `healOffer` | a visible teammate offered to heal me (accepted: 1, said "healing": 0.5) |
| `matesGone` | teammates dead or escaped / 3 (HUD) |
| `matesRepairing` | teammates repairing / 3 (HUD) |
| `cover` | cover at my spot (0..1) |
| `loopNear` | best known usable loop tile near me (distance held, fading to 0 at 15 m) |
| `time` | match time / 600 s |
| `injNear` | injured x hNear |
| `seeNear` | hCanSee x hNear |
| `progTerror` | genProg x terror |
| `hookGens` | hooked x gens |

### Knobs

**707** = 62 motor knobs kept from `param` (loops, vaults, pallets, hide-spot scoring, gen choice, rescue / heal
planners, belief, camera...) + 14 goals × (45 weights + 1 fatigue) = 644 + `goalStick`.

18 cascade gates of `param` are dropped, because the goal weights replace them. They are fixed at their defaults:
`fleeSeenDist fleeTR calmS sneakMaxS altruism trustChase seekHeal hideDist hideHoldS mendRiskDist exploresMap
hideThreat hideOnLayer hideOnClosing hideProgSlack hideStayS hideMaxS rescueThreshold`. Two exceptions:
`hideThreat` = 1 keeps the belief map on, and `rescueThreshold` = −1e9 makes rescue.js always name its best target,
so the goal layer decides whether to go.

### Code: what moved in survivor.js

Pure moves inside `makeSurvivor`. `param` stays byte-identical:
`node scripts/check-param-identity.js` gives the same 18 match hashes before and after, on default and seeded random
knob sets.

* `decideInner`'s per-decision bookkeeping (belief / map-knowledge updates, chase, vault and Bloodlust tracking) moved
  to `observe(obs, api)`.
* The endgame gate block moved to `gateStep(obs, api, holdProtection)`.
* The generator / explore choice moved to `workStep(obs, api, walk, holdProtection, only)`. `only = 'gen' | 'explore'`
  restricts the choice; `param` passes nothing.
* The returned brain gains `skills`: those functions plus `chase findHide pickHideSpot hunterCouldSee hunterPos unblock
  withLook myThreat slots routes`, and get / set accessors for `mode circ hide hiddenUntil genTarget` (`exploreTo`
  read-only).

The goal brain builds one `param` brain per survivor (with its own knob object) and drives those skills, so
improvements to the motor helpers reach both brains.

### Viewer

`brain.debug(t, opts)` returns `param`'s layers plus
`goal: { name, prev, since, failed, scores: {goal: score}, top: [{f, v, w, c}] (largest |w·f| of the chosen goal), features }`.
It's read-only (a test checks that polling it changes nothing). `brain.goal` is the current goal's name, and
`brain.goalStats` holds the per-goal ticks, entries, transitions and fallbacks.

## Results

Measured 2026-11-16 on a shared machine, all against the default `param` hunter.

**Default weights vs `param`** (`node scripts/ab-brains.js --a param:default --b goal:default --n 256`; paired, common seeds):

| survivors | fitness | kills | escapes | gens | BP |
|---|---:|---:|---:|---:|---:|
| param defaults | 0.3075 | 3.54 | 0.46 | 3.51 | 10,938 |
| goal defaults | 0.3169 | 3.39 | 0.61 | 3.68 | 11,194 |
| difference | **+0.009 ± 0.010** | | | | |

So the hand-set defaults are at parity with `param`: within about 1 se, nominally slightly better. The 64-seed check
gives +0.021 ± 0.022.

**Goal usage at defaults** (`node scripts/diag-goal.js --n 8`): repair 45%, flee 32%, rescue 7%, explore 6%,
heal 3%, getHealed 2%, gate 1.5%, sneak / watch / hide about 1% each. `kicked`, `pickup` and `protect` are about
0%: their default weights are deliberately low, and they're there for evolution to find. There are 5.7 goal switches
per survivor-minute. Flip-backs (A → B → A within 1 s) are 0.68 per survivor-minute, and most of those are the hunter
genuinely reappearing after a break.

**Dithering** (`node scripts/diag-dither.js --n 8 --survivor goal|param`): facing flips on 0.74% vs 0.70% of ticks,
with 0 vs 1 dither streaks of 3 or more. That's parity.

**Smoke evolution** (`evolve.js --survivor goal --gens 8 --pop 12 --rounds 8`, `runs/smoke-goal`; a second run adds
`--init-sigma 0.05`, in `runs/smoke-goal-s05`). The champion then played a 64-seed paired A/B vs the default
weights:

| survivor set | fitness | kills | esc | gens | vs goal defaults |
|---|---:|---:|---:|---:|---:|
| goal defaults | 0.3062 | 3.47 | 0.53 | 3.56 | — |
| smoke-goal champion (init-sigma 0.35) | 0.2496 | 3.94 | 0.06 | 2.89 | **−0.057 ± 0.018** |
| smoke-goal-s05 champion (init-sigma 0.05) | 0.2701 | 4.00 | 0.00 | 1.06 | −0.036 ± 0.015 |
| param defaults | 0.2857 | 3.64 | 0.36 | 3.19 | −0.021 ± 0.022 |

This is the outcome emergent-behaviour.md §1 predicts. evolve.js mutates about 80% of the knobs at generation 1, which
here means more than 500 goal weights at once. Generation 1 then played at 0.48 gens per match (2.41 with
init-sigma 0.05), and 8 generations at 8 matches per individual can't select back from that. The champion's goal
shares do move: explore rises from 6% to 14% and sneak / gate fall to 0. So the weights are live and evolvable;
selection just has no power yet. Before a real goal run:

* use step 0's selection fixes (CRN / paired fitness, more rounds, elites not re-ranked on one noisy evaluation);
* start **at the defaults** with a much smaller per-knob mutation probability, or mutate only the goal weights in
  blocks, or use a low-rank `W = U·V` / CMA-ES as the doc suggests. A dense 14 × 45 matrix is far too much freedom
  for a 0.044-ICC fitness;
* then compare with `ab-brains.js --n 256`.

## Scripts

* `scripts/ab-brains.js`: paired A/B across brains and parameter sets (`--a param:default --b goal:<champions.json>`).
* `scripts/diag-goal.js`: per-goal time share, entries, transitions, switch rate, flip-backs by pair.
* `scripts/diag-dither.js --survivor goal`: facing-flip dithering.
* `scripts/check-param-identity.js`: fingerprint of `param`'s play, to diff before and after a survivor.js refactor.
* `node scripts/test-sim.js` covers goal-brain determinism, inert debug polling, space sanity and a deterministic
  mixed goal / param team.

