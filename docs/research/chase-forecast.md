# Survivor chase: hunter forecast, waiting vs running on, strong loops, the canary

Branch `feat/survivor-chase-forecast` (2026-11-16). Maps: the regenerated `maps/gas-heaven/` pool (probe tile at a random
slot, found via `map.mapgen.tiles`, `tile === 'infinite-loop'`).

## What was built

* `src/brains/hunterforecast.js` — where the seen hunter is going, 0.5–3 s ahead. Four motion models (pursue me along
  the walkable path / keep its velocity, sliding on walls / cut to the point I come out at / stand). Every prediction
  made 0.5 s ago is scored against the hunter's actual position when it is seen; weights = prior × exp(−error / 1.5 m),
  errors averaged over `fcLearnS`. So within a chase the survivor learns whether this hunter follows, commits round the
  tile or stands off. `commit(anchor)` = P(through / around / stand) for the anchor between us (visible vault, smoothed
  velocity vs the lane, the mixture's 1 s approach). Legit info only (seen hunter, last sighting, own plan).
* `survivor.js` uses it for: loop reversal / leaving (`fcReverseP`, `fcEntryMarginM`: P(the forecast hunter is at my
  next entry when I get there)); route scoring (`fcLeadS`: the hunter keeps its forecast course, then pure pursuit);
  the window-wait spot and the wait-vs-run-on comparison (`stationMode`, `holdBiasM`, `fcReactS`); the pallet far-side
  wait vs run-on (`palletRunOn`).
* Strong loops: `strongTravelW` (extra path to a loop = this × its expected distance held per chase) and `strongLoopW`
  (route value + this × (expected held per chase − one lap), i.e. the laps the vault budget still allows).
* Canary: `src/diag/canary.js` (`makeCanary(match, map)`, `mergeCanary`), `scripts/diag-canary.js`.
* Checks: `scripts/diag-chasepath.js` (probe-tile lapping + dead-end pocket, 1v1 vs the param hunter),
  `scripts/diag-holds.js` (what the hunter does while a survivor holds at a window).

## Why holdMaxS went up and holdW went to 0 (evo-v16)

* **Holding is genuinely good against these hunters, because the hunter walks into it.** `diag-holds.js` (default
  knobs, 12 matches): of 105 window holds ≥ 0.5 s, **56 % end with the hunter vaulting that window toward the survivor**
  (0 hits during holds). The survivor then has the 1.7 s vault animation to run (≈ 6.8 m). The default hunter has no
  window mind game (`standOffChance` 0, `reverseChance` 0); the champion has only `standOffChance` 0.175 / 0.5 s.
  Ablation on the defaults: `holdMaxS 0` → kills 3.70 → 3.89, duration 407 → 363 s. So the high `holdMaxS` is an
  exploit of a predictable hunter, not a survivor bug; the fix belongs in the hunter (its stand-off / bait knobs).
  The explicit "wait vs run on" comparison (`stationMode`) confirms it: leaving waits whenever the best route's
  min gap beats the wait's expected margin cost **+0.10–0.15 kills** at n=128 even with `holdBiasM` 10, so it ships off.
* **holdW is wired and changes behaviour, but its fitness signal is flat.** Against the evo-v16 champion hunter
  (n=64, champ survivor, only holdW varied): holdW 0 / 0.394 / 1.5 / 3 → kills 3.64 / 3.77 / 3.64 / 3.81 (noise ≈ ±0.1),
  while probe-tile chase share goes 1.9 % / 7.2 % / 15.7 % / 14.2 %. Against the default hunter it helps a little
  (holdW 0 / 1 / 3 → kills 3.78 / 3.70 / 3.59, old pool). The GA cannot see a difference that small, so holdW drifts.
* **It is mis-scaled in two ways**, which is why it can't be tuned in isolation: (1) `lap` is metres per lap with no lap
  duration, so a one-window hold "lap" (≈ 7.4 m in ≈ 2 s) is rated like a real multi-window loop; (2) open routes are
  scored as the min gap over `holdHorizonS` (evolved down to 2.27 s), loops as the gap until arrival (up to 15 s) +
  holdW × lap, so holdW and holdHorizonS trade against each other. `strongLoopW` adds a separate, budget-aware term
  (remaining laps under the entity blocker), which is what moved the canary.

## Distance-held machinery, end to end (`diag-chasepath.js`, 1v1, survivor knows the map)

* Dead end: a 5 × 12 m pocket straight away from the hunter is entered in **0/16** starts (baseline and now): the
  routes.js gap-over-horizon does penalise dead ends. Test added (`test-sim.js`, 4 starts).
* Probe tile: see the numbers table; test added (goes there and vaults ≥ 2 tile windows on ≥ 3 of 4 variants).

## Canary from the evolution worker

```js
import { makeCanary, mergeCanary } from '../diag/canary.js';
const m = createMatch({ map, seed, hunter, survivors }); const can = makeCanary(m, map);
while (!m.over) { m.step(); can.step(); }       // instead of runMatch(); O(4) per tick
const c = can.result();   // { tileChaseS, chaseS, tileShare, tileVaults, laps, tileChases, meanTileChaseS, ... }
```
Log `c.tileShare`, `c.laps` per match (or `mergeCanary(list)` per generation).

## Numbers (default knobs; baseline = the brain before this branch, same maps / seeds)

Shipped defaults: strong loops on (`strongTravelW` 0.5, `strongLoopW` 0.3); every forecast use, `stationMode` and
`palletRunOn` **off** (evolvable). n=128 full matches, `diag-canary.js` (seeds 1000–1127):

| config (n=128) | kills | esc | dur s | probe-tile chase share | tile laps / match | mean chase on tile vs elsewhere |
|---|---:|---:|---:|---:|---:|---:|
| baseline (all new knobs off = old brain, bit-identical) | 3.69 | 0.31 | 419.8 | 16.6 % | 1.23 | 16.8 s / 8.1 s |
| **shipped: strong loops** | **3.64** | **0.36** | **425.8** | **18.5 %** | **1.27** | 18.7 s / 7.8 s |
| + pallet run-on (holdBiasM 10) | 3.70 | 0.30 | 434.4 | 19.8 % | 1.50 | 17.8 s / 7.7 s |
| + window station (holdBiasM 10) | 3.79 | 0.21 | 419.3 | 17.1 % | 1.10 | 16.5 s / 7.3 s |
| + forecast reversal (fcReverseP 0.6) | 3.66 | 0.34 | 412.5 | 16.1 % | 1.08 | 16.6 s / 7.9 s |
| + forecast lead (fcLeadS 0.5) | 3.70 | 0.30 | 412.7 | 18.7 % | 1.34 | 17.5 s / 7.8 s |
| + lead + pallet run-on | 3.74 | 0.26 | 408.3 | 22.0 % | 1.57 | 15.8 s / 7.0 s |

Kills SE ≈ 0.05 at n=128: only the window station is clearly worse; strong loops are kill-neutral-to-positive and move
the canary. The first 64 seeds alone (`matchup.js --n 64 --map maps/gas-heaven`): baseline 3.56 / 0.44 / 3.16 gens /
417.5 s, shipped 3.66 / 0.34 / 3.25 gens / 418.6 s; that half favours the baseline, the other half the new defaults.

Other checks (shipped defaults vs baseline): post-vault standing 25.8 % vs 26.2 % (window holds kept: they pay against
this hunter; `stationMode 1` cuts it to ~10 %); shack duel 14.8 s vs 14.8 s; probe-tile 1v1 alive 45.0 s vs 45.0 s,
on tile 18.4 s vs 18.2 s, laps 0.75 vs 0.75 (with `stationMode 1, holdBiasM 10`: 47.0 s, 23.2 s, 0.97); dead end 0/16
both; dither 0 streaks; `test-sim.js` 1577 passed (18 new assertions).
