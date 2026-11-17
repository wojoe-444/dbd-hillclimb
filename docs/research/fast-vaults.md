# Why chased survivors rarely fast-vault, and the lineup approach

Date **2026-11-16**, base commit `052ea0f`. Maps `maps/gas-heaven/` (variant pool), default hunter. Diagnostic:
`node scripts/diag-fastvault.js [--n 32] [--sp vaultLineup=1,...]`.

## Engine rule (unchanged)

A survivor window vault is **fast (0.5 s)** if the survivor is running, the hunter did not clear that window within
`revaultNoFastS` (2 s, owner rule), and its run-up `runD >= fastVaultRunupM` (2.5 m) with the run-up heading within
`fastVaultAngleDeg` (25°) of the vault direction. Otherwise the vault is **medium (0.9 s)**; walking gives **slow (1.5 s)**.
The vault starts when the body touches the window cell (≤ 0.7 m from its face, 1.2 m from its centre), so the
straight run must begin **≥ 3.7 m out** (3.9 m with steering slack). Run-up bookkeeping (`match.js` ~1077) works like
this. A run segment keeps the heading of its *first* step. Turns under 25° from that heading extend the segment. A
larger turn, a stop, walking, or a step shorter than 60% of a stride starts a new segment.

## Diagnosis (32 matches, seeds 1000–1031, 744 chased window vaults, base)

| Tier / reason (share of all chased window vaults) | % |
|---|---|
| fast | **31.3** |
| medium: run-up too short, final straight began at a **turn** | 32.8 |
| medium: run-up ≥ 2.5 m but its heading > 25° off the axis ("angle") | 26.3 |
| medium: short after a **landing** (back-to-back vault) | 4.4 |
| medium: short after a **slowed** step (wall slide / body) | 4.2 |
| medium: started from a **hold / stop** | 0.9 |
| medium: owner's **re-vault rule** | 0.0 |
| slow (walking) | 0.0 |

The short ones have a median run-up of **0.40 m**. Their final straight began a median **1.60 m** from the window
centre, which is exactly the loop side point. The loop runner runs to the side point (1.6 m out on the axis), arriving
along the loop leg, which is usually perpendicular around a wall. It then turns into the window, leaving
1.6 − 1.2 = 0.4 m of run-up. The "angle" ones are diagonal runs into the side point whose last turn is under 25°.

**Lining up is usually not worth it under the engine's physics.** I measured the extra path needed to start a ≥ 3.9 m
straight run instead of turning at the side point:

- ~2.5 m for a perpendicular arrival along a wall;
- ~4.4 m when the next crossing is the same window back after running round its wall (the most common circuit). The
  decision is then made from the far-side landing.

A fast vault saves 0.4 s = 1.6 m of running, so the time-optimal choice there is a medium vault. In DBD a medium
vault also resets momentum (re-acceleration), which the engine doesn't model (see the questions below).

Counterfactual fast shares, same vaults and paths:

| Rule | Fast share |
|---|---|
| engine (actual) | 31.3% |
| "every step of the last 2.5 m within 25°" (README wording; no first-heading anchor) | 32.0% |
| every step of the last 2.5 m within 45° | 37.1% |
| 2.5 m of uninterrupted running in any direction + last step within 45° | 40.9% |

Even lenient straight-run rules leave most chase vaults medium. The paths really do turn in the last 2.5 m.

## Engine vs wiki: questions for the owner (no engine rule was changed)

Source: [wiki Vault](https://deadbydaylight.wiki.gg/wiki/Vault).

1. **Medium vaults are loud on the wiki** ("rushed, triggers a Loud Noise Notification"). In the engine only fast
   window vaults are loud, and a test asserts that medium vaults are quiet. Should medium window vaults notify too?
2. **Angle tolerance.** The wiki only says "runs straight towards a Window for at least 2.5 metres" (since 2.3.0) and
   gives no angle. The engine uses 25°. Is 25° intended?
3. **Run-up heading anchor.** The engine compares the vault direction with the run segment's *first* heading, not
   with each step (README: "heading stays within 25° of the vault direction"). Measured impact is small (+0.7 pp under
   the README wording). Keep as is?
4. **Momentum.** The wiki: fast vaults keep momentum, medium/slow reset it (the page contradicts itself in the 2.5.0
   note). The engine has no survivor acceleration, so a medium vault costs only 0.4 s. In live play it also costs
   re-acceleration, which is a big reason fast vaults dominate there. Model survivor acceleration / momentum?
5. **Nav artefact (not a rule).** `nav._next` routes every window crossing through the approach-cell centre unless the
   mover enters that cell within 0.12 m of the lane. So nav-driven approaches only fast-vault within ~13° of the
   axis, though the rule allows 25°. The brain now bypasses it with `moveDir` on a lined-up run.

## What changed (survivor brain only; all behind `vaultLineup`, default off)

- **Lineup execution** (`survivor.js` loop runner, phase `toP`/`cross` of a running window crossing). When the crossing
  becomes current, the brain decides once whether to line up. While the line-up is still too costly it re-checks
  every 0.3 s, and can only switch off→on, so it never flip-flops. It lines up only if:
  - the extra path × `vaultDetourW` is less than 0.4 s,
  - the line-up is no less safe than the entry approach (`vaultSafe` with the hunter's lead), and
  - the hunter didn't just clear the window.

  The lineup point is one of 9 pre-computed straight-in runs across the funnel (`loops.lineup`), picked by the angle
  toward my side. It is ≤ `vaultApproachM` out and its straight line to the aim point is clear for the body. Inside the
  funnel the run is steered straight at the aim point (`moveDir`), with no stop at the side point. If the run would
  otherwise keep an off-axis first heading (the anchor in question 3), the brain takes one short re-anchoring step. If
  the line-up becomes unsafe near the point, it is dropped. The old disabled `runupPt` / `const A = null` detour is
  removed.
- **Pricing.** `LoopModel.tsIn` prices a window crossing as the executed approach: fast + the extra run-up path if
  lining up pays, else medium. The fast/medium premium is weighted by `vaultAngleW`. Distances to the lineup points
  come from the same walk fields. `RouteEval` prices windows as medium when entered from the cell in front, and as fast
  via "run-up edges" from each lineup option's start cell. So a route field path that lines up pays for the detour and
  gets the fast price, and a side approach pays the medium price.
- **Off = bit-identical.** With `vaultLineup` 0, 256/256 full matches give identical results to `052ea0f` (and the
  same in matchup, duel-shack and diag-dither), and the other vault knobs are inert (tested).

| Knob | Range | Default | Meaning |
|---|---|---|---|
| `vaultLineup` | 0–1 | **0** | > 0.5: lineup + tier-aware planners |
| `vaultApproachM` | 3.9–6 | 4 | farthest lineup start from the window centre (m) |
| `vaultDetourW` | 0–4 | 1 | line up if extra path × W / 4 m/s < 0.4 s (0 = always when the lane allows) |
| `vaultFunnelDeg` | 5–24 | 20 | approach angle: max angle of the straight-in run off the axis |
| `vaultAngleW` | 0–1.5 | 1 | planners' weight on the executed tier's extra time (1 = as executed, 0 = all windows fast) |

## Before / after

Fast share of chased window vaults (32 matches, seeds 1000–1031):

| Config | Chased window vaults | Fast |
|---|---|---|
| base = default (off) | 744 | 31.3% |
| `vaultLineup 1` | 660 | 32.3% |
| `vaultLineup 1, vaultDetourW 0` | 462 | 41.8% |

With W 1, lined-up runs fast-vault **74%** of the time (60/81). Runs already in the funnel: 14/14. Line-ups dropped
for safety: 10/38.

Full matches, `maps/gas-heaven`, default hunter (n = 256 unless noted, seeds from 1000, mean ± SE):

| Config | Kills | Escapes | Gens |
|---|---|---|---|
| base = default (off) | 3.691 ± .045 | 0.309 | 3.133 ± .093 |
| on | 3.781 ± .037 | 0.219 | 2.969 ± .092 |
| on, `vaultAngleW 0` | 3.750 ± .042 | 0.250 | 2.801 ± .093 |
| on, `vaultDetourW 3` | 3.727 ± .043 | 0.273 | 2.879 ± .092 |
| on, `vaultDetourW 3, vaultAngleW 0` | 3.773 ± .040 | 0.227 | 2.785 ± .093 |
| on, `vaultDetourW 0` (n = 128) | 3.844 ± .049 | 0.156 | 2.695 ± .126 |

Ablation at n = 128 (base 3.688 kills / 3.039 gens):

| What | Kills | Gens |
|---|---|---|
| lineup execution only (old pricing) | 3.680 | 2.953 |
| truthful circuit pricing only | 3.773 | 3.039 |
| route-field pricing only | 3.719 | 2.977 |

`node scripts/matchup.js --n 64 --map maps/gas-heaven`: base/default 3.56 kills, 0.44 escapes, 3.16 gens; on 3.81 /
0.19 / 2.66. `node scripts/duel-shack.js`: 14.8 s → 14.7 s alive (fast 21% → 22%). `diag-dither`: default is
identical to base (0 streaks). On gives 1 streak, during gen work and not in a chase.

**Reading.** Executing more fast vaults does not buy survival in this engine, and pricing the vault tier truthfully in
circuits makes outcomes *worse*. The old optimistic pricing valued tight window loops (vault, run round the wall,
vault back) as if every crossing were fast. Other biases in the loop model, e.g. the hunter-cut forecast, appear to
undervalue those loops, and the optimism was offsetting them. It is not a simple scale offset. With the lineup on, `holdW 1.4` still gives 3.773 kills, while
the base improves to 3.617 at the same `holdW`. So the capability ships off, with its knobs in the evolvable space for the GA. The
candidate engine changes in questions 1 and 4 would make fast vaults worth more and are the owner's call.
