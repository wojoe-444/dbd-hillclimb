# Selection that sees: opponent panels, racing, sep-CMA-ES

Branch `feat/selection-fix` (base `feat/survival-time-fitness`). Follows step 0 of
[emergent-behaviour.md](emergent-behaviour.md): survivor fitness ICC ≈ 0.044 per match, so 16 matches per team
give a reliability of 0.42 and most knob movement was drift. The fitness definitions are unchanged.

## What was added (all flags off by default)

| flag | what it does |
|---|---|
| `--panel [spec]` | Each side is evaluated against a **panel** of opponents instead of random co-evolution pairings. `spec` = comma list of `kind:n`: `cur` (top n of the opposite side's last ranking), `hof` (n hall-of-fame champions spread over the archive), `default` (hand-tuned defaults), `mean` (opposite population mean / CMA mean). Default `cur:4,hof:3,default:1`. Duplicate parameter sets are dropped. |
| `--panel-fixed a,b` | Extra fixed opponents (any `resolveParamSet` spec, e.g. `v16=runs/evo-v16`). |
| `--slots N` | Slots per individual per generation (default `--rounds`). A slot is one (opponent, seed) pair; **every individual of a side plays the same slots** (common random numbers), so seed and opponent luck cancel in every comparison. A panel match counts for the evaluated side only. |
| `--hof-every k`, `--hof-size N` | Every k gens (default 5) the champion of each side (GA: rank 1; CMA-ES: the mean) joins its hall of fame (cap 20, thinned evenly so it spans the run; an unchanged champion is not re-added). Saved in `hof.json` and `population.json`. |
| `--race`, `--race-step s`, `--race-max M`, `--race-z z` | Racing (implies `--panel`). After the first `--slots`, an individual whose paired difference to the opposite side of the selection cut has \|z\| ≥ z (default 1.5) is decided in/out; the undecided contenders play `s` more slots (default slots/2) per stage, up to M (default 3 × slots). The cut is the GA elite count or the CMA-ES μ. Both sides' stages go to the pool as one batch. |
| `--opt cmaes`, `--cma-sigma`, `--cma-mirror`, `--cma-min-sigma` | sep-CMA-ES per side (diagonal covariance, Ros & Hansen 2008) over the knob vector normalised to [0, 1]. λ = `--pop`, μ = λ/2, starts at the defaults with σ₀ = 0.15. Samples are reflected into the box and the update uses the repaired points. `--cma-mirror` gives antithetic pairs. A σ floor (default 0.01) stops noise-driven collapse. Works with or without `--panel`/`--race`. |

Logged every generation (additive fields; the viewer is unaffected):

* `selection.{hunter,survivor}.rel`: reliability of the fitness means the ranking used. It holds the ICC, the reliability at the games actually played, the reliability at 16 games, the matches needed for 0.8, the Spearman-Brown split half, and the between/within sd. With `--panel` it is slot-centred: the shared per-slot effect is removed, because it can't change a ranking.
* `selection.*.persist`: the Spearman correlation of fitness for individuals ranked in two consecutive generations (GA elites).
* `selection.*.retest` (with `--reeval-top`): the main-round mean against the independent re-evaluation of the top K.
* `selection.*.race`: slots played, contenders per stage, how many were still undecided at `--race-max`, and matches.
* `perf`: matches/s, game-seconds/s, worker utilisation and ms per game-second per match per busy core.
* `ranking[].fitSd`: the per-individual match-to-match sd. `fit` and `games` are always shown in the new modes.
* `panel`: the panel member names. `cma.{hunter,survivor}`: σ, axis ratio, mean (knob units and normalised), and per-knob sampling sd.
* For CMA-ES runs, `ranking` and `knobs` describe the sampled population, so the viewer's knob charts work unchanged. `champions.json` holds the CMA mean, plus `bestSample`.

Throughput: the pool now hands out one job at a time from a shared queue instead of three static chunks per thread.
Matches last 100–900 game-s, so static chunks left cores idle at the end of every batch. Maps, brains and caches
were already loaded once per worker; that hasn't changed. Results don't depend on the thread count or the job order
(tested).

`scripts/diag-fitness-noise.js --mode common|random|panel|all` measures the same population under each evaluation
scheme and prints the slot-centred (CRN) reliability next to the raw one.

Tests: `node scripts/test-sim.js` (unit tests for the panel, hall of fame, slots, reliability estimator, racing and
sep-CMA-ES) and `node scripts/test-evolve.js` (~2–4 min). The second runs tiny evolutions on `test-small` and checks
two things. First, default flags reproduce the base `evolve.js` byte-for-byte: `evo.jsonl` matches after dropping
`seconds`/`perf`/`selection`/`fitSd`, and `population.json` and `champions.json` match exactly. Second, panel+race GA,
CMA-ES, and CMA-ES+panel+race give identical output on 3 vs 2 threads.

## Measurements

All on `maps/gas-heaven`, with the machine shared by many other agents (100 % CPU load before we started). Raw
logs are in this worktree's `runs/` (git-ignored): `diag-v16-modes.{log,json}`, `cmp-ga-base`, `cmp-ga-panel-race`
and `cmp-cmaes`.

### 1. The same population under three evaluation schemes (`diag-fitness-noise.js --mode all`)

This is evo-v16's final population (gen 80, the converged case the emergent-behaviour review measured): 24 survivor
teams × 24 matches each, 1,728 matches, 433 s.

| survivor teams | ICC per match | reliability @16 | @48 | matches for 0.8 |
|---|---:|---:|---:|---:|
| `random`: fresh seed + random hunter per match (today's `evolve.js`) | 0.064 | 0.52 | 0.77 | 59 |
| `common`: shared seeds + shared hunter k mod N, raw | 0.033 | 0.35 | 0.62 | 118 |
| `common`, slot-centred (what a CRN ranking sees) | 0.080 | 0.58 | 0.81 | 47 |
| **`panel`** (defaults + top-3 hunters, shared seeds), slot-centred | **0.112** | **0.67** | **0.86** | **32** |

With K = 24 the ICC estimates are themselves noisy (roughly ±0.03). The review's 0.044 (K = 32) sits inside the
random/common range. **Panel + common seeds about doubles the signal per match and cuts the matches needed for
reliability 0.8 by about 1.8× (59 → 32).** Racing then spends the extra matches only near the cut, where they matter:
contenders reach 48 matches (≈ 0.86 at the panel ICC).

### 2. In-run selection reliability: today's GA vs panel + racing (same seed, so the same gen-1 population)

pop 12 + 12, 3 gens, seed 7. Baseline: `--rounds 16`. After: `--panel cur:3,hof:2,default:1 --slots 16 --race
--race-max 48 --hof-every 1`. The table gives `selection.survivor.rel` (reliability of the 16-match means the ranking
used; slot-centred with `--panel`), then the hunter value in brackets.

| gen | baseline GA: rel (ICC) | panel + race: rel@16 (ICC) | race: contenders per stage → undecided at 48 |
|---|---|---|---|
| 1 (identical population) | 0.76 (0.17) [H 0.78] | **0.82 (0.22)** [H 0.83] | S 7,5,5,5,5 → 5 · H 8,8,6,5,5 → 5 |
| 2 | 0.28 (0.024) [H 0.54] | **0.84 (0.25)** [H 0.90] | S 5,4,4,4,4 → 4 · H 6,4,4,3,2 → 2 |
| 3 | 0.39 (0.038) [H 0.28] | **0.79 (0.19)** [H 0.09] | S 5,4,4,4,4 → 4 · H 11,9,… → 9 |

* **Survivors:** the baseline falls to the review's regime (ICC 0.02–0.04) as soon as the initial spread is gone.
  With panel + CRN it stays at 0.8 from 16 matches, and the 4–5 contenders at the cut get 48 matches each.
  Gens 2–3 aren't the same population in the two runs, so only gen 1 is an exact like-for-like comparison. Section 1
  is the like-for-like measurement on a converged population.
* **Hunters, gen 3: rel 0.09 under the panel.** That's the known saturation: hunter fitness is the outcome table,
  and against today's survivors (and the default team) nearly every match is a 4k. The panel shows this honestly
  instead of hiding it in pairing noise. Per the owner, it should fix itself as survivors improve. Racing correctly
  keeps 9 of 12 hunters undecided (they are tied).
* Rank persistence of the GA elites (`persist`) was 0.77/0.60 (baseline) and −0.2/0.94 (panel) for survivors. It
  comes from only 6 elites, so it's too small to read on its own. Over a long run it's the series to watch.
* Cost: the panel needs 2× the matches of co-evolution for the same per-individual count, because a match counts for
  one side only. Racing added about 100 % on top: 656–824 matches per generation vs 192.

### 3. sep-CMA-ES smoke

`--opt cmaes --cma-mirror --pop 8 --panel cur:2,mean:1,hof:2,default:1 --slots 8 --race --race-max 16 --hof-every 1`,
3 gens, 704 matches. The run is deterministic (test-evolve: identical on 3 vs 2 threads). σ went 0.150 → 0.143 →
0.140 → 0.136 (survivors), with no collapse. The mean, σ and per-knob sd are logged in `cma`. `knobs` and `ranking`
come from the sampled population, which the viewer reads as before. `champions.json` holds the mean. The step size
shrinks slowly under noise, as expected. The σ floor (0.01) and the hall of fame guard against premature
convergence. 3 gens prove only the plumbing, not progress.

### 4. Throughput

`perf` per generation (15 worker threads, shared box): **util 0.85–0.90** for the GA runs and 0.75–0.80 for the
small CMA run (small racing stages leave tails). Cost ranged from 3.8 to 14.7 ms per game-second per match per busy
core, depending on how loaded the box was; on a quiet box the owner's figure is ~1 ms. Matches/s ranged from 2.2 to
9.1. The pool now pulls jobs one at a time from one queue, both sides' racing stages share a batch, and maps, brains
and caches load once per worker.

## Recommended settings for the next long run

Assumed costs: ~1 ms per game-second per match per core, a match ≈ 400 game-s ≈ 0.4 core-s, and 15 workers at
util ≈ 0.87, which gives **≈ 32 matches/s ≈ 115,000 matches/hour** on a quiet box. Divide by the load factor while
the box is shared.

**Primary (GA, the known optimiser, with selection that sees):**

```
node src/hillclimb/evolve.js --pop 24 --panel cur:4,hof:3,default:1 --panel-fixed v16=runs/evo-v16 \
  --slots 24 --race --race-step 8 --race-max 72 --hof-every 5 --hof-size 20 \
  --bench-every 5 --bench-opponents v16=runs/evo-v16 --gens 60 --seed 1 --out runs/evo-v18
```

* Per generation: 2 × 24 × 24 = 1,152 base matches, plus racing for about 5–8 contenders per side × 48 ≈ 600, so
  about 1,750 matches ≈ 55 s on a quiet box. 60 gens ≈ 1 h (several hours on today's shared box).
* Survivor reliability: 24 slots at the converged panel ICC 0.11 → **0.75 for everyone**. Contenders at the cut go to
  72 → **0.9**. Today's 16 random matches give 0.35–0.52.
* `--panel-fixed v16` gives every generation the same external yardstick. The hall of fame stops cycling and
  forgetting. Watch `selection.survivor.rel.rel` (should stay ≥ 0.7) and `persist`.
* Run a **second seed** (`--seed 2`) when cores allow. Agreement of knob regions across seeds is the test the review
  proposed.

**Second arm (when there are cores for it): sep-CMA-ES** on the same evaluation:

```
node src/hillclimb/evolve.js --opt cmaes --cma-mirror --cma-sigma 0.15 --pop 24 \
  --panel cur:3,mean:1,hof:3,default:1 --panel-fixed v16=runs/evo-v16 --slots 24 --race --race-max 72 \
  --hof-every 5 --bench-every 5 --gens 60 --seed 1 --out runs/evo-v18-cma
```

Use CMA-ES for anything with many weights (the `ctx` brain or a utility layer). It uses every rank, not just the cut,
so each match buys more. Compare the two arms' `bench` lines against v16 every 5 gens.

Don't combine `--panel` with `--reeval-top` (rejected) or `--carry` (allowed, but the panel changes each generation,
so carried means mix opponents).
