# The 'goal' survivor: a learned goal layer over hand-written motor skills

Branch `feat/goal-brain`. Step 3 of the recommended path in [emergent-behaviour.md](emergent-behaviour.md):
replace the survivor's fixed priority cascade with goals scored by evolvable weights over a shared feature vector,
keeping the motor skills hand-written. Run it with `--survivor goal` (evolve.js, matchup.js, ab-brains.js, diag-*.js).

## How it decides

Every decision tick, for each of 14 goals `g`:

```
score_g = Σ_j w[g][j] · f_j          (54 shared features, 45 before feat/goal-reflexes; f_0 = 1 is the bias)
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

**1064** (branch `feat/goal-reflexes`) =
* 108 motor knobs kept from `param`;
* 770 goal knobs: 14 goals × (54 weights + 1 fatigue);
* `goalStick`;
* 55 motor-mode knobs: 11 moving goals × 5;
* 130 reflex genes: 10 slots × 13.

The first version (`feat/goal-brain`) had 707.

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

## Conditional reflexes and motor modes (`feat/goal-reflexes`)

The owner asked: "Does the gameplay allow for conditional reflexes? Like 'if every other survivor is hooked, I go
immediately for a stealthy rescue', or 'killer is nearby, I will sneak up to the hook'?" Yes. These are now
genes, not rules.

### Reflex slots (10 per genome, all off by default)

```
IF f[fa] (>|<) ta [AND f[fb] (>|<) tb] THEN score[goal] += bonus   and, while that goal runs: gait / covered / wait
```

| gene (slot k) | range | meaning |
|---|---|---|
| `r<k>_on` | 0..1 (default 0.4) | > 0.5 enables the slot (0.4 = off but one mutation away; a fresh slot with bonus 0 and no mode is neutral) |
| `r<k>_fa`, `r<k>_fb` | 0..NF | feature index (floored) |
| `r<k>_ta`, `r<k>_tb` | 0..1 | threshold (all features are about 0..1) |
| `r<k>_da`, `r<k>_db` | −1..1 | ≥ 0 means `>`, < 0 means `<` |
| `r<k>_and` | 0..1 | > 0.5 ANDs in the second condition |
| `r<k>_goal` | 0..14 | goal index (floored) |
| `r<k>_bonus` | −8..8 | added to that goal's score while firing |
| `r<k>_gait` | 0..4 | 0 no override, 1 run, 2 walk, 3 crouch |
| `r<k>_cover`, `r<k>_wait` | 0..1 | > 0.5: covered route / wait-for-timing for that goal |

* **Integer genes** (feature and goal indices, gait) are continuous genes that the brain floors and clamps. So
  `params.js` mutation, uniform crossover and sep-CMA-ES work unchanged, and `src/hillclimb/` isn't touched. A
  mutation of an index jumps to an arbitrary other feature or goal, which is the intended exploration.
* **Firing.** A met condition stays latched for 1 s, so values hovering at the threshold don't flicker. A bonus
  only applies to a feasible goal.
* **Visibility.**
  * `decodeReflexes(params)` gives text like `IF allOthersOut > 0.50 AND hNear < 0.30 THEN rescue[crouch,covered] +4.0`.
  * `reflexGenes(k, {if, and, goal, bonus, gait, cover, wait})` goes the other way.
  * `debug().goal.reflexes` (`{k, text, fired}`) and `debug().goal.mode` show what fires and which mode is active.
  * `goalStats.reflexFired` / `reflexWon` count firings, and `node scripts/diag-goal.js --champ …` prints them per
    match.

### Motor modes (per moving goal: repair explore kicked hide sneak rescue heal pickup getHealed gate protect)

| knob | effect |
|---|---|
| `m_<g>_stealth` [−1, 1, −0.25] + `m_<g>_stealthDanger` [−2, 2, 0] × danger | gait: < −0.5 run · < 0 the routine's own gait (default) · < 0.5 walk · ≥ 0.5 crouch (1.13 m/s, no scratch marks, crouch shadow) |
| `m_<g>_cover` [−1, 1, −0.25] + `m_<g>_coverDanger` [−2, 2, 0] × danger > 0 | covered route: [coverroute.js](../../src/brains/coverroute.js) takes the next 3–7 m step that still makes path progress, scored by belief cover (crouched cover when crouching) − 1.5 × exposure to the seen hunter / the belief's top cells − 0.15 × detour; re-planned at 1 Hz |
| `m_<g>_wait` [0, 1, 0] | timing: hold and watch while the target's danger (seen hunter within 24 m of it, else belief P(within 16 m)) is > 1 − wait, unless the hunter is busy elsewhere (chasing / carrying another, from the HUD); at most 25 s per goal entry |

A firing reflex overrides its goal's gait and can switch on covered and wait (wait ≥ 0.7). `danger` =
max(hNear, hMem, terror, threat). So "the killer is nearby, I sneak up to the hook" is per-goal mode weights
(`m_rescue_stealthDanger` > 0) or a reflex (`IF danger > 0.5 THEN rescue[crouch,covered]`).

**Extension point for a stealth planner:** `coverroute.js` exports `makeCoverRoute(ctx, belief)` →
`{ step(obs, api, me, target, {crouch}) → {x,z}|null }`. `stealthplan.js` (feat/stealth-planner) can supply the same
interface; survivor-goal.js only calls `step`.

### Features added for conditions (9; 54 in total)

`matesHookedFrac` (hooked / teammates still in), `allOthersOut` (no other teammate standing), `lastAlive`,
`hunterChasingOther`, `mateCarried`, `hunterNearHook` (seen, or seen < 8 s ago, within 16 m of the nearest hooked
teammate), `hookTimeLeft` (time until the most urgent hooked teammate dies / 140 s; 1 = nobody hooked), `endgameLeft`,
`danger`. My own hook stage was already a feature (`hookStages`).

### Recommended evolution flags for this brain

The space is too big for the default GA start: at generation 1 it mutates about 80% of knobs at sigma 0.35. Use the
selection fix and start near the defaults:

```
node src/hillclimb/evolve.js --survivor goal --panel --race --init-sigma 0.05 --pmut 0.05 --sigma 0.08 \
     --pop 24 --rounds 16 --gens 60 --out runs/goal-1
# or sep-CMA-ES over the normalised vector (step size per normalised knob):
node src/hillclimb/evolve.js --survivor goal --opt cmaes --panel --pop 24 --rounds 16 --gens 60 --out runs/goal-cma
```

A low `--pmut` makes each child a few-knob change, so one new reflex or a few weights at a time, and racing spends
the matches where the ranking is unsure. Accept a learned reflex only if a second seed finds a similar one and
`ab-brains.js --n 256` confirms it.

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

### Reflex results (2026-11-16, shared machine)

* **Defaults unchanged.** All reflex slots are off and the modes inherit, so the goal-brain match hashes are
  identical before and after (`check-param-identity.js --survivor goal`, 8 matches). `matchup.js --survivor goal --n 64`
  is identical before and after: kills 3.27, escapes 0.73, gens 3.89, hooks 7.83.
* **Scripted scenario** (`node scripts/demo-reflex.js`, also a test). The three teammates are hooked and the hunter is
  far away.
  * Defaults: survivor 0 runs to the hooks and makes 3 rescues in 30 s.
  * With `IF allOthersOut > 0.50 THEN rescue[crouch,covered] +6.0`: it crouch-walks (crouch on 100% of decisions,
    engine-crouched 99%) along covered steps (282 of 300 decisions), and makes no rescue in 30 s at 1.13 m/s.
  * Further tests: gait walk, timing (waits while the hunter idles near the hooks), and per-goal mode weights
    (`m_repair_stealth` 0.3 → walking repair) all work. A disabled slot leaves a full match byte-identical.
* **Smoke evolution, first try** (`--panel --race`, gens 8, pop 12, rounds 8, `runs/smoke-reflex`): no reflex ever
  switched on. The enable gene defaulted to 0 with the threshold at 0.5, about 4 mutation sigmas away, and the
  population maximum stayed below 0.48. Fix: the default is now 0.4, still off but one mutation away. A fresh slot
  (bonus 0, no mode) is neutral.
* **Smoke evolution, after the fix** (`runs/smoke-reflex2`, same flags): reflexes are used. Generation 1 individuals
  carry 0–6 enabled slots (mean about 3). By generation 8 the counts have thinned to 0–3, and the ranking doesn't favour
  more slots. The champion has one: `IF deepWound > 0.50 THEN repair -2.9`, i.e. "don't repair with Deep Wound". It
  fires about 110 decisions per match. Its motor modes also moved: about 2,000 decisions per match with a forced run
  gait, 250 walking, 37 covered steps. 64-seed paired A/B vs the default hunter:

| survivors | fitness | kills | esc | gens | vs goal defaults |
|---|---:|---:|---:|---:|---:|
| goal defaults | 0.3525 | 3.19 | 0.81 | 3.81 | — |
| smoke-reflex2 champion | 0.2904 | 3.83 | 0.17 | 2.33 | **−0.062 ± 0.021** |
| param defaults | 0.3560 | 3.22 | 0.78 | 3.75 | +0.004 ± 0.025 |

  As with the first goal smoke run, the champion is worse than the hand-set defaults. Generation 1's init (sigma 0.35
  on about 80% of 1064 knobs) throws away the defaults, and 8 generations can't recover. The one readable reflex is
  plausible but not established (one run, n = 8 slots). The mechanism works: reflexes appear, fire, and can be read in
  plain text. Selection with the recommended flags (`--init-sigma 0.05 --pmut 0.05`, longer runs, two seeds) has to
  show whether any reflex is real.
* **Dithering** (smoke champion): 1.16 flip-backs per survivor-minute (defaults 0.68), mostly flee ↔ sneak. Its
  evolved weights put the two scores close together, so `goalStick` is too small for them. That's another reason to
  start near the defaults.

## Scripts

* `scripts/ab-brains.js`: paired A/B across brains and parameter sets (`--a param:default --b goal:<champions.json>`).
* `scripts/diag-goal.js`: per-goal time share, entries, transitions, switch rate, flip-backs by pair.
* `scripts/diag-dither.js --survivor goal`: facing-flip dithering.
* `scripts/demo-reflex.js`: scripted reflex scenario (teammates hooked → crouch / covered rescue), also used by test-sim.
* `scripts/check-param-identity.js`: fingerprint of `param`'s play, to diff before and after a survivor.js refactor.
* `node scripts/test-sim.js` covers goal-brain determinism, inert debug polling, space sanity and a deterministic
  mixed goal / param team.

