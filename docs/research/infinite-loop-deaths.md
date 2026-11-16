# Infinite-loop tile deaths

Research date: 2026-11-16. Retained sample: 48 sequential matches, seeds 1000–1047, map = seed % 32, default knobs and current camera enabled. A matched 48-match control disables the camera. No fixes implemented; no commit created.

## Findings

**The tile has a strong pursuit advantage, but is not unconditional invulnerability.** A real-engine four-window tour takes the survivor **11.6 s/lap**, versus **14.6 s** for a base-speed hunter and **13.8 s** at maximum Bloodlust. That assumes the hunter follows, windows remain available, and the survivor starts with a safe lead. Blockers, occupied vault lanes, attacks through windows, and interceptions invalidate those assumptions. This is not a minimax proof that an optimal survivor can evade every optimal hunter from every safely established state.

The current sample contains **43 scoped downs, 14 other hits, and 30 deaths** (87 incident records). The largest primary labels are repeated-window replanning **11**, occupied-window contests **10**, and residual loop-entry/hold failures **7**. Fewer than four windows were known in **26/43** downs; knowledge often overlaps another failure.

**Concrete interface bug:** `survivor.js:chase()` tests `h.vaulting`, but `match.js:_obsSurvivor()` never supplies `vaulting` on the visible hunter. The intended “hunter is vaulting this anchor: run away” branch cannot execute. This affects both camera settings and does not depend on map knowledge.

## Scope and version

- An incident qualifies inside **x=20–44, z=36–60** (footprint plus 4 m), or during the same active engine chase that started there. A subsequent down far away therefore still qualifies. A rectangular footprint includes exterior space; being nearby does not establish safe corridor entry.
- Each down is counted once. A downing hit is also the down event, not two separate observations. Deep Wound downs are supported; none occurred in either retained sample. A death after its chase ended qualifies only by incident location. `lastDown` links scoped deaths to earlier downs, even outside scope.
- Current sample: **24** downs strictly inside the footprint; **21** during chases that started in/near it. These subsets overlap. Of 43 subjects, **37** had entered the footprint standing and **31** a corridor standing. Only **6** had completed a measured four-window pass before the down: two had one, three had two, one had three. These are match-lifetime passes, not necessarily the final chase.
- Across all 192 survivor instances, **98** entered the footprint standing, **78** entered a corridor standing, and **16** four-window passes were measured. The diagnostic records how entries/exits occurred and the action/circuit at each transition.
- Concurrent camera work changed brain files between preliminary runs. Preliminary numbers were discarded. Both retained samples have **identical source hashes**, and no monitored source changed during either run. Camera-off uses the updated brain too; it is not the earlier pre-camera implementation.
- The camera-off control contains **60 downs, 25 other hits, 29 deaths**. There were 139 in/near-tile chase starts and 46 downs in those chases; current settings have 53 starts and 21 downs. These broader-scope ratios, 33.1% and 39.6%, are not substitutes for `diag-loops.js` closed-chase statistics, which can omit terminal chases. The earlier approximately 22% result is context, not replicated here.
- These are **observational evidence labels**, not measured prevention rates of hypothetical fixes. The residual class deliberately retains uncertainty about the best alternative.

## Classification

| Code | Primary evidence / cause | Current | Share of 43 | Camera off | Assessment |
|---|---|---:|---:|---:|---|
| R | Rapid replanning / repeated same-window vaults | 11 | 25.6% | 15 | Decision/control bug; blockers and valid hits are consequences |
| O | Contested occupied window | 10 | 23.3% | 14 | Observation contract bug + decision gap |
| L | Loop entry, reversal, or hold failure (residual) | 7 | 16.3% | 8 | Decision gap; exact safe alternative needs counterfactual replay |
| V | Unsafe vault / hit through window | 5 | 11.6% | 10 | Decision gap; attack itself is legitimate |
| H | Costly window hold / lost fast run-up | 4 | 9.3% | 5 | Decision/timing gap |
| F | Open flee route / failed approach | 3 | 7.0% | 4 | Knowledge or route gap; safe tile control not established |
| T | Work/sneak mode during live chase | 3 | 7.0% | 0 | Decision/state-machine gap |
| B | Sustained teammate obstruction | 0 | 0.0% | 3 | Decision/dynamic-navigation gap |
| A | Vault alignment failure | 0 | 0.0% | 1 | Steering/navigation gap; no illegal refusal established |
| | **Total** | **43** | **100%** | **60** | |

Primary label priority: a rapid triple of the same window within 3 s; non-chase brain mode while HUD-chased; sustained teammate obstruction; occupied-window refusals; costly holds/recent vault; remaining immediate action evidence. The rapid-vault predicate examines current-chase history (or the last 10 s without an active chase), allowing its first vault up to 1 s before chase start. See `classify()` for exact thresholds. These are mutually exclusive labels; mechanisms overlap. The “R” label can explain a later down elsewhere after the safe loop was abandoned.

| Overlapping evidence | Current downs | Interpretation |
|---|---:|---|
| Fewer than four tile windows known | 26/43 (60.5%) | Major limitation; not proof that learning one missing window alone saves the subject |
| Zero tile windows known | 3/43 | No usable tile plan was formed |
| At least one tile window blocked in trace | 13/43 | Can follow bad recycling or legitimate exhaustion |
| Down occurs mid-vault | 20/43 | Includes fast vaults started too late |
| Teammate contact in trace | 2/43 | Neither reaches sustained-stall primary threshold; control has three primary cases |
| Maximum Bloodlust in trace | 4/43 | All four connect at tier 3; contribution does not establish a primary catchability cause |

No sampled hit demonstrates a solid-wall hit, excessive attack range, illegal fourth vault, or incorrect engine blocker counting. The script records exact refusal conditions; a nearby window in the wrong movement direction is not mislabeled as a lane failure. No primary class is assigned to a through-wall engine bug. Engine legality and survivor decision quality are different questions.

## Reproducible examples

Times are simulation seconds; survivors are IDs 0–3. Map filenames are `maps/gas-heaven/vNNN.json`. Incident IDs index JSONL records. Unless marked control-only, examples use `infinite-loop-current`. Replay one seed with:

```powershell
node scripts/diag-infloop.js --n 1 --seed SEED --out docs/research/replay-SEED
```

Add `--camera off` for control examples. Incident IDs change in a one-seed run.

### R — repeated-window replanning

- **Seed 1002, v010, survivor 0, down 182.1 s, incident 5.** `w-t05-4` is used at 180.0, 181.0, and 182.0, all medium vaults. The brain still reports the circuit's first crossing (`crossed:0`) despite those actual crossings. The hunter hits 0.1 s into the last vault at 1.368 m. All four windows were known: the missing capability is synchronizing the circuit with actual movement.
- **Seed 1005, v013, survivor 2, down 195.9 s, incident 11.** `w-t05-4` is fast-vaulted at 181.1, immediately reversed at 181.7, and used again at 182.7. It becomes blocked. The brain abandons its budget and later dies at (35.5,55.4), after trying other routes. All four windows were known. The down location alone conceals the earlier loss of the safe loop.

### O — contesting an occupied window

- **Seed 1000, v008, survivor 3, down 142.5 s, incident 0.** After a medium vault at 138.8, the survivor holds at the entry. From 140.8–141.9 the engine refuses its vault because the hunter occupies that cell. It vaults back at 142.0 with no run-up and is hit at 142.5, 1.055 m away. `obs.hunter.vaulting` is absent, so the safety guard never triggers. Three tile windows were known.
- **Seed 1002, v010, survivor 1, down 265.3 s, incident 6.** The same pattern with full knowledge: refusals at 263.4–264.5, immediate medium re-vault at 264.6, hit at 265.3 at 1.481 m. Missing windows are not necessary for this class.

### L — residual entry/reversal/hold failures

- **Seed 1021, v029, survivor 0, down 113.7 s, incident 40.** Earlier tile vaults end at 102.7. The final chase starts elsewhere at 106.4; the brain chooses another circuit, and dies at (27.757,59.978) approaching its next entry. It qualifies by margin, not by a safely established tile lap. All four windows were known.
- **Seed 1027, v003, survivor 0, down 46.0 s, incident 51.** The circuit is in its first `cross` phase, but no tile vault has been accepted. The survivor remains outside at (39.613,51.238), hit at 1.954 m, with two windows known. This is a failed approach. The trace does not establish a safely reachable alternative, so the label remains broad.

### V — legal hits during unsafe vaults

- **Seed 1010, v018, survivor 0, down 358.2 s, incident 17.** A true fast vault starts at 357.8 through `w-t05-1`. At 0.4/0.5 s the hunter hits through the window at 1.910 m. All four windows were known. This is not a medium-vault downgrade: a fast vault is still hittable.
- **Seed 1018, v026, survivor 1, down 372.1 s, incident 34.** A medium entry vault starts at 371.5 through `w-t05-2`; at 0.6/0.9 s the outside hunter hits at 1.747 m. Three windows were known. The chosen entry was within the attack envelope.

### H — costly holds / lost run-up

- **Seed 1002, v010, survivor 3, down 42.8 s, incident 2.** The survivor holds at (27.1,51.5) for several seconds; hold time reaches 3.2 at 41.8. It medium-vaults `w-t05-3` at 42.0 and is hit at 42.8, 0.974 m away, by a hunter near the landing side. Two windows were known. Waiting lost momentum without protecting the landing.
- **Seed 1017, v025, survivor 3, down 169.1 s, incident 32.** The tile-origin chase has moved to another window at (23.5,28.5). The survivor holds until 168.2, medium-vaults, and is hit at 169.1. This class includes bad holds elsewhere: it does not demonstrate four-window geometry failing at the final location.

### F — never safely committed to the tile

- **Seed 1011, v019, survivor 2, down 65.9 s, incident 20.** At (24.427,40.716), no tile windows are known and no tile vaults occurred. Its open flee target is (24.5,55.5), along the exterior. The hunter catches it from behind at 1.318 m. The missing capability is discovering and choosing a safely reachable opening.
- **Seed 1014, v022, survivor 3, down 97.1 s, incident 29.** It runs on the west exterior at (22.526,46.545), knows one window, has no tile vaults, and flees toward (22.5,32.5). Proximity to the tile is not exploitation of a corridor.

### T — work mode during live chase

- **Seed 1012, v020, survivor 1, down 176.9 s, incident 26.** A tile-origin chase starts at 170.0, but `mode` remains `work` through 170.9, following a non-chase goal toward (2.5,56.5). The survivor later chooses a pallet route and dies mid-vault at (10.409,65.5). Two tile windows were known.
- **Seed 1020, v028, survivor 0, down 107.9 s, incident 38.** During 102.6–102.9 the engine reports a chase while the brain remains in `work`. It subsequently runs away from the tile and dies at (50.708,26.216). Sight/memory drives the mode; live chase music does not force evasion.

### Control-only obstruction/alignment

- **B: camera off, seed 1005, v013, survivor 3, down 18.2 s, incident 2.** A medium entry at 11.4 already caused injury. Approaching the opposite end, teammate contacts repeatedly stall progress and cause sidesteps, displacing the survivor to x≈30–31 rather than the x=29.5 lane. It dies at (31.127,42.462). Collider records establish real contact. Many nearby attempts actually have no window in the current step direction, so calling all of them alignment refusals would be incorrect.
- **A: camera off, seed 1044, v020, survivor 1, down 224.1 s, incident 103.** The survivor reaches (37.595,46.363), displaced from the z=45.5 lane. A genuine candidate fails `vaultLane`; the hunter hits at 0.868 m. Three windows were known. The engine should not accept that off-lane vault under current rules.

## Deaths are not all independent loop failures

| Cause | Current | Camera off | Assessment |
|---|---:|---:|---|
| `allDown` | 23 | 23 | Legitimate terminal rule, often caused by a prior down or another survivor's final down |
| `hook3` | 3 | 3 | Legitimate sacrifice; examine preceding capture separately |
| `hookDeath` | 3 | 3 | Legitimate timer; rescue/teamwork or earlier capture failure |
| `lastSurvivor` | 1 | 0 | Legitimate elimination before gates power, even while standing safely |
| **Total** | **30** | **29** | |

**Counterexample to every nearby death being a local loop bug: seed 1044, v020, survivor 1, 479.9 s, incident 83.** It dies at (28.1,51.5), never having been downed (`lastDown:null`), and is standing injured immediately before death. It is the last survivor before gates power. No locally perfect looping policy can override that rule. Preventing that outcome requires a match-rule change or better team/generator outcomes.

Seed 1000's 142.5 down and `allDown` death are two incident records for one failure. Seed 1002, survivor 1, dies by `hook3` at 367.8 near (21.803,43.764); its linked previous down was 358.4. Counting sacrifices as fresh independent window failures exaggerates the problem.

## Independent mechanics and math

### Geometry and vault requirements

Unrotated v000 window centres: **(28.5,41.5), (34.5,41.5), (28.5,54.5), (34.5,54.5)**. End-window centre separation is 13 m. Each corridor has twelve walkable 1 m rows and is five cells wide. The clean movement leg between landing and the next vault is about 11 m; exterior connectors are about 6 m. Rotation/mirror preserve local dimensions; neighbouring tiles can change exterior detours.

`_tryVault()` needs more than a window target. Movement must first gain less than 60% of its step. The adjacent cell must be the correctly oriented window, the far cell free, its vault cell unoccupied, and the window unblocked for this survivor. Initiation requires distance ≤radius+0.3 = **0.7 m** from the boundary and lateral offset ≤**0.3 m**. Landing is the far grid-cell centre. The actual transfer is typically **1.9–2.0 m**, not the **3.2 m** between the brain's ±1.6 m anchor points.

Fast: running with ≥2.5 m continuous run-up, heading within 25°. Otherwise medium **0.9 s**, or slow **1.5 s** if walking. Re-vaulting within 2 s of the hunter clearing the window cannot be fast. A 90° turn from an exterior connector does not preserve straight run-up; the controlled tour has two fast and two medium vaults.

### Following loses ground even at +0.6 m/s

For walking leg length L and vault-time difference Δτ, following hunter time loss is:

`Δτ - L*(1/vS - 1/vH)`

With vS=4 and vH=5.2, an 11 m interior leg and fast vault give **1.2 − 11(1/4−1/5.2) = 0.565 s** loss. A 6 m exterior leg and medium vault give **0.8 − 6(1/4−1/5.2) = 0.454 s**. Two of each total ≈2.04 s/lap. Tick/approach differences explain the measured 2.2 s.

| Real-engine controlled tour | Lap time | Hunter lag gained per lap |
|---|---:|---:|
| Survivor, two fast + two medium | 11.6 s | — |
| Hunter 4.6 m/s, four 1.7 s vaults | 14.6 s | 3.0 s |
| Hunter 5.2 m/s, four 1.7 s vaults | 13.8 s | 2.2 s |

The fixture uses actual v000 movement/vault methods. Specifying hunter normal speed isolates maximum Bloodlust without needing to earn it. This is a traversal measurement, not an optimal-policy solver.

### Four windows still exhaust in continuous chase

The third accepted use blocks that survivor for **30 s**. Using a different window does not reset it. In the controlled tour, third uses block at **25.9, 28.0, 31.7, 33.8 s**. The fourth attempt at the first window fails at **37.5 s**, with all four blocked. The first block expires at 55.9, leaving **22.1 s** after all four become blocked before any unlocks.

The per-window revisit interval, 11.6 s, is below 30 s. A fixed repeated tour needs a lap ≥30 s or at least **18.4 s of extra delay** before its next first-window use. Three laps of a 2.2 s traversal advantage do not finance that delay. This disproves an infinite fixed four-window tour under sustained chase, not every adaptive strategy involving reversals, exterior escape, or chase resets.

A new chase restarts per-chase counts on next use, but **does not cancel existing 30 s blocks**. Chase can end at >18 m range or 8 s lost sight. Reset exploitation must be demonstrated, not assumed merely because four windows exist.

### Lunge movement and hit-through-window risk

- Range **2.2 m**, ±45° hunter-facing arc, visibility and `_hitPathClear` required. Solid cells stop hits. Windows explicitly do not.
- Lunge speed **4.6×1.5 = 6.9 m/s**. Windup 0.35 s resolves in **four 0.1 s ticks**. Maximum travel 2.76 m gives a stationary-target envelope of **4.96 m**. The hunter plants when a valid target is within 90% range (1.98 m), so this is an upper bound, not a guaranteed hit. Bloodlust affects normal running, not lunge speed.
- A vault starts with zero interpolation that tick. A simultaneous hunter attack resolves after three survivor vault updates. A 1.9 m fast vault then travels about 1.14 m: collinear initial-gap risk bound **2.2+2.76−1.14 = 3.82 m**, subject to geometry, arc, plant behavior, and tick phase.
- Controlled fast-vault fixtures with 3 m run-up: initial gaps **2.5, 3.0, 3.5 m** yield downs at 0.3 s; **4.0 and 4.5 m** miss the first swing. This fixture deliberately initiates beyond the default hunter brain's 2.5 m lunge preference; it demonstrates mechanics, not natural-match frequency.
- Hunter at **(28.5,40.5)** facing south, injured survivor at opposite landing **(28.5,42.5)**: `_resolveAttack()` downs it at exactly **2.0 m through the window**. Finishing a fast vault is not safe from a hunter waiting there.

### Waiting, cuts, and the limits of loop scoring

The hunter need not follow. Between the brain's exterior points (28.5,39.9) and (28.5,56.1), an all-windows-solid walk field finds **23.8 m**, ≈**4.58 s at 5.2 m/s**. Two vaults plus the 9.8 m interior anchor leg cost ≈5.28 s for the hunter in the brain model. This provides a real exterior shortcut. `LoopModel.L` returning **40 m** can mean capped/unreachable, not an exact physical distance. Measurements and circuit candidates are saved in `infinite-loop-shortcuts.json`.

Waiting at a landing invalidates a precommitted crossing. Reversing before the hunter commits may be correct; reversing into an occupied vault or along a corridor toward the hunter is not automatically safe. `LoopModel` models a one-entry cut but explicitly ignores multi-step waiting/interception. `RouteEval` models window cell costs and fixed 2 m reach; it omits lunge travel/windup, vault interpolation, occupancy, run-up loss, and window hit exposure. Positive distance held is not a safety proof.

**Mathematical answer:** with usable windows, a safe lead, and a hunter forced to follow, the route is speed-favoured even at maximum Bloodlust. Against unrestricted hunter decisions, unsafe initial entries/landings, sustained-chase blocking, or global elimination rules, the tile gives no unconditional guarantee. Some hits/deaths are legitimate. Most sampled downs nevertheless reveal concrete survivor information/control deficiencies. Proving a guaranteed adaptive strategy from a precisely defined safe state remains a separate reachability/game analysis.

## Recommended fixes, ranked by likely impact

1. **Visible hunter vault state.** `match.js:_obsSurvivor` should provide the `vaulting` field expected by `survivor.js:chase`. Consider a visible vault window/direction/progress; never disclose hidden hunter state. At an occupied anchor, run the remaining corridor or choose another crossing. Targets 10 current / 14 control primary cases. A `vaultClearanceS` knob could regulate post-clear re-vaults after safe base behavior exists.
2. **Synchronize circuits to real vaults; prevent mid-vault replanning.** In `survivor.js:chase`, `chooseRoute`, and phase transitions, commit through vault completion and advance once per observed crossing. Navigation can auto-vault before the planned entry point is reached; treat that as the crossing rather than immediately choosing its reverse. Targets 11 current / 15 control rapid-recycling cases. Prefer deterministic state repair over another knob.
3. **Evaluate attack envelope, momentum, landing, and occupancy.** Update `survivor.js:chase`/`palletDecision`, `routes.js:rollout`, and `loops.js:tsOf/evaluate`. Predict actual fast/medium/slow timing and roll both actors through the next swing and landing. Use config range/windup/lunge, not hard-coded 2 m reach. A `vaultSafetyMarginM` or `minVaultArrivalSlackS` knob can tune margin after the model is correct. End holds before losing a safe running vault; `holdMaxS` is not a safety test.
4. **Keep evading while chase music reports danger.** In `survivor.js:decideInner`, `self.chased` should constrain mode despite temporary lost sight, unless a higher-priority action is demonstrably safe. Carry forward belief/last-sighting uncertainty. Apply `calmS` after engine chase termination rather than returning to work solely because a wall hid the hunter for four seconds. Three current primary cases, plus contributions to unsafe holds.
5. **Learn and preserve legitimate loop connectivity.** `mapknow.js:MapKnowledge.update` and `survivor.js:chooseCircuit` should prioritize safely observing unknown reachable openings and allow useful partial plans. With camera enabled, use permitted camera visibility rather than hidden geometry. A `loopScoutW`/`anchorExploreW` knob could help. Incomplete knowledge appears in 26/43 cases; that is overlapping evidence, not 26 proven preventions.
6. **Time-dependent budgets and loop value.** `survivor.js:vaultCount/vaultsLeft` should follow actual chase boundaries, accepted crossings, remaining counts, and block expiry. Its >3 s unchased clearing differs from immediate engine new-chase identity. `loops.js:expected` rejects whole circuits when too few uses remain for a lap (one use left for a two-use circuit), although a safe partial leg can still exist. Model partial circuits, expiry, alternative windows, resets, and Bloodlust. `LoopModel` stays at base speed while `RouteEval` estimates Bloodlust; reset estimates on observed hit/break/chase-end evidence rather than chase age alone.
7. **Lane alignment and teammates.** `survivor.js:unblock` and selected-window steering should align before commitment, account for visible teammates, and choose an alternate anchor when contested. Generic sidesteps can destroy the 0.3 m lane. Consider own/visible vault-refusal feedback rather than hidden-state disclosure. Three control obstruction cases and one alignment case are fixtures. Do not widen `vaultLane` merely to hide controller defects.

No attack-range, wall-hit, blocker-accounting, or Bloodlust nerf is justified by this sample. A literal zero-death requirement also needs to address `allDown`, `lastSurvivor`, hook/endgame rules, and initial-state conditions; local chase policy alone cannot solve all of them.

## Artifacts and verification

- **Script:** `scripts/diag-infloop.js`. Default 48 matches, seed 1000, map seed modulo pool size (32 shipped variants), current config/default knobs. `--champ runs/<run>/champions.json` overlays saved champion parameters. One match at a time; no worker pool.
- **Commands:** `node scripts/diag-infloop.js --n 48 --out docs/research/infinite-loop-current --mechanics 1`; control adds `--camera off` with another prefix; standalone fixtures use `--mechanics-only 1`.
- **`<prefix>.jsonl.gz`:** compressed incident records with every tick of the preceding 10 s: survivor/hunter positions/actions, hunter observations, HUD/chase, mode/circuit/targets, known windows/counts/block expiry, actual vault tier and precise refusal candidates, body contacts, and hit-time vault/attack state. `--window SECONDS` changes history; `--keep-jsonl 1` retains plain JSONL too.
- **`<prefix>.summary.json`:** params/config/hashes, labels, lifetime footprint/corridor entry/exit histories and goals, accepted vaults, circuit changes/clear reasons, chases, stats, compact incident index. A lap means four consecutive distinct tile windows linked by perimeter edges (6 or 13 m), excluding same-window hold recycling. It is an operational pass count, not a perfect-play claim.
- **`<prefix>.sources.json`:** exact monitored sources for audit during concurrent changes. Hashes cover match/config, survivor/hunter, loops/routes, map knowledge, hunter belief; map hashes are per match. Other unmodified imports come from the repository.
- Instrumentation adds a read-only closure getter and clear-site logging to a private **in-memory** survivor module. Engine wrappers call original methods. It never writes `src`, maps, viewer, or existing scripts; actions and RNG calls are preserved.
- **Parity verification:** first match in each retained run replayed uninstrumented with identical exact result, entire event sequence, and final actor positions. A final non-empty one-seed smoke run at seed 1005 also passes after compression/compaction changes. `node --check` passes. No git commit.

Inspect an incident without dependencies:

```powershell
@'
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
const rows = gunzipSync(fs.readFileSync('docs/research/infinite-loop-current.jsonl.gz'))
  .toString().trim().split('\n').map(JSON.parse);
console.log(JSON.stringify(rows.find(r => r.id === 0), null, 2));
'@ | node --input-type=module
```

## Appendix: every scoped down

Codes are in the classification table. `Known` = tile windows known at down; `Laps` = lifetime measured four-window passes; `Inside` = strict footprint. A “no” still qualifies by margin or chase origin. Full overlapping evidence is in each trace.

### Current default settings

| Incident | Seed | Map | Survivor | Time | Code | Known / 4 | Laps | Inside |
|---:|---:|---|---:|---:|---|---:|---:|---|
| 0 | 1000 | v008 | 3 | 142.5 | O | 3 | 0 | yes |
| 2 | 1002 | v010 | 3 | 42.8 | H | 2 | 0 | yes |
| 5 | 1002 | v010 | 0 | 182.1 | R | 4 | 1 | yes |
| 6 | 1002 | v010 | 1 | 265.3 | O | 4 | 0 | yes |
| 9 | 1005 | v013 | 0 | 115.7 | O | 4 | 2 | yes |
| 11 | 1005 | v013 | 2 | 195.9 | R | 4 | 0 | yes |
| 13 | 1005 | v013 | 3 | 241.9 | R | 3 | 0 | yes |
| 17 | 1010 | v018 | 0 | 358.2 | V | 4 | 1 | yes |
| 18 | 1010 | v018 | 3 | 447.8 | R | 4 | 0 | no |
| 20 | 1011 | v019 | 2 | 65.9 | F | 0 | 0 | yes |
| 22 | 1011 | v019 | 3 | 122.7 | R | 4 | 0 | no |
| 24 | 1011 | v019 | 1 | 276.1 | O | 3 | 0 | yes |
| 26 | 1012 | v020 | 1 | 176.9 | T | 2 | 0 | no |
| 27 | 1012 | v020 | 1 | 312.8 | O | 3 | 0 | yes |
| 29 | 1014 | v022 | 3 | 97.1 | F | 1 | 0 | no |
| 32 | 1017 | v025 | 3 | 169.1 | H | 3 | 0 | no |
| 34 | 1018 | v026 | 1 | 372.1 | V | 3 | 0 | yes |
| 37 | 1020 | v028 | 0 | 31.6 | O | 3 | 0 | no |
| 38 | 1020 | v028 | 0 | 107.9 | T | 3 | 0 | no |
| 39 | 1021 | v029 | 0 | 60.9 | O | 2 | 0 | yes |
| 40 | 1021 | v029 | 0 | 113.7 | L | 4 | 0 | no |
| 41 | 1021 | v029 | 1 | 355.9 | H | 3 | 0 | no |
| 42 | 1021 | v029 | 3 | 376.9 | R | 4 | 3 | no |
| 47 | 1024 | v000 | 2 | 387.0 | R | 4 | 0 | yes |
| 49 | 1025 | v001 | 0 | 113.7 | R | 2 | 0 | yes |
| 51 | 1027 | v003 | 0 | 46.0 | L | 2 | 0 | yes |
| 52 | 1028 | v004 | 1 | 224.8 | V | 2 | 0 | yes |
| 54 | 1029 | v005 | 1 | 191.0 | L | 4 | 0 | yes |
| 55 | 1030 | v006 | 1 | 190.9 | L | 2 | 0 | no |
| 57 | 1030 | v006 | 3 | 214.8 | T | 4 | 0 | no |
| 60 | 1033 | v009 | 1 | 407.8 | O | 4 | 2 | yes |
| 62 | 1034 | v010 | 3 | 38.3 | V | 1 | 0 | yes |
| 63 | 1034 | v010 | 0 | 319.1 | L | 2 | 0 | no |
| 66 | 1035 | v011 | 1 | 289.2 | R | 3 | 0 | yes |
| 69 | 1037 | v013 | 1 | 154.4 | O | 3 | 0 | yes |
| 73 | 1041 | v017 | 0 | 177.9 | V | 0 | 0 | no |
| 76 | 1042 | v018 | 3 | 28.9 | O | 3 | 0 | no |
| 77 | 1043 | v019 | 0 | 262.2 | L | 4 | 2 | no |
| 79 | 1044 | v020 | 3 | 83.5 | F | 0 | 0 | no |
| 80 | 1044 | v020 | 2 | 217.2 | R | 4 | 0 | yes |
| 81 | 1044 | v020 | 0 | 300.6 | H | 4 | 0 | no |
| 82 | 1044 | v020 | 3 | 364.5 | L | 2 | 0 | no |
| 85 | 1047 | v023 | 2 | 365.8 | R | 4 | 0 | yes |

Source fingerprints for both retained samples:

| Source | SHA-256 |
|---|---|
| src/sim/match.js | 16f25e8c29aa9aa9440d26b7f2a7d365d517a5e593983c9e3d17058b3fdb9fc3 |
| src/sim/config.js | 7c7158e68253619d68eb50858f1c6a506b62f5dfd9c3a1712454a9407e3836c1 |
| src/brains/survivor.js | 06311c01169d637c302b519b2f9999d835fc9a09fec954c330a0e281d77a3030 |
| src/brains/loops.js | 0cbde96f006005b9c5b596837a0a4171051048234322bc20c6df818fb4b032ac |
| src/brains/routes.js | 9d3ae1d6bd35bcd9c26bbd85ea80de3da25faf4d07c24e783dac46dd1a1295d4 |
| src/brains/mapknow.js | ee995ca94d574b65f013acc282e030b71a7aa9641d459e960a9459f07c827d3b |
| src/brains/hunterbelief.js | e4db6dee4a2e4d3c06f480c848294a109a2fa6f655bbd0b92c02d58e7f272e74 |
| src/brains/hunter.js | eb106dca718e6cf30d947d5e13d39209680c9f8db4a2199c7fc831dc1bf1a918 |

### Camera-off control

| Incident | Seed | Map | Survivor | Time | Code | Known / 4 | Laps | Inside |
|---:|---:|---|---:|---:|---|---:|---:|---|
| 0 | 1002 | v010 | 1 | 38.0 | L | 4 | 0 | no |
| 2 | 1005 | v013 | 3 | 18.2 | B | 4 | 0 | yes |
| 4 | 1005 | v013 | 1 | 206.5 | O | 4 | 2 | yes |
| 6 | 1007 | v015 | 0 | 173.7 | V | 4 | 1 | yes |
| 7 | 1007 | v015 | 1 | 316.3 | V | 4 | 1 | yes |
| 9 | 1008 | v016 | 0 | 439.3 | O | 4 | 0 | yes |
| 12 | 1009 | v017 | 2 | 148.5 | V | 4 | 1 | yes |
| 15 | 1010 | v018 | 0 | 150.9 | V | 4 | 0 | no |
| 16 | 1010 | v018 | 3 | 194.8 | V | 4 | 0 | yes |
| 17 | 1010 | v018 | 0 | 215.2 | L | 4 | 0 | no |
| 19 | 1012 | v020 | 3 | 146.7 | O | 3 | 0 | yes |
| 21 | 1017 | v025 | 2 | 249.8 | R | 4 | 0 | yes |
| 22 | 1017 | v025 | 2 | 341.7 | R | 4 | 0 | yes |
| 24 | 1017 | v025 | 3 | 376.9 | R | 4 | 0 | yes |
| 28 | 1018 | v026 | 3 | 37.3 | R | 4 | 0 | yes |
| 29 | 1018 | v026 | 3 | 171.4 | R | 4 | 0 | yes |
| 31 | 1020 | v028 | 3 | 79.6 | L | 4 | 0 | no |
| 33 | 1020 | v028 | 0 | 219.3 | H | 4 | 1 | no |
| 35 | 1021 | v029 | 0 | 42.9 | O | 4 | 0 | yes |
| 36 | 1021 | v029 | 0 | 88.6 | R | 4 | 0 | yes |
| 39 | 1021 | v029 | 2 | 134.9 | H | 4 | 0 | no |
| 40 | 1021 | v029 | 3 | 206.9 | F | 4 | 1 | no |
| 42 | 1021 | v029 | 0 | 241.8 | R | 4 | 0 | yes |
| 44 | 1021 | v029 | 1 | 301.0 | L | 4 | 2 | no |
| 46 | 1022 | v030 | 1 | 99.2 | O | 4 | 0 | yes |
| 47 | 1022 | v030 | 2 | 125.4 | F | 4 | 0 | no |
| 49 | 1022 | v030 | 0 | 164.5 | L | 4 | 0 | no |
| 50 | 1022 | v030 | 0 | 297.1 | V | 4 | 2 | yes |
| 51 | 1023 | v031 | 0 | 141.8 | L | 4 | 0 | no |
| 52 | 1023 | v031 | 1 | 230.5 | V | 4 | 2 | yes |
| 53 | 1023 | v031 | 0 | 235.3 | H | 4 | 0 | no |
| 60 | 1025 | v001 | 3 | 48.1 | O | 4 | 0 | yes |
| 61 | 1025 | v001 | 3 | 138.0 | R | 4 | 0 | yes |
| 63 | 1025 | v001 | 2 | 269.7 | O | 4 | 0 | yes |
| 66 | 1029 | v005 | 1 | 251.6 | R | 4 | 0 | yes |
| 68 | 1030 | v006 | 3 | 122.7 | F | 4 | 0 | no |
| 69 | 1030 | v006 | 0 | 153.3 | F | 3 | 0 | no |
| 70 | 1030 | v006 | 3 | 226.7 | R | 4 | 0 | no |
| 71 | 1030 | v006 | 0 | 254.7 | R | 4 | 0 | no |
| 73 | 1032 | v008 | 2 | 200.2 | O | 4 | 1 | yes |
| 74 | 1032 | v008 | 0 | 244.5 | L | 4 | 0 | no |
| 75 | 1032 | v008 | 2 | 303.7 | V | 4 | 2 | yes |
| 77 | 1034 | v010 | 0 | 270.7 | V | 4 | 1 | yes |
| 81 | 1035 | v011 | 2 | 107.7 | O | 3 | 0 | yes |
| 82 | 1035 | v011 | 2 | 140.7 | H | 4 | 0 | yes |
| 83 | 1035 | v011 | 0 | 164.3 | L | 4 | 1 | no |
| 85 | 1035 | v011 | 1 | 230.5 | R | 4 | 0 | no |
| 86 | 1035 | v011 | 3 | 296.4 | O | 4 | 2 | yes |
| 90 | 1040 | v016 | 2 | 75.1 | O | 3 | 0 | yes |
| 92 | 1040 | v016 | 3 | 162.6 | R | 4 | 0 | yes |
| 95 | 1042 | v018 | 2 | 274.5 | R | 4 | 0 | no |
| 96 | 1043 | v019 | 0 | 231.5 | O | 4 | 1 | yes |
| 97 | 1043 | v019 | 2 | 287.5 | H | 4 | 5 | no |
| 101 | 1044 | v020 | 2 | 129.1 | B | 3 | 0 | yes |
| 102 | 1044 | v020 | 3 | 167.1 | B | 3 | 0 | yes |
| 103 | 1044 | v020 | 1 | 224.1 | A | 3 | 0 | yes |
| 104 | 1044 | v020 | 2 | 238.6 | V | 4 | 0 | yes |
| 107 | 1045 | v021 | 0 | 389.7 | O | 4 | 2 | yes |
| 110 | 1046 | v022 | 3 | 84.4 | O | 4 | 2 | yes |
| 113 | 1046 | v022 | 1 | 290.6 | R | 4 | 0 | no |

