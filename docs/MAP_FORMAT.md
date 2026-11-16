# Map format (v1)

Maps are plain JSON in `maps/<id>.json`. Only **movement collision** and **line of sight**
matter to the simulation. Colors/textures are irrelevant (the viewer picks colors by `kind`).

## Coordinates

- Units are meters. Top-down view: `x` grows east (right), `z` grows south (down) —
  same orientation as the reference images in `docs/ref/`.
- Origin `(0,0)` is the top-left corner of the map's bounding box.
- The simulation uses a **1 m grid**: cell `(i, j)` covers `[i, i+1) × [j, j+1)`.
  All rectangles (`obstacles`, `windows`, `pallets`) use **integer** coordinates and sizes
  so they snap to cells exactly. Points (`generators`, `hooks`, …) may be fractional
  (use cell centers like `40.5`).
- Characters are circles of radius 0.4 m, so a 1-cell gap is passable.

## Top-level fields

```jsonc
{
  "id": "gas-heaven",
  "name": "Gas Heaven (pilot)",
  "size": { "w": 112, "h": 96 },          // bounding box in meters
  "outline": [[x, z], ...],               // playable boundary polygon; axis-aligned, integer, clockwise.
                                          // Cells outside are solid + sight-blocking.
  "eyeHeight": 1.6,                       // obstacles with height >= eyeHeight block line of sight

  "obstacles": [
    // Solid axis-aligned box. Blocks movement always.
    // Blocks line of sight iff height >= eyeHeight ("tall"); otherwise it's "low" (see over it).
    { "id": "m-wall-n", "x": 40, "z": 10, "w": 24, "d": 1, "height": 3.5, "kind": "wall" }
    // kind is cosmetic: wall | building | rock | car | crate | tree | debris | fence | ...
  ],

  "windows": [
    // A 1x1 vault opening inside a wall line. Walkable ONLY by vaulting along `axis`
    // ("x" = traverse east/west, "z" = traverse north/south). Never blocks sight.
    // The cells on either side along `axis` must be walkable; the two cells on the other
    // axis must be solid (it sits in a wall).
    { "id": "m-win-1", "x": 45, "z": 10, "axis": "z" }
  ],

  "pallets": [
    // Standing pallet in a gap. Footprint is `length` cells (1 or 2) laid perpendicular to `axis`.
    // `axis` = direction of travel through the gap. Up: walkable, transparent.
    // Dropped: survivors vault it, hunter is blocked until it breaks it. Never blocks sight.
    // The gap's sides (perpendicular to axis) must be solid; both approach sides walkable.
    { "id": "p-shack", "x": 20, "z": 70, "axis": "x", "length": 1 }
  ],

  "generators": [ { "id": "g1", "x": 30.5, "z": 20.5 } ],   // 10-12 candidates; 7 used per match.
                                                            // A generator is a solid low 1x1 block at that cell
                                                            // (don't put an obstacle there too); repaired from any adjacent walkable cell.
  "hooks":      [ { "id": "h1", "x": 50.5, "z": 40.5 } ],   // in walkable cells, not solid
  "exitGates":  [
    // Lever on an outline edge; survivors escape by reaching `exit` once the gate is open.
    { "id": "gate-n", "lever": { "x": 60.5, "z": 1.5 }, "exit": { "x": 62.5, "z": 0.5 } }
  ],
  "spawns": {
    "hunter":    [ { "x": 56.5, "z": 50.5 } ],
    "survivors": [ { "x": 10.5, "z": 80.5 } ]              // several clusters/candidates
  },
  "labels": [ { "text": "12", "x": 58, "z": 6 } ]           // viewer-only orientation labels
}
```

## Validity rules (checked by `scripts/validate-map.js`)

- Every rectangle lies inside the outline; obstacles may touch but not overlap
  windows/pallets/generators/hooks/spawn/exit/lever cells.
- All walkable cells reachable from the hunter spawn form one connected region
  (windows/pallets count as walkable); every generator's neighbours, hook, lever, exit and
  spawn is in it.
- Window and pallet placement rules above.
