# Hunter window play: counter-play to a survivor holding a window

Branch `feat/hunter-window-play` (2026-11-16), base `feat/survival-time-fitness` @ 0b05f9a. Maps: the `maps/gas-heaven/`
tile variant pool (what `matchup.js` uses by default). Follows `chase-forecast.md` ("holding is genuinely good against these
hunters, because the hunter walks into it").

## Diagnosis: why the old mind-game knobs didn't pay

* **They never fire at a window hold.** `loopmind.js` only rolls a "pass" when the survivor is *running* round a tile
  (`|omega| > 0.1`, speed > 1 m/s). A survivor holding a window stands still, so neither a stand-off nor a reversal can
  start there. The hold is left to the plain chase: path straight at the survivor, which the engine turns into a vault.
* **The stand-off stands where the survivor just runs off.** It stops the hunter while the survivor is running the loop.
  The survivor brain never vaults back toward the hunter's side (a hold crossing goes only when the hunter has come round
  to the survivor's side, `onMySide`), so standing only gives up distance. `standOffChance 1`, n=64: kills 3.08 → 3.13
  (noise), hits 14.2 → 12.8 per match.
* **Reversals are kill-neutral.** `reverseChance 1` vs 0, n=256: 3.29 vs 3.27 (the n=64 first chunk said +0.4; the
  other three chunks didn't). 82 % of reversal ticks are spent out of sight (`revUnseenTicks / revTicks`), and evolved
  survivors read reversals (evo-v16: `loopReverseDist` 8.8 m, `loopReactS` 0). That's why the GA drove both to ~0.

## What was built (`src/brains/loopmind.js`, knobs in `src/brains/hunter.js`)

A **hold** is: the chased survivor, seen now, standing (< 1 m/s, not vaulting) in front of a window (0.7–3 m out along
the axis, ≤ 1.2 m sideways), the hunter on the other side and ≤ 16 m away. Legit info only: the seen survivor and the
static map. Per hold, one plan is drawn (no RNG draw at all while `holdVaultP` is 1):

| plan | what the hunter does |
|---|---|
| vault (`holdVaultP`) | the old behaviour: path at the survivor, and the engine vaults the window (1.7 s for the survivor to run) |
| zone (`holdZoneP` of the rest) | stand on my side, `holdDepthM` out from the window and `zoneW` along the wall toward the shorter way round, facing the survivor. A vault toward me lands in my reach (the survivor's vault-safety check says no); if it runs off on its side, I'm already part-way round |
| fake (`holdFakeP` of the rest after zone) | walk round for `holdFakeFrac` of the detour, then come back to the zone spot |
| around (the rest) | walk round the shorter way, never through the window (own walk field on the LoopModel grid with all anchors solid; string-pulled waypoints that the engine nav walks). The survivor must vault toward my old side (a medium vault from standing; counts toward the entity blocker) or be hit. Faces the survivor's last seen spot while walking, and keeps going for up to 3 s out of sight |

A detour longer than `holdAroundMaxM` turns fake/around into zone. After `holdPatienceS` without the hold ending,
`holdThen` picks: vault (old behaviour), walk round once more, or break the chase off (ignore this survivor for 10 s).
The 2 s no-fast-revault rule: the zone spot sits inside the reach of a 0.9 s medium vault (the tier a standing
survivor gets anyway, and the only tier for 2 s after the hunter clears that window).

| knob | range | default | note |
|---|---|---:|---|
| `holdVaultP` | 0–1 | **1** | 1 = old behaviour, bit-identical (no draw, no LoopModel) |
| `holdZoneP` | 0–1 | 0.4 | |
| `holdFakeP` | 0–1 | 0.3 | |
| `holdFakeFrac` | 0.1–0.9 | 0.5 | |
| `zoneW` | 0–6 m | 2 | 0 and 4 were both worse than 2 (n=64, zone only: 3.17 / 3.16 vs 3.47) |
| `holdDepthM` | 1.6–5 m | 2.2 | 3.5: 3.50 (≈ same) |
| `holdAroundMaxM` | 4–40 m | 20 | |
| `holdPatienceS` | 0.5–10 s | 3 | 8 s: 3.44 vs 3.52 (n=256) |
| `holdThen` | 0–1 | 0 | < 1/3 vault, < 2/3 walk round, else break off. 0.5: 3.48, break off: 3.44 vs 3.52 (n=256) |

Shipped off (`holdVaultP` 1) so other branches' baselines don't move. **Recommended: `holdVaultP` 0**; zone-heavy mixes
are about as good as the default mix.

## Numbers

n=256 = seeds 1000–1255, maps `pool[seed % n]` (same as `matchup.js`); n=64 = seeds 1000–1063 (= `matchup.js --n 64`).

| hunter vs survivor (n=256) | kills | esc | dur s | per-64 chunks (kills) |
|---|---:|---:|---:|---|
| old (default) vs default | 3.27 | 0.73 | 443.6 | 3.08 3.36 3.33 3.31 |
| **holdVaultP 0** vs default | **3.52** | 0.48 | 420.2 | 3.56 3.48 3.58 3.45 |
| holdVaultP 0, zone only vs default | 3.55 | 0.45 | 424.0 | 3.47 3.45 3.72 3.55 |
| old vs evo-v16 champion survivor | 3.31 | 0.69 | 495.1 | 3.17 3.44 3.55 3.09 |
| holdVaultP 0 vs champion survivor | 3.42 | 0.58 | 488.3 | 3.38 3.45 3.59 3.27 |
| zone only vs champion survivor | 3.39 | 0.61 | 485.7 | 3.42 3.42 3.50 3.22 |

`matchup.js --n 64` at the shipped defaults: kills 3.08, escapes 0.92, dur 447.56 s (identical to before the branch).
The same 64 matches with `holdVaultP 0`: 3.56 / 0.44 / 414.2 s.

**Does holding still pay for the survivor?** Yes, about half as much (n=256):

| | survivor `holdMaxS` 4 (default) | `holdMaxS` 0 | what holding is worth |
|---|---:|---:|---:|
| old hunter | 3.27 | 3.73 | −0.46 kills |
| holdVaultP 0 | 3.52 | 3.75 | −0.23 kills |

`holdMaxS` 12 (n=64, measured before the too-far → zone fallback): old 3.28, new 3.23. Long holds outlast the 3 s patience, and then the hunter vaults anyway.

**`diag-holds.js`** (n=24, seeds 5000–5023; now with hits after the hold and the hunter's plan counters):

| | hold episodes | hunter vaults that window | hit while holding | that survivor hit ≤ 3 s / ≤ 6 s after the hold |
|---|---:|---:|---:|---|
| old hunter | 212 | 42 % | 2 | 18 % / 26 % |
| holdVaultP 0 | 201 | 25 % | 0 | 22 % / 28 % |
| holdVaultP 0, zone only | 195 | 28 % | 0 | **30 % / 41 %** |
| champion H + S | 67 | 39 % | 1 | 23 % / 32 % |
| champion H + S, holdVaultP 0 | 77 | 6 % | 0 | 23 % / 34 % |

The vaults left at `holdVaultP 0` are patience run-outs (47 of 151 hunter-detected holds) and holds the hunter's
detector doesn't see (the diag counts 201, the hunter detects 151: out of sight or > 16 m away).

**Shack duel** (`duel-shack.js --n 64`, survivor seconds alive): strong mode 14.8 → 14.7, brain mode 15.5 → 16.2 (noise;
the shack's one window is run as a loop, rarely held). Window blocks 7 → 14 (survivors burn their vaults).
**Dither** (`diag-dither.js`, now with `--hp`): hunter 0 flips at defaults and at `holdVaultP 0`.
**Tests**: `test-sim.js` 1741 passed. New test: plans never step into the window cell; walk-round reaches the far side;
the zone spot is on my side and faces the survivor; fake turns back; patience → vault / walk round / break off;
defaults have no hold activity; with holds on, results are identical whether the seeds run forward or in reverse.
