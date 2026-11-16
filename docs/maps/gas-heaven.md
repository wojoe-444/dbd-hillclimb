# Gas Heaven pilot

An original collision layout based only on the supplied silhouette and landmark positions. The dimension reference confirms a 112 × 96 m box, a 16 × 16 m northwest notch, and a 16 × 32 m southeast notch: 9,984 m², or 156 eight-meter tiles. Coordinates use x east and z south. The numbered zones are orientation labels, not gameplay regions.

The main building occupies x=50–75, z=14–35 (wall cells at x=50/74 and z=14/34), matching the approximate M reference. Four ordinary entrances, three exterior windows, and a window/pallet interior U-wall offer several routes. Its roofless simulation footprint has 3.5 m walls. Two generator candidates sit inside, separated by the interior loop.

The shack occupies x=28–37, z=78–87, with 3.2 m walls, north/east doors, a west window, and a nearby low-car pallet. BITIC becomes three stepped junk tiles running southwest to northeast around (8,60), (17,48), and (27,39). Its label stays horizontal because the format only defines text and position. M, S, MID, BITIC, and all twelve perimeter numbers are present as labels.

Other loops occupy the northwest, northeast, west, east, southeast shoulder, south, and lower southeast. Most cover heights are 2.6–3.0 m; cars/crates are 1.0 m, below the 1.6 m eye height. The low MID loop preserves sight across the center. Open rotation lanes and dead zones between tiles, especially south of MID, make travel between loops consequential. Tile names describe roughly eight-meter regions; stronger loops span adjacent regions. No commercial interior layout was copied.

There are 11 generator candidates, 20 hooks, 2 opposite north/south gate candidates, 2 central hunter starts, and 3 survivor clusters with 4 points each (northwest, northeast, southwest). Gate exits occupy the last playable row, with levers 1.5 m inside the boundary as in the format example. Hook locations were adjusted against obstacle-aware grid distances: every walkable cell is within 20 steps of a hook. Windows and standing pallets count as walkable for this measurement, following the connectivity rule; vault timing and dropped/broken state are not modeled by this static validation.

## Pallets

Positions identify the first footprint cell. Length runs perpendicular to the travel axis. Strengths are design estimates pending simulation playtests.

| ID | (x,z) | Travel | Length | Loop / intended strength |
| --- | --- | --- | --- | --- |
| p-m-s | (69,34) | z | 2 | Main south wall; medium, nearby door bypass |
| p-m-i | (67,27) | x | 1 | Main interior U; strong, alternate interior window |
| p-s | (32,88) | z | 2 | Shack cars; weak alone, can chain to shack |
| p-b1 | (13,60) | z | 2 | BITIC southwest junk L; medium |
| p-b2 | (22,48) | z | 1 | BITIC middle wall/window; medium |
| p-b3 | (32,39) | z | 2 | BITIC northeast car/wall; weak |
| p-mid | (56,47) | x | 2 | Central low C; weak, visible across cover |
| p-nw | (26,11) | x | 1 | Northwest long wall/window; strong |
| p-ne | (93,14) | z | 2 | Northeast mixed L; weak, short car bypass |
| p-e | (103,38) | x | 1 | East long C/window; strong |
| p-se | (86,58) | z | 1 | Southeast shoulder mixed L; medium |
| p-sel | (85,82) | x | 2 | Lower southeast tall/low wall; medium |
| p-south | (57,80) | z | 2 | South tall L; strong |
| p-west | (11,29) | x | 1 | West tall/low wall; medium |

## Windows

Each is 1 × 1 m, with solid cells on both wall sides and open approach cells along the travel axis.

| ID | (x,z) | Travel | Location |
| --- | --- | --- | --- |
| w-m-n | (66,14) | z | Main north |
| w-m-e | (74,23) | x | Main east |
| w-m-s | (56,34) | z | Main south |
| w-m-i | (60,25) | x | Main interior |
| w-s | (28,82) | x | Shack west |
| w-b1 | (8,63) | x | BITIC southwest |
| w-b2 | (26,48) | z | BITIC middle |
| w-nw | (29,6) | z | Northwest |
| w-e | (106,43) | z | East |

## Reproduce

Run from the project root with Node (no dependencies):

```sh
node scripts/validate-map.js maps/gas-heaven.json
node scripts/render-map.js maps/gas-heaven.json
# Optional destination:
node scripts/render-map.js maps/gas-heaven.json docs/maps/gas-heaven.svg
```

The SVG includes the outline, eight-meter grid, heights split at eye level, feature IDs, spawns, labels, and legend. `gas-heaven.png` is a visually inspected raster snapshot of the SVG; PNG conversion is optional and is not a runtime dependency of either script.

Validated totals: 9,563 connected walkable cells, 268 tall solid cells, 153 low solid cells (including 11 generators), and 768 cells outside the outline. Geometry has 88 obstacles, 14 pallets, and 9 windows. Maximum nearest-hook walking distance is 20 m. Validation also checks clockwise/simple orthogonal outlines, integer rectangle containment, overlaps, point placement, window/pallet supports and approaches, reachable repair neighbors, and exit boundary adjacency. Hook range and pallet strengths are layout goals, not additional map-format validity limits.
