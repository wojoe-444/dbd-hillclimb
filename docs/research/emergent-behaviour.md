# Can the behaviour emerge instead of being written? Modelling options for dbd-hillclimb

Review date: **2026-11-16**. Code measured at `50bb457` (branch `research/emergent`). Run data: `runs/evo-v14`, `evo-v15`, `evo-v16` in the main checkout (read only). New measurements: `scripts/diag-fitness-noise.js` and a prototype brain, `src/brains/survivor-ctx.js` (`--survivor ctx`).

## The owner's question

> "Evaluate whether there is some broader set of variables or a different modelling method such that these habits and features are less directly driven by me/us, and rather emerge from gameplay."

## Short answer

1. **Today, almost nothing strategic emerges.** Every habit is a hand-written branch, and the GA only moves the thresholds inside it. The bigger problem is that **the GA barely moves those thresholds on evidence either.** The survivors' fitness ranking in one generation predicts the next generation's ranking with a rank correlation of only **0.12–0.15**. Re-measuring one population on common seeds gives an ICC of 0.044: one match tells you about 4% of the real difference between two survivor teams. With 8–16 matches per individual, most of a knob's movement is genetic drift. Evidence: the same knob converges to opposite ends in different runs. One example: `palletGreed` ends at 0.78, then 0.04, then 0.00 of its range. The hunter side has the opposite problem: its fitness is saturated. Good hunters all score about 0.96, almost every match is a 4k, and there's nothing left to select on.
2. **So the first job isn't a new brain. It's making selection see.** Use common random numbers, paired or rank-based fitness, more matches per evaluation, a hall-of-fame opponent set, and an optimizer that uses noisy signal well (CMA-ES or ES with antithetic pairs). Each extra degree of freedom makes the noise problem worse. Without this step, NEAT, GP, utility weights and RL all inherit the same blindness.
3. **Then replace the fixed priority cascade with a learned strategic layer over a broad, shared feature vector.** Keep the hand-written *motor* skills (pathing, loop running, vault timing, hide-spot search, belief maps). They are geometry and physics, and they're good. Evolve or learn *which goal to pursue and when to switch*, from about 30 generic features. Write no new behaviour-specific branches.
4. **Make the meta visible with quality-diversity and a league.** Use MAP-Elites niches (stealth vs looper vs altruist; tunneller vs patroller), a hall of fame of past champions, and a cross-generation "who beats whom" matrix. Then the viewer shows a population of styles and their cycles, not one drifting median.
5. **RL (PPO self-play) is feasible later, for the strategic layer only.** A 2 Hz decision rate gives about 10^8 agent-steps/hour on this machine. It costs a Python bridge and some interpretability, so it's step 5, not step 1.

The prototype (`ctx` brain) is a small first step toward point 3. With all weights at zero it plays identically to `param`. It adds 130 evolvable weights that make 13 cascade-gating knobs depend on 10 HUD and match features, so behaviour like "rescue more once the gens are nearly done" can appear without a branch. Results: [Prototype](#prototype-context-conditioned-knobs-ctx-brain).

---

## 1. How the bots are built today

### Size

| | knobs | `if (` | ternaries | lines |
|---|---:|---:|---:|---:|
| hunter (`hunter.js`, `loopmind.js`, `belief.js`) | **44** | 206 | 33 | 1,030 |
| survivor (`survivor.js` + 9 helper modules) | **80** | 520 | 138 | 2,840 |

(Counted with `grep -c 'if ('` and the registry; v14 had 31 hunter and 67 survivor knobs, so 26 knobs arrived in about two days of commits.)

### The decision structure is a fixed priority cascade

`survivor.js` `decideInner` (l. 761–1003) is a single ordered list. The first matching rule acts:

```
hooked → carried → downed (crawl/lie still) → being healed (stand still) → hidden & unseen (freeze)
→ mode switch {chase | sneak | work} by fleeSeenDist / fleeTR / trustChase / calmS
→ stealth (break LOS if hideDist) → chase (loops.js / routes.js / lookahead.js / tileplay)
→ hide from unseen hunter (hunterbelief.js, 13 knobs) → mend → endgame gate → sneak
→ rescue (rescue.js utility, if altruism > 0.25) → patient handshake → seek heal (if seekHeal > 0.5)
→ heal / pick up (healplan.js, if altruism > 0.15) → generator vs explore (weighted score)
```

The order, the set of rules and each rule's trigger are fixed by hand. Many knobs are **booleans in disguise**, like `walkWhenTR > 0.5`, `seekHeal > 0.5`, `hideWalk > 0.5`, `avoidHeading > 0.5` and `coverRun > 0.5`. Others are **on/off switches by range**: `hideThreat` > 1 means never, `loopReverseDist` = 0 means off, and so do `reverseChance` and `standOffChance` at 0. The GA can therefore choose *whether* a written habit fires and *at what distance*. It can't:

* reorder priorities (e.g. "finish this gen at 90% before rescuing", unless someone writes `healGenKeep`),
* condition a habit on context nobody wired in (e.g. "hide more once two teammates are dead"),
* combine primitives into a sequence nobody wrote (e.g. "lead the hunter past a teammate's gen, then break LOS"; `chaseToMatesW` exists only because someone thought of it).

The local scorers are the most "emergent" parts already: gen choice (a weighted sum of 9 terms), `rescue.js` (a utility with 6 terms), loop and flee route values ("equivalent distance held"), and hide-spot scoring. They show the pattern that should replace the cascade: **score options by weighted features, pick the best.**

### Hard-coded vs. emergent: an inventory

Going through `git log` (82 commits), these behaviours were **written as branches**:

* stealth slip-out
* peeking
* hiding from an unseen hunter
* hold-at-loop
* loop reversal (mind game)
* fast-vault run-up
* pallet drop vs. save
* stun seeking
* chain-to-next-tile after a break
* edge avoidance
* chase-toward/away from mates
* follow a fleeing mate
* gen clustering
* exploration and loop scouting
* rescue claims
* camping fear
* the heal handshake
* slug pick-ups
* seek heal
* Deep Wound mend
* post-unhook protection hold
* trust another's chase
* the hunter's tunnel / slug / camp / patrol / gate / pallet respect / hook choice / post-hook plan / loop mind games / stall guard

These are **genuinely emergent** (not written anywhere, arising from interacting written parts):

* the four-survivor spread (from `spreadW` + jitter)
* the pace of the match
* which loops get used
* map-dependent outcomes

Most "emergence" observed so far is *a knob going to an extreme*. One example is evo-v15 driving `openGroundPenalty` to 0 (commit `a9dd0d0`). That is selection *switching a written habit off*, not inventing one.

### Run evidence: drift, pinning, contradiction

`scratchpad/knobs.mjs` classifies each knob's population median over the run: pinned at an edge, moved and converged, wandering (path length > 4× net move), or still.

| run | gens × matches/gen | hunter: pinned / moved / wander | survivor: pinned / moved / wander |
|---|---|---|---|
| evo-v14 | 40 × 192 | 4 / 7 / 20 | 6 / 22 / 36 |
| evo-v15 | 40 × 192 | 8 / 18 / 17 | 9 / 17 / 43 |
| evo-v16 | 79 × 384 | 7 / 10 / 27 | 8 / 26 / 37 |

About half of all knobs wander with no net direction. More tellingly, **knobs that "converged" (low population sd, far from default) converge to different places in different runs**:

| knob (normalised 0..1) | default | v14 end | v15 end | v16 end |
|---|---:|---:|---:|---:|
| survivor `palletGreed` | 0.33 | **0.78** | 0.04 | 0.00 |
| survivor `glanceRate` | 0.40 | **0.89** | 0.05 | 0.08 |
| survivor `farFromHunterW` | 0.25 | **0.60** | 0.00 | 0.34 |
| survivor `hideDist` | 0.53 | 0.01 | **0.77** | 0.11 |
| survivor `coverRun` | 0.30 | 0.72 | **0.02** | 1.00 |
| survivor `chaseToMatesW` | 0.50 | **0.92** | 0.42 | 0.19 |
| hunter `progressW` | 0.50 | 0.44 | 0.06 | 0.00 |
| hunter `clusterK` | 0.50 | **0.72** | 0.19 | 0.00 |
| hunter `hookClusterBias` | 0.00 | 0.04 | **0.71** | 0.11 |

The brains changed between runs, so some disagreement is legitimate. But a population sd of about 0.05 around opposite ends is the signature of **drift to fixation**: half-elitism with pop 24 and a noisy ranking. It is not the signature of a fitness optimum.

### Why: the fitness ranking is mostly noise

Two independent measurements.

**(a) In-run rank persistence.** Elites are re-evaluated every generation on fresh seeds. The Spearman correlation between an elite's rank in generation *g* and in *g+1*:

| run | rounds/gen | hunters | survivors | gen-*g* champion's next rank (of 24) |
|---|---:|---:|---:|---:|
| evo-v14 | 8 | 0.08 | 0.15 | 9.6 / 8.4 |
| evo-v15 | 8 | 0.04 | 0.15 | 10.9 / 8.9 |
| evo-v16 | 16 | 0.17 | 0.12 | 9.6 / 9.0 |

The best individual of one generation is typically ranked 9th the next. Selection is close to random.

**(b) Variance decomposition on common seeds** (`node scripts/diag-fitness-noise.js --from …/evo-v16/evo.jsonl --k 32`). The final evo-v16 population: 24 survivor teams × 32 identical seeds (hunter *k mod 24* for seed *k*), and vice versa.

| | survivor teams | hunters |
|---|---:|---:|
| fitness mean | 0.261 | 0.926 |
| within-individual sd (per match) | **0.095** | 0.099 |
| between-individual sd (true) | **0.020** | 0.095 |
| ICC (signal share of one match) | **0.044** | 0.476 |
| reliability of a 8 / 16 / 64-match mean | 0.27 / **0.42** / 0.75 | 0.88 / 0.94 / 0.98 |
| matches per individual for reliability 0.5 / 0.8 / 0.9 | 22 / **88** / 197 | 2 / 5 / 10 |
| variance of a paired (same-seed) difference vs unpaired | 66% | 93% |

(1,536 matches, 892 s with a concurrent job on the box.)

* **Survivors.** One match carries about 4% signal. evo-v16's 16 matches per team give a reliability of 0.42. Ranking 24 teams on that, and keeping the top half, is barely better than a coin. The real spread between teams (sd 0.02 fitness) is about a fifth of the match-to-match noise (0.095). Common seeds help, but only modestly (−34% variance on a pairwise comparison). Most of the noise is the chaos *within* a match, not the map or seed draw.
* **Hunters look fine on paper (ICC 0.48), but the spread comes from bad mutants, not from differences among good hunters.** The top five re-measure at 0.959–0.968: indistinguishable, at the ceiling of the outcome table (mean 0.926, most matches are 4k). The in-run rank persistence among *elites* is still 0.04–0.17. **The hunter fitness is saturated:** against these survivors, almost any sane hunter 4ks, so selection between good hunters has no gradient. That's a fitness-design problem, not a model problem. A graded or opponent-relative fitness (e.g. time to 4k, or score vs. a hall-of-fame survivor panel) would restore it.

Selection also sees one more noise source this table excludes: the random opponent pairing in evolve.js. A hunter's score depends on which survivor teams it happened to draw.

**Consequences:**

* Every knob whose true effect is below about one between-team sd is invisible at 16 matches. That covers most of them: a single knob's effect is a fraction of a population's total spread.
* Adding parameters (utility weights, NN weights, GP nodes) *shrinks* each one's effect. Without fixing evaluation, a richer model will drift more, not emerge more.
* This also explains why hand-coding plus A/B with 64–96 seeded matches (the `diag-*` scripts) has been the effective method so far. The owner has been the selection operator because the GA couldn't be.

---

## 2. Options

Throughput (measured): evo-v16 played 384 full matches per generation in about 50 s on 15 worker threads, about **7.7 matches/s ≈ 28,000 matches/hour**. That's about 2 s of CPU per match with the param brains; the belief maps and loop models dominate, not the engine. A match lasts about 450 game-s, which is 4,500 ticks × 5 agents ≈ **22,000 agent-decisions per match** at 10 Hz.

| method | what is learned | what stays hand-written | build cost | compute per meaningful result | emergence | interpretability | main risk |
|---|---|---|---|---|---|---|---|
| **0. Better selection** (CRN, paired/rank fitness, more rounds, hall of fame, CMA-ES) | same knobs | everything | **S** (1–2 days, evolve.js only) | same budget, better used | none new, but real optimisation of what exists | same | none; prerequisite for all rows below |
| **A. Utility AI / scored goals** over a shared feature vector | weights (and response-curve shapes) per goal × feature | goals' execution (motor skills), feature extractors | **M** (1–2 weeks, survivor first) | 10^5–10^6 matches with CMA-ES at 100–300 params | **high at the strategic level**: priorities, context and switching emerge; new *skills* don't | **high**: read weights per goal; log the winning goal + top terms per tick | features miss something → can't learn it (but adding a feature is generic, not a behaviour) |
| **A′. Context-conditioned knobs** (prototype `ctx`) | linear dependence of existing gate knobs on features | the cascade itself | **XS** (done) | as A | moderate: context, not new priorities | high | the cascade order is still fixed |
| **B. Evolved decision/behaviour trees, GP** | tree structure over feature tests and primitive goals | primitives, features | M–L | 10^6+ matches; bloat control needed | **highest structural emergence**: new rule orderings and conjunctions | medium: trees are readable if kept small (parsimony pressure) | bloat, brittleness, noisy fitness wrecks structural search harder than weights |
| **C. Neuroevolution** (small MLP or NEAT: features → goal scores) | net weights / topology | primitives, features | M | 10^5–10^6 matches (ES/CMA on 500–2k weights) | high (like A, plus nonlinear interactions) | low–medium: needs saliency / probes | opaque; the owner can't "read the meta" from weights |
| **D. RL (PPO self-play, league)** with a recurrent policy | policy + value nets | features or raw-ish obs, motor skills | **L** (Python bridge or JS PPO, 3–6 weeks) | 10^8–10^9 agent-steps (strategic layer at 2 Hz: ~1–10 h per 10^8 on this box) | high; motor-level RL would be **very high but very costly** | low; needs behaviour probes and clustering | engineering, reward hacking, non-stationary self-play cycles, determinism of a bridge |
| **E. Quality-diversity (MAP-Elites, CMA-ME)** on top of A/A′/C | an *archive* of policies, one per behaviour niche | descriptor definitions (measured, not coded behaviours) | S–M on top of A | 2–5× the single-objective run | **makes playstyles visible**: stealth vs looper vs altruist as cells | **very high**: a map of styles × fitness | descriptors pick the axes, so choose observable outcomes (time hidden, chase s, rescues) |
| **F. League / hall of fame / PSRO-lite** | which opponents to train against | — | S | +20–50% matches | shows cycles (rock-paper-scissors) instead of hiding them | high: win-rate matrix over time | none |
| **G. In-match opponent models** (generic counters + Bayesian estimates over observable events) | per-match posterior over the opponent's tendencies; the policy reads it as features | the event list (observables, not habits) | M | — | replaces hand-picked "killer habit" profiling with generic features any habit can use | high | feature explosion; keep to rates and latencies |

### A. Utility AI (Infinite-Axis style) is the best fit

A fixed set of about 12 **goals**, each executed by an existing motor routine:

| goal | executed by |
|---|---|
| work gen *i* | `slots.act` |
| explore | `know.pickTarget` |
| flee / loop | `chase()` with loops.js, routes.js, lookahead.js |
| break line of sight | `findHide` |
| hide unseen | `pickHideSpot` |
| rescue *j* | rescue.js approach |
| heal *j* / pick up *j* | healplan.js |
| be healed | |
| mend | |
| gate | |
| hold / watch | `look` |

Each goal's utility is `Σ_j w_gj · curve_gj(f_j)` (optionally multiplied by a few hard "can I" gates), plus hysteresis `w_stick`. Highest wins; re-evaluate every 0.5–1 s, or immediately on events. Per-goal targets (which gen, which mate) are chosen by the scorers that already exist. The **feature vector** is shared and generic, built only from the solo-queue observation:

* self: health state, hook stages, deep wound, protected time, current activity progress
* hunter: visible?, distance, closing speed, facing-toward-me, time since seen, terror layer + trend, belief P(within 8/16/32 m), belief entropy
* objectives: gens done/needed, my gen's progress, nearest known gen's path distance, fraction of the map explored, gates powered
* team (HUD): number hooked / downed / injured / chased / gone, max hook stage among hooked, Resolve, "healing" intent received, claims
* terrain: distance-held value of the best reachable loop, open ground along the escape, cover at my spot, LOS-to-hunter-belief
* time: match time, time in current goal
* opponent model (G): observed tunnel rate, camp time per hook, pallet break latency, chase abandonment time, swing timing

About 35 features × 12 goals ≈ 420 linear weights. Response curves can be piecewise-linear with 2 parameters each. That's too many for a noisy GA, but fine for CMA-ES at 10^5 matches, or low-rank `W = U·V` (e.g. 12×4 · 4×35 ≈ 190 params).

What would emerge that is currently written: hide vs. work vs. sneak, rescue timing relative to gen progress, when to stop looping and leave, heal vs. repair, whether to go for the gate or the hook in the endgame. What wouldn't: anything that needs a motor skill nobody wrote (a new kind of crossing, body-blocking). That's the honest boundary of the hybrid.

Hunter equivalent: goals = chase target *i*, patrol gen *g*, follow scratch/noise, search the belief hot cell, hook choice, camp, break pallet, kick gen, gate patrol, with the same generic feature machinery.

### B. GP / evolved behaviour trees

These are the most "it wrote its own rules" option, and the most fun to watch. But structural search under ICC ≈ 0.044 noise is a known failure mode (bloat and lucky trees surviving), so it only makes sense *after* the evaluation fixes. A good middle ground is to **evolve the order and gates of the utility goals' preconditions as a small tree** (depth ≤ 3, parsimony pressure). That gives readable rules like `if teammatesHooked ≥ 2 and gens ≥ 4 → gate`.

### C/D. Nets and RL

They buy nonlinear interactions and, with recurrence, memory. They sell interpretability, which conflicts directly with "watch the meta". In JS:

* **neuroevolution:** a 35→16→12 MLP is about 800 weights. Forward pass under 1 µs, negligible vs. 2 s/match. OpenAI-ES with antithetic pairs and CRN handles that size at about 50–100 evaluations per update.
* **PPO:** needs gradients. Either tfjs-node / onnxruntime-node for inference plus a Python learner fed over a socket, or porting the strategic-layer env to Python. The sim stays in Node; Python drives N Node workers in lock-step via a batched stdin/stdout or ZeroMQ protocol.
* **RL compute:** at a 2 Hz strategic decision rate, a match is about 900 decisions × 5 agents. 7.7 matches/s ≈ 35,000 agent-steps/s ≈ **1.2 × 10^8 agent-steps/hour**. That's enough for a strategic-layer PPO in hours to a day. Motor-level RL (10 Hz, continuous movement around loops) is more like 10^9–10^10 steps and many days, and would have to rediscover what loops.js already does.

### E/F. QD and the league make the meta visible

MAP-Elites with descriptors measured from match stats, never from knobs:

* survivor: share of time hidden or out of LOS × chase seconds per chase × rescues per match
* hunter: tunnel share (repeat-target hits) × time within 16 m of a hook × pallets broken per chase

The archive keeps, say, a 6×6×4 grid of the best policy per cell. The owner sees which styles exist, which are strong, and how the grid fills over time. A **hall of fame** (every 5th generation's champion, both sides) as part of each evaluation's opponent set stops the forgetting and cycling that pure co-evolution hides. A **cross-generation win matrix** (champion of gen *a* vs champion of gen *b*) shows whether the meta is progressing, cycling or stalled.

---

## 3. Recommended path

Keep: the engine, the information model, all motor and geometry modules (loops, routes, lookahead, tileplay, hide-spot search, beliefs, matetrack, slot picking), the bloodpoint and outcome fitness, and the existing local scorers.

Replace, gradually: the survivor's (then the hunter's) top-level priority cascade, and the habit-specific branches and knobs that now live inside it.

| step | what | done when | cost |
|---|---|---|---|
| **0** | **Selection that sees.** In `evolve.js`: every generation, all individuals play the **same seed set** (CRN); fitness = mean over a fixed opponent panel (current pop sample + hall of fame) or a rank / Bradley-Terry score over paired matches; elites are **not** re-ranked from one noisy evaluation (average their history, or re-test elites only); add a `--opt cmaes` path (diagonal or sep-CMA for 100+ params). Use `diag-fitness-noise.js` to pick rounds for reliability ≥ 0.7 | the in-run rank persistence goes from 0.1 to > 0.6; two seeds of the same run converge to the same knob regions | 1–2 days |
| 1 | **Context-conditioned knobs** (`ctx`, this branch) evolved with step 0; A/B vs. param on fixed seeds (`matchup.js`) | ctx champion beats the param champion over 256 paired seeds, or proves the context weights don't matter | done + runs |
| 2 | **Shared feature module** `src/brains/features.js` (survivor and hunter), one place, logged per tick into the replay | viewer can plot any feature over a match | 2–3 days |
| 3 | **Utility goal selector** `--survivor utility`: goals + motor calls refactored out of `survivor.js` into callable options (pure refactor; `param` keeps calling them in its cascade order, bit-identical, checked like the ctx identity test). Utility weights evolved with step 0's CMA-ES | utility ≥ param in paired A/B; per-tick "goal + top 3 terms" log in the viewer | 1–2 weeks |
| 4 | **Stop adding habit branches.** A new idea becomes a *feature* (an observable) or a *goal* (a primitive with a motor routine), never a decision rule. Delete habit knobs the utility layer has subsumed | survivor knob count falls; new behaviour shows up as weight changes | ongoing |
| 5 | **QD archive + hall of fame + win matrix** for the meta view | the viewer has a "styles" tab | 3–5 days |
| 6 | Hunter gets the same (features → goals) | | 1–2 weeks |
| 7 | Optional: PPO on the strategic layer via a Python learner, compared with the evolved utility policy | only if steps 3–5 plateau | 3–6 weeks |

### Measuring emergence

* **Behaviour descriptors per individual** (measured, not coded): time out of hunter LOS while it's within 30 m, chase seconds per chase, rescues and heals per match, gens per minute, time near hooks (hunter), repeat-target share, pallets per chase, endgame gate vs. hook choice. Track their population distribution per generation. A new mode appearing (bimodality, a new cluster) is an emergent style.
* **Goal-transition statistics** (utility brain): frequency of goal A → goal B transitions and the feature contexts they happen in. A transition pattern nobody wrote that becomes common (e.g. `flee → break LOS → work` near teammates) is an emergent habit. It can be named after the fact by inspecting the top weight terms.
* **Diversity:** MAP-Elites coverage and QD-score. Behavioural (not genotypic) distance between the top 5.
* **Progress vs. cycling:** the cross-generation champion win matrix. Upper-triangular means progress; a band structure means cycles.
* **Knob or weight consistency across seeds:** two independent runs agreeing is the sign that a result is real (today they don't).

### What the owner would see in the viewer

* per survivor, a strip of "current goal" colours over the match plus the top contributing features on hover ("rescue: hooked mate stage 2 (+0.8), gens 4/5 (+0.5), hunter seen 30 m ago (+0.3)")
* a "styles" map: the QD grid, each cell clickable to play its champion
* the win matrix over generations, plus a "meta timeline" of descriptor distributions (e.g. "hide share" splitting into two modes at gen 60)

---

## Prototype: context-conditioned knobs (`ctx` brain)

`src/brains/survivor-ctx.js`, registered as `survivors.ctx`.

* **Mechanism.** It wraps the unchanged param brain. Before each decision it rewrites 13 knobs that gate the cascade (`fleeSeenDist fleeTR hideDist altruism healDist seekHeal trustChase exploresMap spreadW genProgW palletGreed chaseToMatesW rescueThreshold`) as `base + range · Σ w·f`.
* **Features.** 10 features, from the obs only: gens done, time, injured, my hook stages, mates hooked / downed / gone (HUD), a mate chased (HUD), hunter proximity (decaying), terror layer.
* **Size.** 130 new weights in [−1, 1], default 0. Space: 80 + 130 = 210 knobs.
* **Identity check.** All-zero weights give bit-identical matches to `param` (seeds 11–13: same kills, escapes, gens, duration and hooks). Random weights give different, non-crashing matches.

**Smoke evolution:** 12 generations, pop 12 + 12, 8 rounds, seed 3, both runs from the same start (`runs/smoke-ctx`, `runs/smoke-param` in the worktree, about 13 min each on a shared box). Then a paired A/B over 128 common seeds against the default hunter (`node scripts/ab-ctx.js --a default --b runs/smoke-param/champions.json --c runs/smoke-ctx/champions.json --n 128`):

| survivor set | fitness | kills | escapes | gens | BP | vs default (paired) |
|---|---:|---:|---:|---:|---:|---:|
| param defaults | 0.308 | 3.51 | 0.49 | 3.45 | 10,880 | — |
| smoke-param champion | 0.310 | 3.46 | 0.54 | 3.49 | 10,962 | +0.003 ± 0.015 |
| smoke-ctx champion | 0.280 | 3.66 | 0.34 | 2.70 | 9,946 | **−0.027 ± 0.015** |

**What this shows:**

* **Neither smoke champion beats the hand-tuned defaults.** At 8 matches per individual (reliability ≈ 0.27, see §1), 12 generations can't select anything real.
* **The ctx champion is worse (about 1.9 se).** That's expected from evolve.js's start: `--init-sigma 0.35` with p = 0.8 per knob throws all 130 weights far from 0 at generation 1. Selection then has no power to bring the harmful ones back. A context layer needs a **zero-centred, small-sigma start** and the step-0 evaluation fixes, or it just adds noise to a decent brain.
* **The champion's "learned" weights are drift, not discoveries.** It has a few readable ones, like `ctx_altruism_stages = +0.69` (more altruistic after my own hookings) and `ctx_spreadW_gens = +0.75` (spread out more as gens finish), and 16 weights are sign-consistent across the final population. But the population sd after 12 generations is 0.13 (of a range of 2): fixation by drift at pop 12. Don't interpret them.
* **The prototype's value is the mechanism and the check.** The mechanism: a context layer over the existing brain, an identity guarantee at zero, and features legal under solo queue. The check: the same A/B shows that the current GA settings *can't* currently tell whether added freedom helps. That's the core finding of this review.

**To give it a fair trial** (after step 0):

```
node src/hillclimb/evolve.js --survivor ctx --pop 32 --rounds 48 --init-sigma 0.05 --gens 60 --out runs/ctx-1
```

About 1,500 matches per generation, about 3.5 min per generation at 7.7 matches/s, about 3.5 h. Repeat with a second seed. Accept only weights both seeds agree on, then confirm with `ab-ctx.js --n 256`.

---

## Sources

* Dave Mark, *Behavioral Mathematics for Game AI* (2009), and GDC talks "Improving AI Decision Modeling Through Utility Theory" (2010, with Kevin Dill) and "Building a Better Centaur: AI at Massive Scale" (2015, the Infinite Axis Utility System).
* J. Koza, *Genetic Programming* (MIT Press, 1992). M. Colledanchise & P. Ögren, *Behavior Trees in Robotics and AI* (2018), ch. on learning BTs via GP.
* K. Stanley & R. Miikkulainen, "Evolving Neural Networks through Augmenting Topologies", *Evolutionary Computation* 10(2), 2002.
* N. Hansen, "The CMA Evolution Strategy: A Tutorial", arXiv:1604.00772. R. Ros & N. Hansen, "A Simple Modification in CMA-ES Achieving Linear Time and Space Complexity" (sep-CMA), PPSN 2008.
* T. Salimans et al., "Evolution Strategies as a Scalable Alternative to Reinforcement Learning", arXiv:1703.03864, 2017 (antithetic sampling, rank-based fitness shaping).
* J. Schulman et al., "Proximal Policy Optimization Algorithms", arXiv:1707.06347, 2017.
* B. Baker et al., "Emergent Tool Use From Multi-Agent Autocurricula" (hide-and-seek), ICLR 2020: emergence from simple rewards in a physics sim, at roughly 10^8–10^9+ episodes of scale.
* T. Bansal et al., "Emergent Complexity via Multi-Agent Competition", ICLR 2018.
* M. Jaderberg et al., "Human-level performance in 3D multiplayer games with population-based reinforcement learning" (Capture the Flag), *Science* 364, 2019.
* O. Vinyals et al., "Grandmaster level in StarCraft II using multi-agent reinforcement learning" (AlphaStar league), *Nature* 575, 2019.
* M. Lanctot et al., "A Unified Game-Theoretic Approach to Multiagent Reinforcement Learning" (PSRO), NeurIPS 2017. D. Balduzzi et al., "Open-ended Learning in Symmetric Zero-sum Games", ICML 2019. W. Czarnecki et al., "Real World Games Look Like Spinning Tops", NeurIPS 2020.
* C. Rosin & R. Belew, "New Methods for Competitive Coevolution" (hall of fame, fitness sharing), *Evolutionary Computation* 5(1), 1997. R. Watson & J. Pollack, "Coevolutionary Dynamics in a Minimal Substrate", GECCO 2001 (disengagement, cycling).
* J.-B. Mouret & J. Clune, "Illuminating search spaces by mapping elites", arXiv:1504.04909, 2015. J. Pugh, L. Soros, K. Stanley, "Quality Diversity: A New Frontier for Evolutionary Computation", *Frontiers in Robotics and AI*, 2016. M. Fontaine et al., "Covariance Matrix Adaptation for the Rapid Illumination of Behavior Space" (CMA-ME), GECCO 2020.
* J. Lehman & K. Stanley, "Abandoning Objectives: Evolution Through the Search for Novelty Alone", *Evolutionary Computation* 19(2), 2011.
* Common random numbers / paired evaluation: A. Law, *Simulation Modeling and Analysis*, ch. "Variance-reduction techniques". For noisy EAs: Y. Jin & J. Branke, "Evolutionary Optimization in Uncertain Environments — a Survey", IEEE TEVC 9(3), 2005.

(The citations are standard references given from memory, not re-fetched for this review. Compute figures are measured on this machine; RL step budgets are order-of-magnitude.)
