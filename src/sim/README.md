# src/sim — 2D chase/stealth engine

Headless, deterministic, zero-dependency ES modules (Node 22 + browsers; no `fs`/`path`; the map JSON is passed in as
an object). One hunter vs four survivors on the 1 m grid described in `docs/MAP_FORMAT.md`.

```js
import { createMatch, runMatch, defaultConfig, mergeConfig } from './src/sim/index.js';
import { survivorBrain, hunterBrain } from './src/sim/testbrains.js';   // trivial baselines

const result = runMatch({ map, seed: 42, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] });
```

Files: `match.js` (rules, perception, observations), `nav.js` (distance fields / A* / waypoints / collision test),
`sight.js` (grid DDA), `mapdata.js` (map rasterisation, cached per map object), `config.js`, `rng.js`, `testbrains.js`.
Checks: `node scripts/test-sim.js` · benchmark: `node scripts/bench.js [--n 200] [--map …] [--decide-every 3]`.

## Solo queue + HUD: brains must not communicate

Survivors share a goal but have **no comms**: no brain may pass information to another. What a survivor knows about
its teammates comes only from the **game HUD** (and auras / notifications the game itself shows) plus its **own sight**.
The engine enforces what it can (each agent gets its own `ctx`, `rng`, `api`, `nav`, `obs`, notification copies;
`config` and static map info are deep-frozen) — the rest is **convention**:

* **No module-level mutable state in brain files** (no top-level `let`/arrays/Maps that brain instances touch, no
  `globalThis`, no shared singletons, no caches shared between instances). Everything a brain remembers lives in the
  closure created by its factory call.
* Don't hand objects from one agent's `obs`/`ctx` to another agent; don't smuggle info through `rng`, timers, files.
* A survivor must not read the match object / other agents' brains. Brains only see `obs`, `ctx`, `api`.

What a survivor can learn (everything else is hidden):

| info | rule |
|---|---|
| **HUD** (`obs.hud`, every tick) | one entry per survivor, index = id, own entry included: `state` (`healthy/injured/downed/carried/hooked/dead/escaped`), `hookCount`, `hookStage` (0 unless hooked, else 1/2), `beingHealed`, `healing` (healing someone), `repairing` (gen id or `null` — gens have known positions, so this reveals the location implicitly; intended), `chased`. **No positions.** Actions reflect the previous tick (what the teammate did last). |
| **hook notifications** | `{type:'hooked', who, hookId, x, z, t}` when a teammate is hooked (when + where; a 3rd-hook sacrifice also sends it, followed by `died`), `{type:'unhooked', who, by: id\|'self', t}`, `{type:'died', who, t}` (any cause). Sent to every other survivor still in the game, not to the subject, not to the hunter. |
| **downed auras** (`obs.downedAuras`) | `[{id, x, z}]` live positions of all downed teammates (not carried, not yourself). |
| **chase** | `hud[j].chased` and `self.chased` (chase music) from the engine chase state (below). |
| teammate positions | otherwise only if seen by the same sight model used for the hunter (360°, range 48 m, semi-transparency): `teammates` = position + visible state. `obs.lastSeen[j]` is the survivor's own memory of the last sighting (HUD/aura info does not update it). |
| generators | progress, *who is working* and `regressing` only for gens currently seen (or within `sight.adjacentReach` = 2 m); otherwise the last-seen value (`visible:false`, `workers:null`, `regressing:null`, `seenT`). Initial memory = progress 0. `blocked` (unfinished gen after the gates are powered) is public. (The HUD's `repairing` tells you *that* a gen is being worked on, not its progress.) |
| exit gates | `powered`/`open` are public; lever `progress` only while you perceive the lever (same sight rule, or within 2 m); open gates report `progress: 1`. |
| pallets | state (`up/dropped/broken`) only for pallets currently seen/adjacent, else last-seen (initially `up`). |
| hunter | position/facing/state only if seen; `lastHunter` = last sighting; `terror` = `{layer, approx}` — which third of the 32 m radius you *hear* (no direction, no exact distance); entering/leaving noticed after 0.5 s, layer changes only after persisting 2.5 s. |
| global announcements | generator completed (notification with gen id + position; `gensDone`), gates powered, gate opened (`gateOpen` notification), endgame countdown (starts at the first opening). |
| screams | a teammate being downed/hooked within `senses.screamRadius` (default **0 = off**) arrives as a `scream` notification `{kind:'down'\|'hook', x, z, t}`. |

Not on the HUD: teammates' positions (except downed auras), generator progress, the anti-camp Resolve meter, Deep Wound / protection timers.

### Chase state (`config.chase`, all rules **assumed**)

Engine-level, at most **one** chased survivor at a time. Updated once per tick (after perception, before brains decide).

* **Start**: the hunter currently sees the survivor (hunter perception: cone, range, visibility), the survivor is
  healthy/injured and within `startRange` (20 m), and the hunter is either moving toward them (velocity component toward the
  survivor > `approachSpeed` = 1 m/s) or winding up / swinging with them inside the ±45° attack arc.
* **End**: the hunter hasn't seen the target for `loseS` (6 s), or the target is downed / carried / hooked / dead / escaped.
* **One at a time**: a different survivor meeting the start rule takes over (most recent chase) unless the current target meets it
  too; several new candidates in the same tick → the nearest. A carrying hunter can also start a chase (not excluded).
* Exposed as `hud[j].chased`, `self.chased` (survivors) and `obs.chase = { target: id|null }` (hunter). Events `chaseStart {who}`,
  `chaseEnd {who, reason: 'lost'|'switch'|<state>}`.

Hunter knowledge: visible survivors in the 100° cone, all generator progress + `regressing` (but *workers* only for visible gens),
generators being repaired within `senses.repairNoiseRadius` (10 m, `noisyGens`, no identity/count), lever progress of gates in its
cone (or within 2 m), hooked survivors (stage/timer), pallet states, notifications (incl. `loudNoise` from fast vaults), grunts,
scratch marks, who is dead/escaped. Not visible to the hunter: unhook protection, Deep Wound.

## API

### `createMatch(opts)` / `runMatch(opts)`

```js
{ map,                       // map JSON object
  seed,                      // number | string (default 1)
  config,                    // partial overrides, deep-merged over defaultConfig (see config.js; all numbers live there)
  hunter,                    // brainFactory
  survivors,                 // [factory x4] (a single function is reused for all four)
  record }                   // true => result.record = { meta, frames } (every `recordEvery` ticks, default 2)
```
`createMatch` → `Match`: `step()` advances one tick (0.1 s); `over`; `result()`; `tick`, `t`. For tests/viewers the live state
is readable: `hunter`, `survivors[i]` (`x z face st …`), `gens`, `hooks`, `gates`, `ps` (pallet states 0 up/1 dropped/2 broken),
`gensDone`, `gatesPowered`, `endgameT`, `events`. `runMatch` runs to completion and returns:

```js
{ seed, mapId, over, endReason: 'all-out'|'time',
  winner: 'hunter'|'survivors'|'draw',   // kills > escapes → hunter, escapes > kills → survivors
  kills, escapes, timeouts,              // timeouts = still alive at the 20-minute cap
  gensDone, hooks, durationS, ticks,
  survivors: [{ id, outcome: 'escaped'|'dead'|'timeout', cause, tOut, hooks, repairS }],
  stats: { hits, downs, hooks, pickups, stuns, palletsDropped, palletsBroken, vaults, wiggles, rescues, heals, fumbles, missed },
  gens: [ids chosen], events: [{ t, type, … }], record? }
```
Event types: `start hit miss pickup hook hookStage rescue resolveFull selfUnhook protect heal mend deepWoundDown palletDrop palletBreak dropped wiggle fumble genDone genKick genRegressStop gatesPowered gateOpen endgame loudNoise windowBlocked chaseStart chaseEnd escape death end`
(`hit` with `endurance: true` = absorbed by unhook Endurance)
(`death.cause`: `bleedout | hookDeath | hook3 | endgame`).

**Frames** (`record:true`): `{ t, h:[x,z,facing,carryingId|-1,status], s:[[x,z,facing,state,act,boost]×4], g:[gen progress 0..1], p:[pallet states] }`
(survivor act codes 0 none 1 repair 2 heal 3 rescue 4 dropPallet 5 openGate 6 wiggle 7 vault 8 mend; hunter kicks show as status 5 interacting);
`record.meta.legend` documents the codes; `meta.gens`/`meta.pallets` give the id order. `p` is shared between frames while unchanged.

### Brain factory

`(ctx) => ({ decide(obs, api) { return action } })` — called every `decisionEvery` ticks (default 1); between calls the last
action repeats. Hooked/dead/escaped survivors are not asked. An exception in a brain propagates.

`ctx = { id, role: 'hunter'|'survivor', map, config, rng, spawn, nav, api }`

* `id`: survivors `0..3`; hunter `'hunter'`. `rng`: per-agent seeded stream (`next() int(n) range(a,b) chance(p) pick shuffle normal`).
* `map`: frozen static info — `size,w,h,eyeHeight,outline,obstacles,windows[{id,x,z,axis}],pallets[{id,x,z,axis,length,x0,z0,x1,z1,cx,cz}]`,
  `generators` (**only the 7 chosen** for this match, order = `obs.gens` order), `gensNeeded`, `hooks`, `exitGates[{id,lever,exit}]`, `spawns`.
  `obs.pallets[i]` is aligned with `map.pallets[i]`.
* `api` (same object as `ctx.api`): `nav`, `visibility(a,b)` (0..1, points `{x,z}`), `los(a,b)` (visibility ≥ threshold), `walkClear(a,b)`, `cellOf(x,z)`, `dt`.

### Navigation (`api.nav`, role-bound)

* `dist(from, to)` → metres along the walkable grid (octile, 8-connected, no corner cutting, vault penalties; `Infinity` if unreachable).
  O(1) for map features (generators, hooks, pallets, windows, levers, exits, spawns — fields are cached, LRU 256, shared across matches);
  other targets cost a bounded A* (~0.05–0.4 ms) and become cached after repeated queries. Prefer Euclid for moving targets.
  Hunter: dropped pallets are blocked (if the search budget is exceeded the static distance + `nav.crossPenalty` is returned).
* `nextWaypoint(from, to)` → `{x,z}` or `null`; string-pulled (farthest path node reachable in a straight swept-circle line).
  If `to` is inside a solid cell (generator, dropped pallet) it ends at the last walkable cell in front of it.
* `walkClear(from, to)` swept-circle (r = 0.4) test against the current collision grid.
* All distances are exact integer-millimetre costs, so results never depend on cache state.

### Action object

```js
{ moveTo: {x,z} | null,      // engine nav (hunter variant avoids dropped pallets); wins unless moveDir is given
  moveDir: {x,z} | null,     // raw steering (normalised); {0,0} = stand
  walk: bool,                // survivors: 2.3 m/s, no scratch marks
  face: {x,z}?,              // POINT to look at (hunter vision cone / attack direction follows facing)
  act: null | 'repair' | 'heal' | 'rescue' | 'mend' | 'dropPallet' | 'openGate' | 'attack' | 'pickup' | 'hook' | 'breakPallet' | 'kickGen' | 'wiggle',
  target: id? }              // gen id / pallet id / hook id / gate id (string) or survivor id (number); default = nearest valid
```
Interactions continue while the action is repeated each tick and the actor stays in range; **moving cancels** them (so give `moveTo`
*and* `act` together only if you want "walk, then do it when arrived" — the act starts as soon as the move command yields no step).
Progress resets if the act/target changes or a tick passes without it (except persistent progress stored on the object: generator
progress, gate lever progress, heal progress on the patient, mend progress).

| act | who | range / time |
|---|---|---|
| `repair` | survivor | within 1.1 m of the generator cell; 90 s solo; per-worker efficiency 1.0 / 0.85 / 0.7 / 0.55 for 1 / 2 / 3 / 4 workers; fumble 1 %/repair-second: −10 % progress + loud hunter notification. Any repair progress stops a kick regression. Nothing happens once the gates are powered (remaining gens blocked) |
| `heal` | survivor→other | 1.6 m centre-to-centre; 16 s, progress persists on the target; injured→healthy, downed→injured; never self; not while the target has Deep Wound |
| `rescue` | survivor | within 1.8 m of the hook; 1 s; victim → injured + unhook protections (below) |
| `mend` | survivor (self) | only with Deep Wound; 12 s, progress persists; clears Deep Wound; Deep Wound timer paused while mending |
| `dropPallet` | survivor | within 1.2 m of an *up* pallet; 0.3 s; hunter inside footprint ±1 m along axis → stunned 2 s; pallet ends dropped either way |
| `openGate` | survivor | gates must be powered; within 1.5 m of the lever; 20 s; **one survivor per lever** (a second one gets nothing while it is occupied — worked this or the previous tick); progress persists on the gate when the opener lets go; the 2 gates are independent; escape by reaching `exit` (≤ 1 m) of an open gate |
| `attack` | hunter | 0.35 s windup (4 ticks), then hit if a healthy/injured survivor is within 2.2 m and ±45° of facing and visible; hit cooldown 2.7 s (speed 1.0), miss 1.5 s (speed 2.3) |
| `pickup` | hunter | downed survivor within 1.5 m; 2 s |
| `hook` | hunter | carrying, within 1.5 m of a free hook; 1 s. 1st hook: stage 1 (60 s) → stage 2 (60 s) → dead; 2nd hook starts in stage 2; 3rd hook = dead |
| `breakPallet` | hunter | within 1.5 m of a dropped pallet; 2.34 s (2.4 s in whole ticks) |
| `kickGen` | hunter | not carrying; within 1.1 m of a gen with progress > 0, not done, not already regressing, gates not powered; 1.8 s → −5 % of the bar and the gen regresses at ¼ of a solo repair rate (360 s per bar) until a survivor repairs it or it reaches 0 |
| `wiggle` | carried survivor | repeat for 16 s → free (downed, hunter stunned 1.5 s) |

Windows: entering a window cell along its axis triggers a vault (position locked); not possible along the other axis. Hunter 1.7 s.
Survivor tiers: **fast 0.5 s** = running with a straight run-up ≥ 2.5 m (continuous running distance whose heading stays within 25° of the
vault direction; reset on walking, stopping, being blocked, turning, vault end) — fast vaults are LOUD: the hunter gets
`{type:'loudNoise', cause:'vault', x, z, t}` (within `senses.loudNoiseRange`, default map-wide); **medium 0.9 s** = running with a shorter
run-up / angled approach / after bumping a wall; **slow 1.5 s** = walking (quiet, no scratch marks). Dropped pallets: survivors vault (1.2 s), the hunter is blocked. Characters are circles r = 0.4 m; no character–character collision.

### Observations

Survivor `obs`:
```js
{ t, tick,
  self: { id,x,z,vx,vz,facing,state,hookCount,hookStage,hookTimerS,boosted,vaulting,act,progress,bleedS,healProgress,wiggle,
          deepWoundS /* null if none */, protectedS /* remaining unhook protection, null if none */, chased /* chase music */ },
  hunter: { x,z,vx,vz,facing,fx,fz,carrying,windup,cooldown,stunned } | null,       // only if visible now
  lastHunter: { x,z,vx,vz,facing,t } | null,
  terror: { layer: 1|2|3, approx } | null,   // heard terror-radius layer (thirds of 32 m, 1 = outermost), lagged; approx = band midpoint m
  teammates: [{ id,x,z,vx,vz,facing,state }],                                       // visible now
  lastSeen: [ {x,z,state,t} | null ×4 ],                                            // own memory, index = survivor id
  hud: [{ id, state, hookCount, hookStage /*0|1|2*/, beingHealed, healing, repairing /*gen id|null*/, chased } ×4],  // game HUD, index = id, no positions
  downedAuras: [{ id,x,z }],                                                        // live positions of downed (not carried) teammates
  gens: [{ id,x,z,progress(0..1),done,blocked,regressing|null,visible,workers:[ids]|null,seenT }],   // order = ctx.map.generators
  gensDone, gensNeeded, pallets: ['up'|'dropped'|'broken'…],
  gates: [{ id, powered, open, progress? }],   // progress 0..1 only if the lever is perceived (always 1 when open)
  gatesPowered, endgame: { remainingS } | null,  // null until the first gate is OPENED
  notifications: [all so far], newNotifications: [since last decide] }
```
Hunter `obs`:
```js
{ t, tick,
  self: { x,z,vx,vz,facing,fx,fz,carrying: id|null,cooldownS,windupS,stunS,vaulting,act,progress },
  survivors: [{ id,x,z,vx,vz,facing,state,hookCount,vaulting }],     // in the 100° cone, range 48 m, visibility ≥ 0.5
  lastSeen: [ {x,z,state,t}|null ×4 ],
  grunts: [{x,z,t}],            // injured survivors within 10 m, ±2 m noise, no identity, kept 2 s
  scratches: [{x,z,t,dx,dz}],   // sprint marks of the last 10 s inside the cone (≤ 30 m, visible)
  gens: [{ id,x,z,progress,done,blocked,regressing,visible,workers:[ids]|null }], gensDone, gensNeeded,
  noisyGens: [{ id,x,z }],      // gens with >= 1 worker within senses.repairNoiseRadius (10 m)
  hooked: [{ id,hookId,stage,timerS,hookCount }], status: ['alive'|'dead'|'escaped' ×4],
  chase: { target: id|null },   // engine chase state (see "Chase state")
  pallets: [...], gates /* progress only for levers in the cone */, gatesPowered, endgame, notifications, newNotifications }
```
Notification objects: `{type:'genDone', gen,x,z,t,gensDone}` (everyone), `{type:'fumble', gen,x,z,t}` (hunter only),
`{type:'gatesPowered', t}` (everyone), `{type:'gateOpen', gate, t}` (everyone), `{type:'loudNoise', cause:'vault', x,z,t}` (hunter only),
`{type:'scream', kind,x,z,t}` (survivors, if enabled), HUD (survivors except the subject): `{type:'hooked', who,hookId,x,z,t}`,
`{type:'unhooked', who, by: id|'self', t}`, `{type:'died', who,t}`.
Obs objects are freshly allocated every call and owned by the receiving brain.

## Rules summary / sight model

* 10 Hz; match cap 20 min; 7 of the map's generator candidates chosen per match (seeded), 5 needed → both exit gates powered and the
  remaining gens blocked. The 2-minute endgame collapse starts when the **first gate is opened** (not at power-up); survivors still in the
  game when it expires die (`death.cause: 'endgame'`). If only one survivor remains before the gates are powered they auto-power (hatch
  stand-in; the timer still waits for an opening). Powered-but-never-opened matches end at the 20-minute cap (`timeouts`).
* **Spawns**: `map.spawns.survivors` are anchor candidates: one is picked (seeded) and the 4 survivors are placed on distinct free
  positions within `spawn.groupRadius` (15 m path distance from the anchor and pairwise, ≥ 1.5 m apart; other candidates near the anchor
  first, then random free cells). Hunter: `map.spawns.hunter` candidates whose path distance from the anchor is ≥ `spawn.hunterMinFrac`
  (0.8) × the farthest free cell ≥ `spawn.edgeInset` (4 m) inside the outline; seeded pick. If none qualifies (or there are none), that
  farthest inset cell is used — so maps with only central hunter candidates still spawn the hunter on the far side.
* **Unhook protections** (basekit, `config.unhook`): for 10 s after being rescued (same before and after the gates are powered):
  +10 % haste (×1.10; the on-hit ×1.5 burst takes precedence, max of the two), **Endurance** (a hit that would down you leaves you injured
  with **Deep Wound** and consumes the endurance) and **Elusive** (no scratch marks, no grunts of pain). All end early on a conspicuous
  action: repair, heal, rescue, openGate (mend and dropPallet are fine). No aura/hunter reveal. Deep Wound: 20 s timer → downed on
  expiry; self-`mend` 12 s clears it (timer paused while mending); cannot be healed while it lasts.
* Speeds m/s: survivor 4.0 (walk 2.3, crawl 0.7), hit boost ×1.5 for 2 s, hunter 4.6 (carrying 4.0, hit cooldown 1.0).
* Health: healthy → injured → downed (bleeds out in 240 s while downed; paused while carried/hooked).
* **Sight**: tall obstacles (height ≥ eyeHeight) and cells outside the outline are opaque. Low obstacles, windows, pallets (up/dropped/broken) and
  generators are semi-transparent: each distinct one a ray crosses multiplies visibility by `sight.semiTransparency` (0.6; a multi-cell obstacle counts once;
  start/end cells excluded). **A target is "seen" iff in range (48 m), in the cone (hunter 100°; survivors 360°) and visibility ≥ `sight.visThreshold` (0.5)** —
  deterministic, no RNG. So one semi-transparent obstacle is see-through, two are not. Dynamic sight (hunter↔survivors↔survivors) refreshes every
  `perceptionEvery` = 2 ticks; generators/pallets use per-cell cached visibility masks (from the cell centre), shared across matches.

## Anti-camp "Resolve" self-unhook (`config.antiCamp`)

A hooked survivor has a hidden 0..1 meter. Neither the hunter nor teammates see it (the game shows the bar to others as a HUD
feature; not part of our `hud`). When it is full, a **guaranteed self-unhook** starts automatically (hooked brains are
not called), takes 1.5 s with the hook timer paused, and gives the normal unhook result (injured + 10 s unhook protections).
Events: `resolveFull`, then `selfUnhook`.

| part | source |
|---|---|
| fills only while the hunter is within 20 m of the hook; closer = faster | sourced |
| camping-time multiplier 1× for the first 10 s of continuous camping, 2× for 10–20 s, 4× beyond; resets on unhook | sourced |
| every hook event gives ALL hooked survivors a 7 s grace pause | sourced |
| other survivors nearby slow/stop it | sourced (the exact rule is assumed: any other non-hooked survivor within 8 m of the hook stops it) |
| full meter ⇒ guaranteed 1.5 s self-unhook, either stage, normal unhook result; disabled once the gates are powered | sourced |
| faster the further the survivor is through the current hook stage | user (authoritative) |
| rate/s = (1 / `baseFullS`) × proximity × timeMult × (1 + 3·f²), f = elapsed fraction of the current stage | assumed |
| proximity 1 within 4 m, linear down to 0.25 at 20 m, 0 beyond | assumed |
| camping time accrues while the hunter is in range (also during the grace) and resets after 5 s out of range | assumed |
| no fill while the hunter carries someone or sees a standing survivor within 16 m (in chase) | assumed |
| meter persists across the stage change within one hook; resets on a new hook and on unhook | assumed |
| `baseFullS` = 100 | assumed. Tuned to the user's goals: 60 gave ~26 s face-camp, below the 30–40 s target |

Tuning check (gas-heaven, hunter standing still at the given distance from the hook from the moment of the hook,
stage 1 at 60 s, nobody else around; time from the hook until the meter is full, the self-unhook ends 1.5 s later):

| hunter distance | 2 m | 6 m | 10 m | 15 m | 20 m |
|---|---|---|---|---|---|
| hooked at 0% of stage | 31.6 s | 33.0 s | 36.6 s | 43.7 s | 58.8 s |
| hooked at 50% of stage | 23.0 s | 23.8 s | 25.8 s | 31.1 s | 66.3 s |
| hooked at 75% of stage | 29.7 s | 31.8 s | 37.3 s | 47.6 s | 66.9 s |

(The 75% row is slower than the 50% row because the stage changes 15 s in and f restarts at 0. Much of the late-stage
window falls inside the grace, while the camping multiplier is still 1×.) Hook, kick a nearby gen and leave (~4 s at 3 m + 6 s at 9 m)
gives about 2%, because most of that time falls inside the 7 s grace. Tests cover face-camp 30–40 s, kick-and-leave < 10%, the teammate freeze, the chase pause, carrying,
grace re-grant, gates powered, stage 2, persistence across the stage change, and that observations show no meter.

## Determinism

Seeded: world rng (`'world'` stream: generator choice, spawns, fumbles, grunt noise) + one stream per agent. Same `(map, seed, config, brains)` ⇒
identical result, events and frames — regardless of what ran before in the process (navigation caches never change routes or distances; tested cold vs warm).
Brains must not use `Math.random`/`Date.now` — use `ctx.rng`.

## Deviations / choices not in the brief

* Unused generator candidates stay as inert solid low blocks ("wrecks") so the nav grid is static and distance fields can be cached across matches.
* Timers elapse in whole ticks (rounded up): windup 0.35 s = 0.4 s. Broken pallets stay semi-transparent for sight.
* Attack: the hunter keeps moving along its facing during the windup but plants as soon as a valid target is inside 0.9×range and the arc (no overshoot), so effective reach is
  larger than 2.2 m. Unspecified numbers chosen in `config.js`: `missCooldownSpeed 2.3`, `wiggleStunS 1.5`, reach distances, `scratchEveryS 0.5`, `gruntIntervalS 1`.
* A dropped pallet that drops onto an actor pushes the actor to the nearer approach side; a stunned hunter drops a carried survivor (downed).
* `face` is a point to look at, not a direction. Hunter grunts carry no survivor id.
* Hooked survivors' brains are not called. Survivors cannot act while downed except crawling; a carried survivor can only `wiggle`.

## Performance (gas-heaven 112×96, baseline brains, one core)

~145–155k ticks/s ≈ **24 matches/s** (matches average ~6000 ticks ≈ 10 game-minutes); `decisionEvery: 2` ≈ 31/s; `decisionEvery: 3, sight.perceptionEvery: 3` ≈ 35/s.
Matches are independent and share only read-only data, so run one process/worker per core for hill-climbing. Brain cost is on top: calls to
`nav.dist`/`nextWaypoint` for non-feature targets and large obs scans dominate; prefer feature targets and Euclid for moving ones.

## Genre-alignment pass (2026-11-15)

Numbers checked against the community wiki (deadbydaylight.wiki.gg): walk 2.26, carry 3.68, lunge 1.5× (≈6.9 m/s),
hit/miss cooldown speeds 0.575 / 1.15, on-hit boost 1.8 s, generators 90 s, pallet break 2.34 s, scratch marks fade after 10 s.
Window vaults: fast 0.5 s (straight 2.5 m run-up, loud) / medium 0.9 s / slow 1.5 s (walking). Entity blocker: a survivor's 3rd vault of
the same window within 60 s blocks that window for **that survivor only** for 30 s (`obs.blockedWindows` lists the ones
blocked for you). Swings only connect if no solid cell (wall, low wall, generator) is between hunter and target —
windows and pallets can be hit across.
