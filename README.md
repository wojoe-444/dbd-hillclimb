# dbd-hillclimb

A fun experiment: a headless, deterministic **2D asymmetric chase sim** (1 hunter vs 4 survivors, in the style of
the genre: generators, hooks, pallets, windows, exit gates). Both sides are played by plain hand-written bot code —
no LLMs at runtime — whose knobs are **hill-climbed** against each other to watch the meta evolve. A Three.js viewer
renders matches in 3D.

- `src/sim/` — the engine (rules, perception, nav). See [`src/sim/README.md`](src/sim/README.md).
- `src/brains/` — parametric hunter and survivor bots (`hunter.js`, `survivor.js`), registry in `index.js`.
- `src/hillclimb/` — alternating hill-climb over a worker pool (`climb.js`).
- `src/mapgen/` + `maps/` — tile-based seeded map generator; pilot map *Gas Heaven* (`maps/gas-heaven/v000–v031`),
  hand-made v1 `maps/gas-heaven.json`. Format: [`docs/MAP_FORMAT.md`](docs/MAP_FORMAT.md). Even variants use the
  layout's fixed outline; odd ones get a seeded stepped outline (`src/mapgen/outline.js`: 144–153 8 m tiles, aspect
  ≤ 1.6, min width 4 tiles; families notched / circlish / blob / chunky) with the fixed pieces refit to it.
- `viewer/` — 3D viewer that runs the real engine in the browser.

```sh
node scripts/test-sim.js                                   # engine tests
node scripts/matchup.js --n 50 --map maps/gas-heaven       # quick matchup with default params
node src/hillclimb/climb.js --map maps/gas-heaven --gens 200 --k 8 --n 64 --out runs/my-run
node scripts/serve.js                                      # viewer at http://localhost:8137/viewer/
node scripts/gen-maps.js --count 32 --seed 1               # regenerate map variants
```

Solo-queue rule: survivors share a goal but get **zero** information about each other beyond what they see themselves.
