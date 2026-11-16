# dbd-hillclimb

A fun experiment: a headless, deterministic **2D asymmetric chase sim** (1 hunter vs 4 survivors, in the style of
the genre: generators, hooks, pallets, windows, exit gates). Both sides are played by plain hand-written bot code —
no LLMs at runtime — whose knobs are **hill-climbed** against each other to watch the meta evolve. A Three.js viewer
renders matches in 3D.

- `src/sim/` — the engine (rules, perception, nav). See [`src/sim/README.md`](src/sim/README.md).
- `src/brains/` — parametric hunter and survivor bots (`hunter.js`, `survivor.js`), registry in `index.js`.
- `src/hillclimb/` — alternating hill-climb (`climb.js`) and population co-evolution (`evolve.js`) over a worker pool;
  `evalplan.js` = paired seeds, held-out fixed-opponent benchmarks, edge reports, run provenance; `play.js` = one match
  + optional per-match metric modules (`metrics/`).
- `src/mapgen/` + `maps/` — tile-based seeded map generator; pilot map *Gas Heaven* (`maps/gas-heaven/v000–v031`),
  hand-made v1 `maps/gas-heaven.json`. Format: [`docs/MAP_FORMAT.md`](docs/MAP_FORMAT.md). Even variants use the
  layout's fixed outline; odd ones get a seeded stepped outline (`src/mapgen/outline.js`: 144–153 8 m tiles, aspect
  ≤ 1.6, min width 4 tiles; families notched / circlish / blob / chunky) with the fixed pieces refit to it.
- `viewer/` — 3D viewer that runs the real engine in the browser.

```sh
node scripts/test-sim.js                                   # engine tests
node scripts/matchup.js --n 50 --map maps/gas-heaven       # quick matchup with default params
node src/hillclimb/climb.js --map maps/gas-heaven --gens 200 --k 8 --n 64 --out runs/my-run
node src/hillclimb/evolve.js --gens 40 --pop 24 --rounds 8 --paired --bench-every 5 --out runs/evo-x
node scripts/crossplay.js --sets default,runs/evo-v14,runs/evo-v15 --n 32   # champions x opponents, held-out seeds
node scripts/knob-sensitivity.js --set runs/evo-v15 --side survivor --n 24  # which knobs matter / are pinned
node scripts/serve.js                                      # viewer at http://localhost:8137/viewer/
node scripts/gen-maps.js --count 32 --seed 1               # regenerate map variants
```

Solo-queue rule: survivors share a goal but get **zero** information about each other beyond what they see themselves.
