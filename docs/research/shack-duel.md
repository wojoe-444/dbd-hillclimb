# Shack duel: 1 hunter vs 1 survivor on the killer shack

**Question.** How do the bots play the standard "killer shack" loop? We run a 1v1 duel on a tiny map that contains
only the shack tile. **KPI** = seconds the survivor stays alive until its first down (capped at 120 s). We also track
the time to the first hit.

**Answer.** Very badly. Against a hunter that actually chases, the survivor lasts **8.5 s on average** (median 7.8 s).
A healthy start lasts 11.8 s and an injured start 5.3 s. The first hit comes after 5.0 s. The evo-v13 champion survivor
is a little better (10.5 s; 14.8 s from a healthy start). An ideal survivor with the engine's real numbers should
last roughly **40–60 s from a healthy start** and **25–45 s injured**, so the bots get about a fifth of what the tile
offers. No single survivor knob changes that by more than about 1.5 s. The losses come from decision logic, one real
bug and one missing piece of information, all listed below.

Brains measured: sim + brains from commit `6a59b20` (a `git archive HEAD src` snapshot; the working tree was being
edited at the same time). Every number below uses the full grid of 190 duels: 38 start setups × 5 jittered seeds.

## Setup

* **Map** `maps/duel-shack.json`. The field is 32×32 m of open ground with the `shack` tile from
  `src/mapgen/tiles.js`, placed with its origin at (8,8):
  * outer box x 11–20, z 11–20, tall 3 m walls;
  * north door x 13–14 (2 m, left of centre);
  * east window at (20,14), axis x;
  * south pallet door x 17–18 (2 m, right of centre), with a pallet of length 2.

  A 6 m thick tall block (x 32–37) seals off a pocket strip one cell wide (x = 38). The pocket holds the 10 generator
  candidates, the exit gate, the survivor spawn anchor and the 3 dummy survivors.
  * The block is 6 m thick and the strip 1 cell wide so the hunter's 3 m belief grid never counts the pocket as
    walkable. With a 1 m wall, the hunter "searched" for the dummies inside the unreachable pocket and froze.
  * The map deliberately fails the validator's single-region rule. Commit e5241a6 by the other agent accidentally
    included an early draft of this map; this commit replaces it.
* **Engine workarounds, without editing `src/`.** The engine always runs 4 survivors, so `survivors = [real, dummy,
  dummy, dummy]`, where the dummy brain returns `{}`. The dummies stay healthy in the pocket, which keeps the
  all-down and last-survivor rules from firing. Hunter and survivor are placed directly after `createMatch`, with
  their bodies and cameras facing each other.
* **Grid.** 5 survivor spots × up to 4 hunter positions × healthy/injured = 38 setups.
  * Survivor spots: `inside` (centre), `northDoor` (standing in the doorway), `palletDoor` (just outside the pallet),
    `window` (outside, next to it), `outside` (3.5 m west of the shack).
  * Hunter positions: 8 / 12 / 16 m away at 8 angles, kept only if the hunter has line of sight to the survivor.
  * Each duel adds a seeded ±0.5 m start jitter.
* **Hunter modes** (`--hunter`). The param brain always decides; the harness only replaces its action in these cases:
  * `brain`: no overrides.
  * `assist`: after 3 s without seeing the survivor, the hunter paths to the survivor's true position. This stands in
    for perfect scratch-mark tracking.
  * `strong` (default): `assist`, plus the hunter breaks the dropped shack pallet whenever it is within 3 m of it.

  Both hunters get `clusterActivate = 0` (see hunter finding H1); `--noNeutralize` turns that off.

## Results (survivor seconds alive, mean / median; 190 duels per cell, cap 120 s)

| hunter mode | hunter × survivor knobs | all | healthy start | injured start | first hit (healthy) |
|---|---|---|---|---|---|
| strong | default × default | **8.5 / 7.8** | 11.8 / 11.5 | 5.3 / 4.8 | 5.0 |
| strong | default × **evo-v13 survivor** | **10.5 / 10.1** | 14.8 / 14.8 | 6.3 / 6.4 | 6.1 |
| strong | evo-v13 hunter × default | 7.5 / 7.1 | 10.9 / 10.8 | 4.2 / 4.2 | 4.3 |
| strong | evo-v13 × evo-v13 | 9.1 / 8.9 | 13.2 / 12.3 | 5.0 / 4.8 | 5.3 |
| assist | default × default | 8.9 / 8.0 | 12.6 / 12.7 | 5.1 / 4.8 | 4.9 |
| assist | default × evo-v13 survivor | 10.8 / 9.5 | 15.4 / 14.8 | 6.3 / 6.4 | 6.8 |
| brain | default × default | 9.4 / 8.0 | 13.8 / 13.2 | 5.1 / 4.8 | 5.8 |
| brain | default × evo-v13 survivor | 11.9 / 10.0 | 17.3 / 15.5 | 6.6 / 6.2 | 7.9 |
| brain, no neutralisation, no push fix | default × default | 76.8 / 93.6 (80 capped) | | | |

The last row is the raw run. Its long survival is a harness artifact, not survivor skill (see H1 and H2): the hunter
had the survivor out of sight for 58.6 s per duel on average.

Per start spot, strong hunter, default × default (healthy / injured, mean s):

| spot | healthy | injured |
|---|---|---|
| inside | 10.5 | 7.5 |
| northDoor | 11.9 | 4.7 |
| palletDoor | 11.3 | 3.7 |
| window | 11.8 | 4.9 |
| outside | 12.8 | 6.4 |

Behaviour, strong hunter, default × default (190 duels):

* **Window vaults: 9 fast, 116 medium, 0 slow.** 93 % of window vaults are medium (0.9 s instead of 0.5 s). The
  window is blocked in only 3 duels, so the survivor rarely uses it even 3 times in a chase.
* **Pallet.** Dropped in 57/190 duels, and the drop stunned in 50 of them. In 133 duels the pallet was still standing
  at the down.
* **Shack use.** The survivor entered the shack in 152/190 duels, with 1.9 doorway/window passes on average
  (≈ 1 lap). Bloodlust never comes into play, because no chase lasts 15 s.
* **First-hit causes:** at the standing pallet 66, mid-vault 49 (37 of them at the window), open ground 46, along a
  wall 17.
* **Second-hit causes** (healthy starts): right after the pallet was broken 40, open ground 29, at the standing pallet 12.
* **On-hit sprint.** Over the hunter's 2.7 s hit cooldown the gap grows from 1.44 m to 5.94 m. An ideal sprint gives
  about +8.3 m (1.8 s at 6.6 m/s, then 4.0 m/s, against the hunter at 0.575 × 4.6 m/s).
* **During the pallet break.** When the hunter finishes the break, the survivor is 3.15 m from the pallet on average,
  and within 4 m in 34 of the 52 breaks. 36 of those duels end in a down within 3 s. The evo-v13 survivor (holdMaxS ≈ 1)
  is 9.6 m away at the break and is downed within 3 s only 12/46 times. That is most of its +2 s advantage.

## Dominant failure patterns (reproducible)

Reproduce any example with
`node scripts/duel-shack.js --src <snapshot>/src --n 190 --trace <index> --every 0.1`, where the snapshot comes from
`git archive 6a59b20 src | tar -x -C <snapshot>`. The default hunter mode is `strong` and seed = 1000 + index.

1. **Running to the pallet on the hunter's side, then hit while standing at it** (35 % of first hits; hunter 1.2 m
   away at the hit).
   * Duel #0 (`inside/healthy/h12m@68`, seed 1000): the hunter approaches the south side from 12 m. At t = 0.1 the
     survivor picks the pallet-door exit, right toward the hunter, and both arrive together. Hit at 1.5 s, before the
     drop.
   * It then drops the pallet without a stun while standing on the hunter's side, and vaults its own pallet back in
     (1.1 s, loud).
   * It stands still at (18, 18.9), 2 m behind the dropped pallet, for the whole 2.4 s break. Downed 0.7 s after the
     break, at 7.2 s.
2. **Waiting at the standing pallet for a stun that never comes** (the bug, recommendation 1).
   * Duel #19 (`palletDoor/injured/h8m@45`, seed 1019): the survivor runs through the pallet to its hold point on the
     far side (18, 18.9) and waits.
   * The hunter walks into the stun zone (from 1.5 s on) and nothing happens. The survivor only tries to drop at
     1.9 s, when the hunter is 1.1 m away and already winding up. Downed at 2.1 s.
   * 11 of the 20 `palletDoor/injured` duels end at 2.0–3.2 s exactly like this (#18–21, #56, #57, #94, #95, #97,
     #133, #135, #173).
3. **Medium-tier window vault with the hunter close behind → hit mid-vault, then the sprint is wasted.**
   * Duel #9 (`northDoor/healthy/h8m@315`, seed 1009): the survivor runs diagonally across the shack to the window.
     It gets a medium vault (0.9 s) with the hunter 2.5 m behind. Hit mid-vault at 2.9 s.
   * It lands and stands at the window exit (22.1, 14.5) for 2 s while the hunter is in its hit cooldown 3 m away.
     It only runs once the hunter starts vaulting.
   * It then flees north-east into open ground, switching flee points (30.5, 0.5) → (17.5, 1.5) → (6.5, 13.5).
     Downed in the open at 9.0 s.
4. **Leaving the shack for map corners and never coming back.**
   * Duel #1 (`inside/healthy/h12m@247`, seed 1001): one medium window vault, then flight to the north edge. Hit in
     the open at 7.0 s.
   * With a 14 m gap after the hit it runs west into the outer wall (stuck against it at 10.1 s), turns, and runs
     south along the edge. Downed in the open at 15.5 s.
   * The shack window still had 2 of its 3 vaults left.
   * Open-ground hits make up 46 first hits and 29 second hits.
5. **Staying next to the dropped pallet while it is broken.** See pattern 1 and the break statistics above. Duels
   #14–#17 (`palletDoor/healthy`) all end in a second hit 0.6–3.8 s after the break.

## What an ideal survivor would do (engine numbers)

Distances below are engine nav path lengths on this map. Inside the shack: north door → window 5.8 m, window →
pallet 5.4 m, north door → pallet 8.7 m. Outside: window → north door 11.4 m, window → pallet door 10.0 m, pallet
door → north door 13.7 m. For the hunter, walking around the window (inside ↔ outside) is about 20 m (4.4 s), so it
always vaults.

* **Closing speed and reach.** The hunter closes 0.6 m/s on open ground, rising to 0.8 / 1.0 / 1.2 m/s with
  Bloodlust (after 15 / 25 / 35 s without a hit or break). The 0.4 s windup lunges at 6.9 m/s, so against a fleeing
  survivor the hit lands from a gap of about 3.4–4 m (up to ~5 m with lungeDist 3.2).
* **Window.** A fast vault costs the survivor 0.5 s against the hunter's 1.7 s: +1.2 s, about 5.5 m of hunter running.
  A medium vault is only +0.8 s (3.7 m), and it needs about 5.5 m of gap to be safe instead of about 4 m. The entity
  blocker allows 3 vaults per chase, so the window is worth roughly +9 m net of the running legs.
  * Never run the outside leg toward the door the hunter can reach first. After the hunter follows through the window,
    it gets from window to north door in 5.8 m on the inside; the survivor needs 11.4 m on the outside.
  * Instead hold outside the window with the camera on the hunter, re-vault when it commits, or switch to the pallet
    door. This is the window/pallet two-exit mind game the tile is built for.
* **Pallet.**
  * Stun drop: hunter inside the footprint ±1 m when the 0.3 s drop lands. Worth 2 s of stun plus a 2.34 s break,
    about +20 m, and it resets Bloodlust.
  * Pre-drop with ≥ 3 m of gap: worth about +11 m.
  * Drop deadline: the hunter's path distance to me must not fall below about 5 m (0.3 s drop + 0.4 s windup). Never
    hold inside that.
* **During the break.** Leave at once. From the pallet's inside, the window is 5.4 m (1.35 s): vault out, or leave by
  the north door. The hunter comes out of the break with Bloodlust reset and has to vault again.
* **After a hit.** Sprint straight to the next crossing for the full 1.8 s. That gives about a 9.8 m gap when the
  hunter's cooldown ends.

**Budget, healthy start, hunter 12 m away:**

| part | metres of buffer |
|---|---|
| start gap above the lunge envelope | ≈ 8 |
| 3 window vaults | ≈ +9 |
| pallet (stun + break) | ≈ +15–20 |
| **total** | ≈ 32–37 m |

At a mean closing speed of ~0.75 m/s that is about 40 s to the first hit. After the hit there are about 6 m of buffer
left, plus any unused vaults (the window may be blocked for 30 s), which is another 10–20 s. That gives **≈ 40–60 s**
from a healthy start and **≈ 25–45 s** from an injured one. A hunter that mind-games the window (cutting instead of
following) roughly halves the window's value, which is why the lower bounds are lower. The bots reach 11.8 s
(healthy) and 5.3 s (injured), about **20 %** of that.

## Knob sensitivity

All rows: default survivor with one knob changed, strong hunter, 190 duels, survivor seconds alive (mean).
Baseline 8.5 s.

| change | mean | change | mean |
|---|---|---|---|
| stunSeek 0 / 1 | 8.5 / 8.5 | holdMaxS 0 / 12 | **9.4** / 8.4 |
| palletGreed 0 / 3 | 7.9 / 8.5 | holdHorizonS 2 / 12 | **10.0** / 8.3 |
| vaultSafetyMarginM 0 / 2.5 | 8.5 / 8.5 | edgeAvoidW 1 / −1 | 8.6 / 9.5 |
| vaultDist 8 / 1.5 | 9.0 / 8.6 | avoidHeading 0 / 1 | 8.5 / 8.5 |
| loopRace 1.2 | 8.0 | loopTravelMaxM 50 | 8.5 |
| holdW 0 / 3 | 8.5 / 8.5 | vaultClearanceS 0 | 8.6 |
| fleeSeenDist 40 | 8.5 | | |

`stunSeek`, `holdW` and `vaultSafetyMarginM` have **no effect at all**: the code paths they control are not where
these duels are lost. Evolution cannot buy its way out with the current knob set; the GA already found the best one
(holdMaxS ≈ 1, which gives +2 s).

## Recommendations for the survivor brain (ranked; not implemented)

1. **Fix the pallet hold-drop bug.** This is the biggest win, and it affects every map.
   * In `chase()`, the pallet-hold branch only calls `palletDecision` when
     `rectDist(me, pallet) <= 1.1`.
   * The hold point is the loop side point 1.6 m from the pallet centre, which is exactly 1.1 m from the footprint in
     exact arithmetic. In floating point it often comes out as 1.1000000000000014, so the check fails and the drop is
     never considered while holding.
   * Across the 35 shipped map files, **562 of 1078 pallet side points (52 %)** fail the check.
   * Fix: compare against `config.reach.pallet` (1.2) with an epsilon, or hold 0.1 m closer.
2. **A drop deadline taken from the real attack envelope.** Drop or leave as soon as the hunter's path distance to me
   is within about (0.3 s drop + 0.4 s windup) × 6.9 m/s + 2.2 m ≈ 5 m, whatever `stunSeek` says. Right now a third of
   first hits happen at a standing pallet with the hunter 1.2 m away.
3. **Choose loop entries by arrival race in path time, including the hunter's lunge.** The current test is Euclidean,
   `dmE < loopRace·dhP`.
   * Never take a crossing whose far side ends up on the hunter's side. Prefer the crossing that puts the anchor
     between me and the hunter.
   * In duel #0 the survivor walked 5 m into the hunter's path at t = 0.1.
4. **Recognise a pallet break and use its 2.34 s.**
   * Survivors cannot see that the hunter is breaking: `obs.hunter` has `vaulting`, but no "breaking" or "acting".
   * Infer it (the hunter stationary within 1.5 m of a dropped pallet), or have the engine expose
     `obs.hunter.act` / `progress` the way it already exposes vaulting.
   * Then leave immediately for the window, 5.4 m away. The champion's short holdMaxS shows what this is worth (+2 s)
     even without inference.
5. **Fast-vault discipline at windows.** 93 % of window vaults are medium.
   * Approach along the window axis: run-up point 2 m out, ≥ 2.5 m straight within 25°. That holds inside the shack
     as well.
   * When only a medium vault is possible, require about 1.5 m more gap.
   * If the vault is unsafe, take the other option (hold, mind-game, switch to the pallet door) instead of vaulting
     anyway. 37 of the first hits are mid-vault at the window.
6. **A post-hit sprint mode.** For 1.8 s after a hit, run the longest path toward the next useful crossing. Don't hold
   at a window exit and don't re-plan into the hunter. Bots get +4.5 m of the possible +8.3 m.
7. **Give open-field flee points a value for what comes after.** The current route scoring is the minimum gap over an
   8 s horizon along 12 rays, so the survivor runs into corners and dead ends.
   * Add a terminal term: the path distance from the flee point to the nearest usable crossing, or a dead-end
     penalty.
   * Allow a return to a known loop once the gap is large: after a hit the survivor had 14 m and an unused window.
   * `holdHorizonS = 2` helps a little (+1.5 s); `edgeAvoidW` doesn't.
8. Info the brain is missing, summarised: the hunter's current interaction (break, kick); whether my next vault will
   be fast, as an engine-side query (the brain re-implements `runD`); the hunter's cooldown remaining (`obs.hunter`
   has `cooldown` as a flag only).

## Hunter-side and harness findings (outside the survivor brief, worth knowing)

* **H1. Unguarded cluster leash.** `hunter.js` computes `leashBreak = clusterOn && clusterDist > leashDist && …`
  with `clusterDist = nav.dist(me, anchor)`. With unreachable gens that distance is Infinity, so every chase where the
  survivor is farther from the gens than the hunter gets abandoned and ignored for 15 s.
  * This includes the very first sighting at t = 0, and it caused the raw 77 s survival above.
  * The default hunter has clusterActivate 5, so the leash is on from the first second. The champion has 2.9, so it
    is off until 3 gens are done.
  * On real maps clusterDist rarely exceeds 150 m, but the Infinity case is unguarded.
* **H2. Belief patrol parks next to tall walls.** `belief.bestTarget` takes the peak of a 9 m kernel. Next to the
  shack, that kernel includes the interior, which the hunter cannot see from outside. So the hunter walks to the
  shack, re-picks the same peak on arrival (within 3 m), and dithers there for 90+ s (out of sight for 112/120 s in
  early runs). The target should be a point from which the hot cells are visible.
* **H3. Pallet breaking.** Even without the leash, the brain hunter breaks only 29 of the 55 pallets that get dropped.
  `palletBetween` is skipped when d ≤ 2 m, and `breakNearM` / detour gating apply. The survivor then ping-pongs over
  the dropped pallet (1.1 s pallet vault) while the hunter goes round through the window (1.7 s vault). With the leash
  bug this ran the full 120 s; without it, the 26 duels with an unbroken pallet last 12.9 s on average vs 9.4 s for all brain-mode duels.
  The harness's `strong` mode adds the break. Also from the leash-bugged runs: the hunter walks 0.8–1.0 m behind a
  visible survivor without swinging, because it has the survivor on its ignore list and is in "search lastPos" mode.
* **H4. Engine gap in the pallet-drop push-out.** It only moves actors whose *centre* is inside the footprint. A
  hunter whose body overlaps the footprint by less than its 0.4 m radius stays overlapping the now-solid cell and can
  stay stuck along the shack wall for the rest of the match. This was seen once (110 s stuck). The harness applies the
  intended push-out; `--noPushFix` turns that off.

## Files

* `maps/duel-shack.json`: the duel map.
* `scripts/duel-shack.js`: the duel runner. Options: `--n`, `--hunter strong|assist|brain`, `--compare`, `--mix`,
  `--champ`, `--sp knob=v`, `--spot`, `--health`, `--trace`, `--list`, `--out`, `--src`, `--noNeutralize`,
  `--noPushFix`, `--jitter`.
  * Per-duel record: time to first hit and to the down (KPI), window vaults by tier, pallet vaults, hunter vaults,
    pallet drop time and stun, break time, distance at the break, passes through each opening and laps, whether the
    survivor entered the shack, time inside, Bloodlust tier, window-blocker time and state, chases, how long the
    hunter was blind or stuck, and the cause of every hit with its position, distance, pallet and blocker state.
* Running all 190 duels takes about 5 s on one core.
