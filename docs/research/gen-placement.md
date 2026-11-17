# Generator placement: authored slots and seeded distribution

Research and implementation: 2026-11-16. Baseline: `87f50be634638c82bd0a2083acf0230708f1416c` on `feat/survival-time-fitness`. Implementation branch: `feat/gen-placement`.

The old pipeline distributed 11–12 map candidates, then uniformly shuffled seven into each match. Its candidate spacing target silently fell below 20 m when packing became difficult. This change makes candidate spacing strict, moves the shack's optional generator indoors, and selects seven from feasible distributions instead of arbitrary subsets. All final candidates retain four repair sides and the owner's 6 m outline inset.

## Evidence and its limits

Public documentation does not expose BHVR's complete generator matching code. The implementation below models supported principles; its numeric limits and uniform-subset sampler are explicit simulation choices.

| Question | Evidence | Confidence and implication |
| --- | --- | --- |
| Seven generators, five required? | The [Generator wiki](https://deadbydaylight.wiki.gg/wiki/Generator) describes seven generators selected from more possible, predetermined locations, with five repairs required in a regular four-survivor trial. | Established player-facing behavior; wiki is a community-maintained secondary source. Keep seven/five and authored slots. |
| How many candidate locations? | The same wiki confirms more locations than spawned generators, without giving a universal total. [Hens' callout maps](https://hens333.com/callouts) provide map/landmark diagrams, credited to Lethia and the community. They do not publish an exhaustive spawn census or a distance-distribution dataset. | **No verified universal candidate count.** Eleven–twelve is our existing asset/performance budget, not a researched live-game constant. Tiles and map variants can change the number of available points. Do not turn informal “10–12” estimates into a BHVR rule. |
| Minimum distance or an evenly spaced ring? | BHVR's [6.5.2 notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/374-6-5-2-bugfix-patch) fix overly close RPD Main Hall generator spawns. [Peanits' January 2024 explanation](https://forums.bhvr.com/dead-by-daylight/discussion/401969/these-3-gen-solution-changes-seem-worrisome) says moving generators farther apart can require larger maps, affecting travel and search; mobile killers can still defend them. | Solid evidence that inappropriate proximity is corrected, **not** evidence of one universal metre threshold, quadrant quota, or mandatory central generator. No published universal 20/24/32 m formula was verified. |
| What did anti-three-gen change? | [7.0.0 PTB](https://forums.bhvr.com/dead-by-daylight/kb/articles/389-7-0-0-ptb) strengthened Déjà Vu against nearby triples. [7.5.0 live](https://forums.bhvr.com/dead-by-daylight/kb/articles/430-7-5-0-alan-wake) capped killer-induced regression events at eight, raised kick loss to 5%, and required 5% repair to cancel regression. | These address persistent defense and regression. They do **not** promise that no defensible triple can spawn. Our placement work does not change regression mechanics. |
| Has BHVR changed distribution/layout? | BHVR's [2023 anniversary update](https://deadbydaylight.com/news/anniversary-gameplay-updates/) committed to map balance including tile and generator/totem placement, mentioning earlier Gas Heaven/Blood Lodge work and upcoming Coldwind changes. [8.0.0 PTB](https://forums.bhvr.com/dead-by-daylight/kb/articles/449-8-0-0-ptb) fixed two generators spawning in one Underground Complex room. | Official evidence for map-specific authored placement and exclusion fixes. Neither supplies a global spread algorithm or guarantees every tile has a generator. One-per-tile in this sim is a conservative room/landmark approximation. |
| Guaranteed main building and shack? | [Gas Heaven's wiki](https://deadbydaylight.wiki.gg/wiki/Gas_Heaven) identifies a garage generator that opens the door. The [Killer Shack wiki](https://deadbydaylight.wiki.gg/wiki/Killer_Shack) describes its generator as optional. | Landmark-specific rules exist. A shack is **not** universally guaranteed a generator. Do not infer that every main building on every map must spawn one. Our present tile set lacks the actual gas station/garage; this remains a documented map-fidelity gap rather than inventing a guarantee on another landmark. |
| Indoors, edges, corners, loops and dead zones? | Authored indoor locations are directly supported by the garage and shack examples. BHVR's [3.1.0 Badham notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/58-3-1-0-mid-chapter) varied repair-side availability across tiles. | Live generators can be indoors and can have fewer than four usable sides. We found no authoritative universal edge inset, corner ban, loop-distance quota, or spawn-to-gen exclusion radius. The 6 m inset and four usable sides are **owner rules**, stricter than live DBD. Keep both loop-adjacent and open/dead-zone slots, and measure their mix. |

An older [2021 player explanation on BHVR's forum](https://forums.bhvr.com/dead-by-daylight/discussion/comment/1903512) describes sequentially choosing predefined points, excluding locations near chosen generators, adjusting for floors/obstructions, and restarting failed allocations. This is useful community context, **not a developer specification or independently verified current implementation**. Likewise, player screenshots show that clusters occur but cannot calibrate probabilities, patrol routes or a universal threshold. No defensible measured Hens spacing dataset was found; this report does not invent one.

## Pipeline audit

1. `tiles.js` defines authored `G` points, transformed with each tile's rotation and mirror. Sixteen of 26 templates have one generator slot: shack; three maze families; two car piles; T+L; both jungle gyms; four large filler/variant tiles; and `dead-gen`, `dead-tree`, `dead-car`. The remaining templates, including the infinite-loop probe, have none. Slot existence does not guarantee a candidate or a match generator.
2. Previously `generate.js` filtered slots against floor, nearby windows/pallets, four walkable neighbors and the 6 m outline inset. It weighted new candidates by squared distance to the nearest chosen candidate. On failure it lowered spacing in 2 m steps, potentially down to 6 m. The nominal 20 m layout target was therefore not an invariant. The measured shipped pool contained a 14.56 m candidate pair.
3. `prepareMap` makes **all** emitted candidates static solid blocks. Unselected ones remain inert wrecks so navigation fields are reusable. This existing sim deviation is preserved; live unused spawn points need not have a physical generator wreck.
4. `Match` shuffled candidate indices using the world RNG, took the first seven, and sorted them for stable IDs. It performed no distance/distribution check. Random omission could leave a tight triple and a large objective-free area despite map-level candidate spreading.
5. Actor spawning follows generator setup: grouped survivor positions around a seeded perimeter anchor and a hunter spawn on the far side. No researched generator-to-actor exclusion radius was established, so this task measures those distances without changing spawn rules.

## Rules implemented

### Candidate placement

- Keep 11–12 candidates, authored tile slots, and at most one candidate per tile instance. No arbitrary floor-cell fallback.
- Require a plain-floor 3×3 footprint around the slot. This protects all four repair-side cells and their diagonal approaches from walls, windows and pallets. Other selected candidates cannot obstruct them because pair spacing is at least 20 m.
- Keep every candidate center at least 6 m from **every segment of the actual outline**, including stepped concave boundaries, using `outlineInset`.
- Keep all candidate pairs at least **20 m Euclidean** apart. Try up to 96 deterministic weighted packings instead of lowering spacing. Reject an unsuccessful map seed through the existing mapgen retry mechanism.
- Check match-selection feasibility before accepting a packing. **Every emitted candidate must occur in at least one feasible seven-generator subset.** This avoids permanently dormant “candidate” points and guarantees more than one available match layout for an 11–12 candidate map.
- Move the shack slot from outside its corner to local `(7,8)` indoors. A `genSlots` metadata override transforms with the tile; the ASCII collision geometry, including all owner-protected wall/window/pallet hashes, is unchanged. Shack is optional in both candidate packing and match selection. No generator is added to the infinite-loop probe.
- Use a dedicated mapgen candidate RNG stream, so the number of failed packing attempts does not consume downstream spawn/hook randomness. The generator version becomes `mapgen/gas-heaven@3`.

### Final seven in the engine

Generated maps declare `generatorRules`. `src/sim/gen-selection.js` enumerates feasible subsets and samples one uniformly using the seed's `generator-placement` stream:

| Constraint | Limit | Purpose |
| --- | --- | --- |
| Pairwise center distance | ≥ 24 m | Exclude close active neighbors even where map candidates are only 20 m apart. |
| Every triple's center-to-center perimeter | ≥ 80 m | Remove the smallest geometric clusters without forbidding ordinary three-gen defense. |
| Every candidate's distance to its nearest active generator | ≤ 40 m | Keep the selected objectives spread over the authored candidate footprint. |

All three use Euclidean distance on this single-floor map. The limits are deliberately modest simulation approximations, **not BHVR constants or claims about its actual sampling probabilities**. Coverage is of candidate locations, not every floor cell or every quadrant. The sampler does not maximize minimum distances or insist on a perfect ring. Moderate triples and varying landmark participation remain possible; walls, line of sight, killer powers and survivor completion order can still make them defensible.

Feasible subsets are cached by prepared map and count/rules. An impossible policy throws explicitly instead of silently reverting to a cluster. Maps without `generatorRules` retain the exact prior shuffle and RNG consumption. The world shuffle is still consumed for generated maps; the new subset choice uses its separate stream, preserving actor spawn randomness on identical geometry.

**Exact engine scope:** `match.js` adds the selector import and replaces only the shuffle/slice block with `selectGenerators(...)`. The new helper contains selection and its cache only. `src/sim/README.md` documents the contract. No movement, navigation, collision, repair, regression, spawn, outcome, brain, viewer, hillclimb or `runs/` behavior is edited.

## Measurement method

`scripts/audit-gen-placement.js` audits **32 variants × 128 actual match initializations**, seeds **1000–1127** per variant (4,096 distributions per condition). It never ticks brains. Raw aggregate JSON is retained alongside this document.

- Euclidean distances are generator-center distances.
- Walking distances use the engine's 8-connected navigation graph (1 m orthogonal / 1.414 m diagonal; no corner cutting), pallets up, with zero window-time penalty. Pair distances run between the closest accessible repair-side cells, rather than through solid generator centers. These are geometric path lengths, not traversal times or a killer's route with dropped pallets.
- A “three-gen tour” is the minimum over all 35 triples of the sum of their three pairwise shortest repair-side distances. Different pair legs can use different sides, making this a **patrol-distance proxy/lower bound**, not a fully connected optimized killer patrol. A tour below **80 m** is our predeclared “tight” proxy (about 17.4 s at 4.6 m/s without turns/interactions); it is not a proven live-game defensibility test.
- Nearest-gen distributions contain one value per generator. Closest-pair and minimum-tour distributions contain one value per map/match. Pair distributions contain every unordered pair. Candidate statistics weight each candidate/pair; each variant contributes equally many match seeds.
- “Dead tile” means its tile has no rated loop after optional pallet rolls. “Far from loop” means the closest repair side is more than 12 m of walking from any initial pallet/window, including the preserved probe. These are different proxies; a generator in a dead tile can have a loop in a neighboring tile.
- Spawn distances use actual hunter and four survivor positions from `Match`, including survivor scatter. They are shortest distances to an active generator's nearest repair side. A zero is possible if a survivor starts on a repair-side cell; it does not indicate overlap with a generator.
- Candidate coverage includes selected candidates at distance zero. Its maximum shows the largest omitted-objective gap under that proxy.

The earlier `survivor-weakness.md` figures (22.96 m closest pair and 96.27 m triple tour, range 62–132 m) were measured on an earlier map/code revision with a different endpoint/sample setup. They are context, not the before column. The before column here was rerun on the exact current base with the same audit program and seeds as the after column.

## Before/after distributions

Raw aggregates: [before](gen-placement-before.json), [after](gen-placement-after.json). Distances below are metres; p05/p95 are empirical quantiles, not confidence intervals.
The [comparison chart](gen-placement-comparison.html) shows the main distance changes.

| Candidate-pool metric | Before | After |
| --- | ---: | ---: |
| Count per variant, mean (range) | 11.59 (11–12) | 11.28 (11–12) |
| Minimum Euclidean pair distance | 14.56 | **20.00** |
| Mean Euclidean pair distance | 48.70 | 50.72 |
| Mean walking pair distance | 51.11 | 53.36 |
| Nearest-generator distance per candidate, walking mean | 21.70 | 24.27 |
| Closest pair per variant, walking mean | 17.58 | 20.46 |
| Minimum three-gen tour per variant, walking mean | 66.67 | 73.27 |
| Edge distance, minimum / mean | 6.04 / 19.32 | 6.04 / 18.61 |
| Candidates without four usable sides | 0 | 0 |

The candidate pool intentionally contains some triples that would be too tight **if all three were selected**. The final selector is responsible for mutual exclusion; increasing every candidate distance to match active-generator distances would confuse two different stages.

| Final-seven metric | Before mean | After mean | Before p05–p95 | After p05–p95 |
| --- | ---: | ---: | ---: | ---: |
| Pairwise Euclidean distance | 48.90 | 53.70 | 20.40–83.74 | 26.02–89.32 |
| Pairwise walking distance | 51.31 | 56.56 | 20.83–88.80 | 26.80–94.76 |
| Each gen's nearest neighbor, Euclidean | 24.96 | 29.56 | 16.97–39.20 | 24.17–40.11 |
| Each gen's nearest neighbor, walking | 25.54 | 30.58 | 16.83–41.14 | 24.21–42.14 |
| Closest pair per match, walking | 19.71 | **26.03** | 15.48–24.24 | 23.41–29.73 |
| Minimum three-gen tour, Euclidean | 78.37 | 94.14 | 61.05–97.68 | 81.89–110.14 |
| Minimum three-gen tour, walking | 80.58 | **97.93** | 62.52–101.45 | 84.76–115.59 |
| Edge distance | 19.25 | 17.78 | 9.50–35.50 | 10.50–36.50 |
| Distance from repair side to nearest initial pallet/window | 7.59 | 8.01 | 3.41–16.31 | 3.83–18.00 |

- The smallest active Euclidean pair increases from **14.56 to 24.00 m**. Closest-pair walking values span **14.24–31.31 m before**, **22.83–32.80 m after**; repair-side distances can be shorter than center spacing.
- Minimum three-gen walking tours span **53.55–124.01 m before**, **80.66–133.73 m after**. The under-80 m tight-triple proxy falls from **49.83% to 0.00%**; its Euclidean counterpart falls from **58.15% to 0.00%**. These percentages describe the existence of a tight triple among all seven at match start, not how often survivors eventually leave one.
- The worst candidate-coverage gap falls from **63.70 to 40.00 m** (means including selected candidates: 9.39 → 8.88 m). This reduces empty portions of the candidate footprint without moving generators onto the wall; minimum edge inset remains **6.04 m**.
- Active generators in tiles rated dead remain common: **48.42% → 50.49%**. Generators more than 12 m walking from an initial pallet/window change **17.70% → 16.07%**. The placement does not turn every generator into a safe-loop objective or ban dead-zone repair.

| Actual spawn metric, walking | Before mean | After mean | Before p05–p95 | After p05–p95 |
| --- | ---: | ---: | ---: | ---: |
| Survivor to nearest active generator | 22.26 | 19.35 | 6.00–43.83 | 5.41–36.66 |
| Survivor to every active generator | 59.92 | 61.31 | 16.14–102.04 | 14.66–105.32 |
| Hunter to nearest active generator | 21.91 | 18.69 | 6.66–42.90 | 5.66–38.07 |
| Hunter to every active generator | 61.64 | 62.74 | 15.66–104.59 | 13.48–107.94 |

Wider distribution does not imply a longer initial search: nearest generators are closer to both roles' perimeter spawns on average, while average distances to all seven grow slightly. Spawn-to-gen distances remain measurements, not newly imposed exclusions.

Regeneration used the requested `--count 32 --seed 1 --render 4`: **63 rejected map attempts**, comprising **54 infeasible candidate/distribution packs** and **9 pallet-budget failures**. All 32 variants then passed validation. Nineteen variants accepted a different map seed than the baseline, so their tile geometry also rerolled; the other thirteen retain the same landmark/tile rolls. Feasible seven-gen subset counts range **9–124**, with every candidate represented in at least one subset. These are small, bounded enumerations (at most 792 possible seven-of-twelve subsets).

### Isolating match selection from regenerated geometry

The audit's `--legacy-selection` switch removes only the selection-policy metadata from the new maps, retaining their candidates, collision grid and actor RNG. Repeating the same 4,096 seeds produces this ablation; [raw aggregates](gen-placement-legacy-selection.json) are included.

| Condition | Mean closest pair, walking | Mean minimum three-gen tour, walking | Tour under 80 m | Worst candidate coverage gap |
| --- | ---: | ---: | ---: | ---: |
| Original pool, original shuffle | 19.71 | 80.58 | 49.83% | 63.70 |
| Regenerated pool, original shuffle | 22.08 | 86.58 | 28.05% | 64.03 |
| Regenerated pool, constrained selection | 26.03 | 97.93 | 0.00% | 40.00 |

Candidate placement alone reduces tight triples, but still permits them in more than a quarter of match initializations. On identical new geometry, the final-seven selector removes the remaining under-threshold triples and limits large omitted-objective gaps. This ablation isolates the geometric selection effect; no extra full-match outcome claim is inferred from it.

### Match outcomes

`node scripts/matchup.js --n 64`, default param hunter/survivor brains and parameters, the default **tile variant pool**, seeds **1000–1063**. Its normal map rotation gives each variant two matches. No champion file or evolved parameters are used.

| Mean per match | Before | After |
| --- | ---: | ---: |
| Kills | 3.39 | 3.58 |
| Escapes | 0.61 | 0.42 |
| Completed generators | 3.56 | 3.25 |
| Hooks | 7.20 | 7.44 |
| Duration (seconds) | 437.36 | 435.48 |

Survivor outcomes **worsened** in this sample despite improved geometric distribution. This is not evidence of improved survivor balance, nor does it isolate a causal effect of spacing: 19 map seeds/tiles changed, and the existing brains react to both objective and loop locations. The goal here is a defensible placement model, not tuning generator positions to a desired kill rate. No unrelated brain or terminal-rule changes were made to hide that result.

Final verification: **26 templates / 624 transformed resolutions / all 32 maps passed `test-mapgen`**; **1,620 passed, zero failed in `test-sim`**; `check-gen-slots` reports **34 shipped maps / 383 candidates, all with four usable sides**. `git diff --check` is clean.

## Reproduction and verification

```powershell
node scripts/audit-gen-placement.js --seeds 128 --out before.json
node scripts/matchup.js --n 64
# Apply this change, then:
node scripts/gen-maps.js --count 32 --seed 1 --render 4
node scripts/test-mapgen.js
node scripts/test-sim.js
node scripts/check-gen-slots.js
node scripts/audit-gen-placement.js --seeds 128 --out after.json
node scripts/audit-gen-placement.js --seeds 128 --legacy-selection --out legacy-selection.json
node scripts/matchup.js --n 64
```

The audit can also target an exported baseline pool with `--map <directory>`. Mapgen invokes `analyzeMap` from `scripts/validate-map.js` for every variant; `test-mapgen` independently validates the shipped pool again. The validator now rejects malformed or infeasible declared match-selection limits.

`test-mapgen.js` was extended, without weakening existing assertions: protected geometry, all tile transforms (including indoor slot transforms), deterministic map regeneration, rejection of impossible candidate packing, candidate spacing/inset/four sides, **every feasible subset's** spacing/tour/coverage, every candidate's selectable status, 128-seed warm/cold selection, actual engine integration, unchanged actor spawning, legacy shuffle compatibility, explicit impossible-policy failure, and an independent brute-force subset oracle. `test-sim.js` is unchanged.

Generated JSON, pool index, four SVG/PNG renders and the generated tile report are included. Retry-driven changes to map seeds/tiles mean the combined matchup comparison measures the regenerated pool plus selection policy; it cannot attribute all outcome changes solely to generator distances, and 64 matches are not a live-DBD balance estimate.
