# Tile accuracy: Autohaven collision library

Research/checks: 2026-11-16. Baseline: `a9dd0d0dc43667a4c4332fdd319cadf04955e472`.

The arbitrary multi-room mazes, car enclosure and window-L filler have been replaced with recognizable DBD tile families. Small fillers now use paired wrecks, scrap/tyres or rocks with usable pallet gaps. The unused invented gas-station building was removed. The library has **26 tiles, down from 27**. This is a reference-informed, metre-grid collision approximation, **not a measured extraction of DBD assets**.

The owner-preserved T+L, shack, short/long gyms and infinite probe have byte-identical row arrays. Their landmark slots and the MID overlays are unchanged. The shack remains unmirrored; the two gym slots still receive exactly one v1 and one v2. Rotations, gym ordering and surrounding rolls can change on regeneration because replacement tiles consume different random draws. The 6 m generator inset and 26 m hook walking coverage remain enforced.

## Evidence and dimensional limits

**What is measured:** the community wiki measures outdoor maps using repeating **8 m outer-wall segments**; its square-tile unit is 8 x 8 m. Gas Heaven's documented footprint is **156 such units / 9,984 m²**, matching this project's outline. The wiki explicitly distinguishes this area unit from gameplay tiles and says official map measurements are unavailable. [Map measurement methodology](https://deadbydaylight.wiki.gg/wiki/Maps_%28Realms%29), [Gas Heaven](https://deadbydaylight.wiki.gg/wiki/Gas_Heaven).

**What is a reference convention:** the community layout guide describes ordinary outdoor gameplay tiles as **16 x 16 m**, assembled from four 8 m units. Its diagrams distinguish the long/short gyms, T+Ls, pallet gyms and inside/outside four-lanes. The owner's `docs/ref/tile-library-loops.png` agrees on the four protected standard layouts. These are shape references, not scale drawings of individual walls. [Layout and tile guide, updated for PTB 7.4.0](https://steamcommunity.com/sharedfiles/filedetails/?id=2904838739&l=english).

**What is estimated here:** individual wall lengths, prop collision rectangles, window offsets and pallet widths. None of the inspected references supplied a survey of real jungle-gym wall lengths or a measured shack side length. Therefore the 7-13 m wall runs below are **implementation dimensions**, not a claim that BHVR's walls have those exact dimensions. New props use plausible rounded footprints: wrecks approximately 2 x 5 m, stacks 2 x 7-8 m, rock clusters 2 x 3 through 4 x 4 m. New pallet openings are 2 m; a window remains one grid cell. Precise real-world tolerances require in-game timed movement measurements or collision assets, which were not available for this pass.

Hens' [callout maps](https://hens333.com/callouts) are useful for landmark placement and the clock system; the page credits its images to Lethia. They do not establish wall dimensions. Otzdarva's [guide index](https://www.otzdarva.com/) links [All Common Tiles Explained](https://www.youtube.com/watch?v=E5QWNS14MS0) and a dated map tier list. The video could not be fetched, so no measurements or video-specific assertions here are attributed to it. Tier rankings are context for map strength, not collision blueprints. Direct wiki opens sometimes returned 403; indexed wiki text was available through web search.

## Real design rules used

The [maze-tile reference](https://deadbydaylight.wiki.gg/wiki/Maze_Tiles) identifies these families: T+L = two windowed walls; jungle gym = one window and one pallet on opposite sides, with short/long window variants; pallet gym = C/L walls and one pallet, no window; four-lane = four parallel walls, one window, one pallet, with inside/outside vault alternatives; variant gym = five wall segments with the window near the front of the left wall. Unused vault positions are openings, not additional windows. This excludes the old arbitrary two-window zig-zag and optional multi-pallet room mazes.

The [killer-shack reference](https://deadbydaylight.wiki.gg/wiki/Killer_Shack) specifies one window and two doorways, one containing the pallet. The retained 10 x 10 m envelope reproduces that arrangement; its exact size is an owner-preserved approximation. The isolated shack pallet is the library's sole **god pallet**. Here “safe” means a dropped pallet generally forces a substantial detour/break against an ordinary M1 killer; “unsafe” means short or visible enough to play around. “Strong” also includes good windows and chaining, and is **not synonymous with safe pallet**. These are qualitative judgments, not engine bonuses or guarantees against killer powers. [Community terminology](https://forums.bhvr.com/dead-by-daylight/discussion/comment/1895847), [pallet safety guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3530126038).

The [March 2023 developer update](https://forums.bhvr.com/dead-by-daylight/kb/articles/382-developer-update-march-2023) explicitly split Gas Heaven's long car piles into navigable single-tile chunks, added potential pallet positions and revised the station's window/pallet combinations. That supports separated car/stack loops and optional edge fillers rather than car-ring mazes. It also describes separating maze tiles on Blood Lodge to reduce chaining. [Patch 9.2.0](https://support.deadbydaylight.com/hc/en-us/articles/41607788392212-9-2-0-Sinister-Grace) later unified available maze layouts across realms and adjusted pallet distribution to reduce dead zones. Older realm-exclusive lists and old screenshots should therefore not be treated as current universal restrictions.

Coldwind's [cow tree](https://deadbydaylight.wiki.gg/wiki/Sacrificial_Tree) is a stone-wall landmark with a window and a pallet, not two bare tree trunks with a pallet between them. It was researched but not transplanted into Gas Heaven. Likewise hay bales and harvesters were not used as Autohaven filler. The [Gas Heaven station description](https://deadbydaylight.wiki.gg/wiki/Gas_Heaven) has a shop/garage, alternate window openings and a generator-controlled garage door. The removed `main` tile's three simultaneous windows, internal safe-window corridor and 2-5 pallets did not reproduce it. The owner's T+L replacement stays at (48,16); this task does not restore a station there.

Natural rocks are collision and LOS blockers, not automatically vaultable objects. DBD's [window rules](https://deadbydaylight.wiki.gg/wiki/Window) explain that an intentional vault can look like another kind of prop (for example a fallen trunk). I found no sufficiently specific reference for a standard vaultable-rock Autohaven filler to copy, so did not invent one by putting a window into a boulder. `R` remains opaque and `r` low; neither becomes vaultable. Low props, windows and pallets retain the existing 0.6 sight factor; no sight or movement rules changed.

### Density, spacing and dead zones

There is no verified fixed Gas Heaven pallet/window count in the inspected sources. Counts depend on patch, random tile selection and opening variants. A [2023 report](https://forums.bhvr.com/dead-by-daylight/discussion/comment/3430365) gives an anecdotal 8-vs-20-pallet comparison, while [2025 Autohaven feedback](https://forums.bhvr.com/dead-by-daylight/discussion/459054/autohaven-wreckers-realm) describes increased density. These are evidence of variability, **not measured spawn bounds**. We retain the project's **14-24 pallet budget**, rather than presenting it as an official Autohaven rule.

The [pallet reference](https://deadbydaylight.wiki.gg/wiki/Pallets) describes procedural predetermined spots and 14/16/18/20 m spacing routines, with exceptions. Neither that page nor Hens' callouts establishes a universal metre gap between every tile. Our unchanged 8 m placement grid, open tile borders and weighted 16 m footprints allow chaining. Across the regenerated pool the mean nearest-pallet distance is **15.17 m** (previously 14.20 m); the minimum is **7.07 m** (previously 3 m), so the generator does **not** enforce that historical spacing routine. No close-pallet spacing exemption is being claimed as an exact replica.

No reliable measured Gas Heaven dead-zone percentage was found. The preserved MID walls, four-window probe, T+L in place of main, extra possible gyms, and high weight on unloopable tall rocks are deliberate departures from a vanilla map. They prevent claiming exact real-map balance or dead-zone frequency even with a better tile library.

## Every original tile audited

Dimensions are measured directly from the original ASCII grid unless noted. “Approximation” means family/topology supported by references, with metre-exact scale unverified. All four protected standard templates keep their existing dimensions, including copies selected outside landmark slots.

| Original ID | Real correspondence and original accuracy | Change / resulting implementation |
| --- | --- | --- |
| `main` | Not a faithful Gas Heaven station: invented 24 x 20 m box inside a 32 m footprint, three windows, internal corridor, 2-5 pallets. Not placed by this layout. | Removed unused tile; no replacement landmark and no effect on fixed T+L. |
| `shack` | Real shack arrangement. 10 x 10 m outer collision envelope, 8 x 8 m inside, 2 m doors, 1 m east window. Scale approximate. | Protected rows unchanged; god pallet, one window. |
| `maze-a` | No verified box-in-box standard tile. Approximately 14 x 13 m broken enclosure, internal C, one window and up to three optional pallets. | `pallet-gym`: long C spanning 10 m and 6 m short L, separate rear pieces, one guaranteed 2 m pallet, zero windows. |
| `maze-b` | No verified two-window zig-zag standard. Fragmented walls with two optional pallets; counts and connections unlike a standard gym. | `four-lane-open`: four 11 m parallel runs, 2-3 m clear lanes, outside window, unused inside window is a hole, one guaranteed pallet. |
| `maze-c` | No verified corridor/pocket-room standard. One window and two independent optional pallets could form a fantasy room maze. | `four-lane-closed`: same footprint, inside window and outside hole, one guaranteed pallet. |
| `carpile-a` | Scrap/car theme is real; a 13 m broken ring around a central island with three one-cell pallet spots is not a verified Gas Heaven chunk. | `carpile-long`: two separated 2 x 8 m stacks and a 2 x 5 m wreck; at most one of two 2 m pallet spots, 80% chance. No enclosure. |
| `carpile-b` | Real scattered-wreck family, inaccurate scale: small 2 x 2 / 3 x 2 chunks, one-cell lines, three pallet alternatives. | `carpile-short`: three 2 x 5 m wrecks/stacks, at most one of two 2 m gaps, 75% chance; visible, unsafe loop. |
| `tl-wall` | Real T+L topology, two windows and no pallet. T crossbar 7 m, stem 7 m including intersection; L upright 5 m and foot 6 m. Scale approximate. | Protected rows unchanged at (48,16) and in random copies. |
| `jgv1` | Real short-wall gym and matches supplied loop diagram: 7 m window run / 6 m L side, divided opposite wall, 2 m pallet, one window. Scale approximate. | Protected rows unchanged; safe pallet. |
| `jgv2` | Real long-wall gym and matches supplied diagram: 13 m window wall, 7 m inner cross-run, 2 m pallet, one window. Scale approximate. | Protected rows unchanged; safe pallet. |
| `filler-wallcar` | Wall-to-wreck pallet is plausible, but 8 m paper-thin wall facing a 2 x 3 m “car” gives the wrong detour lengths. | Retains ID; 2 x 7 m tall scrap stack facing 2 x 5 m car, 2 m optional pallet, 65% chance, safe long filler. |
| `filler-rock` | Rock filler is real; original 4 x 3 m rock-to-thin-wall one-cell pallet is not a verified copy. | Retains ID; 4 x 4 and 3 x 4 m rock groups, 2 m optional gap, 65% chance; unsafe alone. |
| `filler-windowl` | Isolated 10 m window-L with an independent pallet in its upright is not a verified filler tile. It adds both a window and optional safe loop without the rest of a gym. | `variant-gym`: five separate segments, 10 m left window wall, central/right front pallet, two rear pieces; one guaranteed pallet and one window. |
| `filler-junk` | Low junk is real, but the zig-zag low-wall arrangement is not a verified Autohaven copy. One-cell pallet. | Retains ID; paired 3 x 4 m low tyre/scrap groups, 2 m optional gap, 60% chance, unsafe. |
| `small-lowl` | Bare 6 m low L with an embedded one-cell pallet is not a verified named edge filler. | `small-junk`: two 2 x 3 m low prop groups, 2 m optional gap, 55% chance. |
| `small-rock` | Real rock-filler concept, but a 3 x 3 m rock against a one-cell wall/post makes an artificial short loop. | Two 2 x 3 m rocks, 2 m optional gap, 55% chance; unsafe. |
| `small-tree` | Two 2 x 2 m trunks with a one-cell pallet are not a cow-tree tile or a verified Autohaven copy. | `small-tires`: two 2 x 3 m tall/low scrap/tyre groups, 2 m optional gap, 55% chance. |
| `small-car` | Real two-wreck filler, but cars were 2 x 3 m. | Cars lengthened to 2 x 5 m, existing 2 m optional pallet gap / 55% chance retained. Visible and mindgameable. |
| `dead-empty` | Real open space between features; 8 m placement unit, not a named loop. | Unchanged. No pallet/window. |
| `dead-gen` | Real open generator candidate location, not a loop. | Unchanged 8 m unit. Gen selection still enforces edge inset. |
| `dead-tree` | Real isolated tree/LOS blocker; 2 x 2 m collision abstraction within 8 m unit, not a surveyed trunk diameter. | Unchanged. No pallet/window. |
| `dead-rocks` | Real low rubble/scattered rocks; four 1 m cells, approximate collision abstraction. | Unchanged. Low sight blockers, no loop resource. |
| `dead-car` | Real lone-wreck dead space; original car was only 3 x 2 m. | Lengthened to 5 x 2 m. No pallet/window added. |
| `dead-tallrock` | Real opaque boulder/LOS blocker; 2 x 2 m approximation. | Unchanged; deliberately not a loop. |
| `dead-tallrock2` | Real separated rock cluster; two 2 x 2 m approximations in an 8 m unit. | Unchanged; no pallet/window added. |
| `infinite-loop` | **Not a real standard tile.** Deliberate owner test probe: 13 x 14 m envelope, sealed twin corridors and four windows. | Explicit exception: protected rows and (24,40) slot unchanged. Not counted as a safe pallet loop. |
| `gate` | Real clear exit approach; 8 m allocation unit, with actual lever/exit generated separately. | Unchanged. |

Inspect the complete library [before](tile-accuracy-before.png) and [after](tile-accuracy-after.png). The atlases show **all possible pallet positions**, so the two numbered car-pile spots appear together there even though only one can spawn in a rolled tile. The first four map renders were regenerated at [v000](../maps/gas-heaven-tiles/v000.svg), [v001](../maps/gas-heaven-tiles/v001.svg), [v002](../maps/gas-heaven-tiles/v002.svg), [v003](../maps/gas-heaven-tiles/v003.svg). I inspected the atlas and full-map renders for wall/window/pallet arrangements.

## Pool measurements

32 variants, base seed 1, same outline and placement weights. Optional probabilities increased modestly for large fillers (0.55/0.60 to 0.60/0.65) and car piles (0.70/0.75 to 0.75/0.80), offsetting the removal of multi-pallet maze rolls. Pallet/four-lane gyms have a guaranteed pallet. All 8 m filler probabilities remain 0.55; ring/dead-tile weights and `bigTileChance=0.55` are unchanged.

| Metric | Before min / mean / max | After min / mean / max |
| --- | --- | --- |
| Pallets | 14 / **16.47** / 22 | 14 / **17.22** / 24 |
| Windows, including probe | 15 / **19.09** / 25 | 13 / **16.88** / 22 |
| Windows excluding probe | 11 / **15.09** / 21 | 9 / **12.88** / 18 |
| Strong tile instances (rating heuristic) | 6 / **8.72** / 11 | 9 / **12.22** / 16 |
| Weak tile instances (rating heuristic) | 6 / **12.25** / 18 | 4 / **9.50** / 16 |
| Safe pallet loops | 2 / **3.47** / 6 | 6 / **9.31** / 13 |
| Unsafe pallet loops | 3 / **6.81** / 11 | 3 / **6.91** / 14 |
| God pallet loops | 1 / **1.00** / 1 | 1 / **1.00** / 1 |
| Unclassified old maze/car/window-L pallets | 3 / **5.19** / 9 | 0 / **0** / 0 |
| Dead footprint area | 43.6 / **54.6** / 62.8% | 41.7 / **53.3** / 62.8% |
| Walkable dead zone (>12 m to a pallet/window) | 26.6 / **37.8** / 43.8% | 26.9 / **37.6** / 46.4% |

Safety is counted only for **realized pallets**, after overlays and budget removal. Every remaining tile has at most one rolled pallet, so pallet counts also count isolated pallet loops. The old synthetic maze/car/window-L shapes have no defensible one-to-one safe/unsafe classification; their 5.19 mean pallets are reported explicitly as unclassified rather than retroactively calling every old “strong” tile safe. Known old gyms are safe, shack god, and short fillers unsafe. The exact baseline classification and per-variant measurements are saved in [tile-accuracy-baseline.json](tile-accuracy-baseline.json); new safety counts are in each map and [the pool index](../../maps/gas-heaven/index.json).

Strong/weak totals are qualitative **per-tile** ratings, including window-only tiles, not separate physical loops. The old maze rule was simply `windows + pallets >= 3`; the replacement families use geometry-informed ratings. The larger strong count therefore includes a classification change and must not be read as a measured 40% gameplay buff. The probe remains one strong tile despite its four windows. Dead footprint area is weighted by 8 m units; dead zone measures walkable cells and includes the preserved overlays' effects. The after maximum dead-zone fraction is worse even though the mean is similar; no per-variant improvement is claimed.

The resulting pool remains a customized Autohaven-like workload: slightly more pallets (+0.75 mean), fewer windows (-2.22 mean), almost unchanged average dead-zone frequency (-0.24 percentage points). Removing unsupported mazes is the reason for these changes; the pool was not tuned to a desired matchup result.

## Balance: matched 64-seed runs

Default `param` hunter/survivors, default parameters, no champion, match seeds **1000-1063**. On the pool, `matchup.js` cycles the sorted maps twice, starting at v008. Rejected generation attempts can change the accepted layout seed for a variant; this is a pool-level comparison, not identical tile rolls with one wall moved.

| Command / map | Phase | Kills | Escapes | Gens done | Hooks | Duration (sim seconds) |
| --- | --- | --- | --- | --- | --- | --- |
| `node scripts/matchup.js --n 64` (legacy hand-built map) | Before | 3.98 | 0.02 | 2.28 | 7.48 | 380.01 |
| Same command | After | 3.98 | 0.02 | 2.28 | 7.48 | 380.01 |
| `node scripts/matchup.js --n 64 --map maps/gas-heaven` | Before | **3.73** | **0.27** | **3.11** | **7.83** | **405.48** |
| Same pool command | After | **3.70** | **0.30** | **2.97** | **7.63** | **407.09** |

Means per match, rounded by the script. The literal requested command loads `maps/gas-heaven.json`, which is unchanged and does **not** exercise the tile library; its identical result is a control. The pool run shows a small shift: -0.03 kills, +0.03 escapes, -0.14 generators and +1.61 seconds. Two extra escapes across 256 survivors do not establish a statistically reliable balance improvement. This benchmark uses the unevolved default bots, not `evo-v16`; it remains heavily killer-sided. The raw result lines, including vaults/stuns/drops/breaks, are preserved in the baseline JSON.

## Validation and reproduction

```text
node scripts/gen-maps.js --count 32 --seed 1 --render 4
node scripts/test-mapgen.js
node scripts/test-sim.js
node scripts/matchup.js --n 64
node scripts/matchup.js --n 64 --map maps/gas-heaven
node scripts/render-map.js maps/gas-heaven/v000.json
```

- Generation: all 32 maps valid; 10 rejected attempts (6 below the pallet minimum, 4 with unreachable walkable cells). Invalid intermediate layouts were not shipped.
- All 26 tiles pass the generator's standalone `analyzeMap` checks with all/no optional pallets and rotated/mirrored placements.
- `test-mapgen.js`: **624 tile resolutions** (26 x three pallet modes x four rotations x two mirrors), every feature's jambs and approaches, one-pallet/window contracts, mutually exclusive car-pile spawns, preserved-template hashes, all 32 maps through `analyzeMap`, index totals, protected slots/overlays, pallet budget, generator inset and hook coverage.
- Maximum nearest-hook walking distance is **26 m** throughout the pool; all generator candidates are at least **6 m** from the outer wall.
- `test-sim.js` before **1072 passed, 0 failed**; after **1072 passed, 0 failed**. **No existing test expectations changed.**
- `src/brains/`, the legacy hand-built map, and `runs/` were not modified. No evolution run was started or stopped.

The corrected generated report also removes stale claims that the station is still placed, that shack is at its old location, and that every map has a generator in main. See [the generated tile/pool report](../maps/gas-heaven-tiles.md) for every after-variant row and tile spawn probabilities.
