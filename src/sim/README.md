# src/sim — 2D chase/stealth engine

Headless, deterministic, zero-dependency ES modules (Node 22 + browsers; no `fs`/`path`; the map JSON is passed in as
an object). One hunter vs four survivors on the 1 m grid described in `docs/MAP_FORMAT.md`.

```js
import { createMatch, runMatch, defaultConfig, mergeConfig } from './src/sim/index.js';
import { survivorBrain, hunterBrain } from './src/sim/testbrains.js';   // trivial baselines

const result = runMatch({ map, seed: 42, hunter: hunterBrain, survivors: [survivorBrain, survivorBrain, survivorBrain, survivorBrain] });
```

Files: `match.js` (rules, perception, observations), `nav.js` (distance fields / A* / waypoints / collision test),
`sight.js` (grid DDA), `mapdata.js` (map rasterisation, cached per map object), `config.js`, `rng.js`, `testbrains.js`,
`slotpick.js` (brain helper: walk to a free generator side slot and repair).
Checks: `node scripts/check-gen-slots.js` (generator side slots on every shipped map; warns on gens with only 1–2 usable sides).
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
| **HUD** (`obs.hud`, every tick) | one entry per survivor, index = id, own entry included: `state` (`healthy/injured/downed/carried/hooked/dead/escaped`), `hookCount` (physical hookings), `hookStage` (current stage while hooked, else 0), `hookStages` (stages consumed so far, 0–2), `beingHealed`, **`activity`** (`'repair'\|'heal'\|'mend'\|'gate'\|'rescue'\|'wiggle'\|'selfUnhook'\|'recover'\|null`) + **`activityProgress`** (0..1 progress circle of that interaction: the generator's / patient's / lever's / own progress) — the interaction *type* only, **never which generator / gate / teammate** (solo-queue Status HUD, report §8), `chased`, **`resolve`** (hooked teammate's Resolve meter 0..1, else 0; teammate-visible since 9.3.0), **`deepWound`** (remaining Deep Wound timer as a fraction 0..1, or `null`). **No positions.** Activities reflect the latest act (previous tick for teammates that act later in the tick order). |
| **intent messages** (10.2.0) | `{type:'intent', from, intent, t}` from a teammate (see "Intent messages"). Predefined enum only — no coordinates, no free text. |
| **hook notifications** | `{type:'hooked', who, hookId, x, z, t}` when a teammate is hooked (when + where; a sacrifice on hooking also sends it, followed by `died`), `{type:'unhooked', who, by: id\|'self', t}`, `{type:'died', who, t}` (any cause). Sent to every other survivor still in the game, not to the subject, not to the hunter. |
| **downed auras** (`obs.downedAuras`) | `[{id, x, z}]` live positions of all downed teammates (not carried, not yourself). |
| **dying survivor's auras** (`obs.mateAuras`) | only while you are downed: `[{id, x, z, state}]` live positions of every teammate still in the match (reciprocal of downed auras; report §3). `null` otherwise. Does not update `lastSeen`. |
| **chase** | `hud[j].chased` and `self.chased` (chase music) from the engine chase state (below). |
| teammate positions | otherwise only if seen (survivor camera vision, see "Survivor camera"; range 75 m, semi-transparency): `teammates` = position + visible state. `obs.lastSeen[j]` is the survivor's own memory of the last sighting (HUD/aura info does not update it). |
| generators | **no gen auras: a survivor only knows the generators it has found.** `obs.gens[i]` has `known:false` and `id`, `x`, `z`, `slots` = `null` until this survivor has perceived the gen once (seen per the per-cell gen visibility, or within `sight.adjacentReach` = 2 m) or a `genDone` announcement gave its position; after that they stay known (`slots` = usable repair side points). Survivor `ctx.map.generators` has the same length/order but **every entry is `null`** (the id would otherwise reveal the spot via `generatorCandidates`, which stays public as static geometry: the candidate wrecks are visible map features). Progress, *who is working*, `regressing` and `slotsTaken` (busy sides) only for gens currently seen (or adjacent); otherwise the last-seen value (`visible:false`, `workers:null`, `regressing:null`, `slotsTaken:null`, `seenT`). Initial memory = progress 0. `blocked` (unfinished gen after the gates are powered) is public. (A teammate's HUD `activityProgress` shows *how far* their gen is, not *which* gen.) |
| exit gates | `powered`/`open` are public; lever `progress` only while you perceive the lever (same sight rule, or within 2 m); open gates report `progress: 1`. |
| pallets | state (`up/dropped/broken`) only for pallets currently seen/adjacent, else last-seen (initially `up`). |
| hunter | position/facing/state only if seen; `lastHunter` = last sighting; `terror` = `{layer, approx}` — which third of the 32 m radius you *hear* (no direction, no exact distance); entering/leaving noticed after 0.5 s, layer changes only after persisting 2.5 s. |
| global announcements | generator completed (notification with gen id + position; `gensDone`), gates powered, gate opened (`gateOpen` notification), endgame countdown (`endgame.remainingS`, `endgame.slowed`). |
| screams | a teammate being downed/hooked within `senses.screamRadius` (default **0 = off**) arrives as a `scream` notification `{kind:'down'\|'hook', x, z, t}`. |

Not on the HUD: teammates' positions (except the auras above), which generator anyone works on, where unfound generators are, unhook protection timers.

### Intent messages (`config.intent`, 10.2.0 "Survivor Intent System")

A survivor action may carry `intent: <enum>`; it is delivered to every *other* survivor still in the match (not the hunter) as
`{type:'intent', from, intent, t}`. Only processed on decision ticks (a repeated action does not resend). Default vocabulary
(`config.intent.messages`, the 8-slot default wheel as shown in a pre-release settings screenshot — **medium confidence**; the live
pool has ~14 selectable phrases incl. "Damn!", "Nice", "Hex!", "Boon!", "Leave!", "Gate!"): `goingForGen` (Going for Generator),
`goingForUnhook`, `chasingMe`, `healing`, `help`, `thanks`, `splitUp`, `repair`. Unknown values are ignored.
Anti-spam [S: starts at 1 s, rises to 5 s; A: the exact escalation]: each send locks sending for the current cooldown; a send
within `spamWindowS` (5 s) of the previous one raises the cooldown by 1 s (max 5 s); `resetS` (10 s) without sending resets it to
1 s. So spamming every tick sends at 0, 1, 3, 6, 10, 15, 20 … s. Own lockout: `self.intentCooldownS`. Hooked survivors can send too.

### Chase state (`config.chase`)

Engine-level, at most **one** chased survivor at a time. Updated once per tick (after perception, before brains decide).

* **Start** [S]: the hunter is not carrying, currently sees the survivor (hunter perception: cone, range, visibility), the survivor
  is healthy/injured, within `startRange` (**12 m**) and **running** (speed > `runSpeed` = 3 m/s [A]; walking 2.26 does not start a chase).
* **End** [S]: target farther than `loseRange` (**18 m**), or not seen for `loseS` (**8 s**), or downed / carried / hooked / dead /
  escaped, or the hunter picks someone up (`reason: 'range'|'lost'|'carrying'|<state>|'switch'`).
* **One at a time**: a different survivor meeting the start rule takes over unless the current target meets it too; several new
  candidates in the same tick → the nearest. A carrying hunter starts no chase.
* **Bloodlust** [S]: chase seconds since the chase started / the last hit / the last pallet break → tiers at 15 / 25 / 35 s =
  +0.2 / +0.4 / +0.6 m/s on the hunter's normal movement (4.8 / 5.0 / 5.2 m/s; not while carrying or in a cooldown). Lost on a hit,
  a pallet break, or the chase ending (the report mentions a decay after the chase ends; modelled as an immediate reset [A]).
* Exposed as `hud[j].chased`, `self.chased` (survivors), `obs.chase = { target: id|null, bloodlust: 0..3 }` and `self.bloodlust`
  (hunter). Events `chaseStart {who}`, `chaseEnd {who, reason}`, `bloodlust {tier}` (on each increase).

Hunter knowledge: visible survivors in the 100° cone (incl. a `deepWound` presence flag, no timer), generator progress / `regressing` / *workers* only for gens it currently perceives (in the cone,
range and visibility via the same per-cell masks, or within `sight.adjacentReach`), otherwise its own last-seen values (initially progress 0,
not regressing; `done` is public, completions are announced; a kick leaves it adjacent, so it sees the regression it caused), `kicksLeft`
per gen (its own kick count vs the anti-tap limit), generators being repaired within `senses.repairNoiseRadius` (**20 m**, `noisyGens`, no identity/count), lever progress of gates in its
cone (or within 2 m), hooked survivors (stage/timer), pallet states, notifications (incl. `loudNoise` from
fast window vaults and rushed pallet vaults), grunts, scratch marks, who is dead/escaped. Not visible to the hunter: unhook protection,
Deep Wound timer, Resolve, intents.

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
{ seed, mapId, over, endReason: 'all-out'|'allDown'|'lastSurvivor'|'time',
  winner: 'hunter'|'survivors'|'draw',   // kills > escapes → hunter, escapes > kills → survivors
  kills, escapes, timeouts,              // timeouts = still alive at the 20-minute cap
  gensDone, hooks, durationS, ticks,
  survivors: [{ id, outcome: 'escaped'|'dead'|'timeout', cause, tOut, hooks, repairS, repairC, leverS }],
  stats: { hits, downs, hooks, pickups, stuns, palletsDropped, palletsBroken, vaults, wiggles, rescues, heals, fumbles, missed, drops, mends, intents },
  gens: [ids chosen], events: [{ t, type, … }], record? }
```
Event types: `start hit miss unstick pickup drop hook hookStage rescue resolveFull selfUnhook protect heal mend deepWoundDown palletDrop palletBreak dropped wiggle fumble genDone genKick genRegressStop gatesPowered gateOpen endgame loudNoise windowBlocked chaseStart chaseEnd bloodlust intent escape allDown lastSurvivor death end`
(`hit` with `endurance: true` = absorbed by unhook Endurance; `drop {who, wiggle}` = voluntary hunter drop; `dropped {who, state:'injured'}` =
pallet save; `mend {who, by}`; `gateOpen {gate, by: id|'hunter'}`; `endgame {cause: 'gate'}`; `escape {who, gate}`, plus `crawled: true` for a downed crawl-out; `unstick {who: id|'hunter'}`; `genKick {gen, progress, kicks}`;
`fumble` only if the legacy knob is enabled)
(`death.cause`: `bleedout | hookDeath | hook3 (stage 3 reached on hooking) | lastHook (last survivor hooked) | endgame | allDown | lastSurvivor`).

**Frames** (`record:true`): `{ t, h:[x,z,facing,carryingId|-1,status], s:[[x,z,facing,state,act,boost]×4], g:[gen progress 0..1], p:[pallet states] }`
(survivor act codes 0 none 1 repair 2 heal 3 rescue 4 dropPallet 5 openGate 6 wiggle 7 vault 8 mend 9 selfUnhook; hunter kicks show as status 5 interacting);
`record.meta.legend` documents the codes; `meta.gens`/`meta.pallets` give the id order. `p` is shared between frames while unchanged.

### Brain factory

`(ctx) => ({ decide(obs, api) { return action } })` — called every `decisionEvery` ticks (default 1); between calls the last
action repeats. Dead/escaped survivors are not asked. **Hooked survivors are asked with a minimal obs** (see Observations) — their only
meaningful actions are `act: 'selfUnhook'` (when offered) and `intent`. An exception in a brain propagates.

`ctx = { id, role: 'hunter'|'survivor', map, config, rng, spawn, nav, api }`

* `id`: survivors `0..3`; hunter `'hunter'`. `rng`: per-agent seeded stream (`next() int(n) range(a,b) chance(p) pick shuffle normal`).
* `map`: frozen static info — `size,w,h,eyeHeight,outline,obstacles,windows[{id,x,z,axis}],pallets[{id,x,z,axis,length,x0,z0,x1,z1,cx,cz}]`,
  `generators` (**only the 7 chosen** for this match, order = `obs.gens` order; each `{id, x, z, slots: [{side:'N'|'E'|'S'|'W', x, z}]}` = usable
  repair sides, see "Generators"; **hunter only** — survivors get an array of 7 `null`s and learn gens through `obs.gens`), `gensNeeded`, `hooks`, `exitGates[{id,lever,exit}]`, `spawns`.
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
  walk: bool,                // survivors: 2.26 m/s, no scratch marks, slow (quiet) vaults
  face: {x,z}?,              // POINT to look at (hunter vision cone / attack direction follows facing)
  look: {x,z}?,              // survivors: POINT the camera should look toward (see "Survivor camera"); absent = movement direction
  act: null | 'repair' | 'heal' | 'rescue' | 'mend' | 'dropPallet' | 'openGate' | 'wiggle' | 'selfUnhook'          // survivor
           | 'attack' | 'pickup' | 'hook' | 'drop' | 'breakPallet' | 'kickGen' | 'openGate',                           // hunter
  target: id?,               // gen id / pallet id / hook id / gate id (string) or survivor id (number); default = nearest valid
  intent: string? }          // survivors: a config.intent.messages enum, sent to teammates (see "Intent messages")
```
Interactions continue while the action is repeated each tick and the actor stays in range; **moving cancels** them (so give `moveTo`
*and* `act` together only if you want "walk, then do it when arrived" — the act starts as soon as the move command yields no step).
Progress resets if the act/target changes or a tick passes without it (except persistent progress stored on the object: generator
progress, gate lever progress (survivors), heal progress on the patient, mend progress on the patient, wiggle progress).

| act | who | range / time |
|---|---|---|
| `repair` | survivor | within `reach.repairSlot` (0.6 m) of a **free side slot** of the generator (one survivor per side; first come keeps it — a second survivor at an occupied slot gets nothing; max workers = usable sides, see "Generators"); 90 s solo; per-worker efficiency 1.0 / 0.85 / 0.7 / 0.55 for 1 / 2 / 3 / 4 workers. **No skill checks / fumbles** (the legacy random fumble is `gens.fumbleChancePerS`, default 0). On a kicked (regressing) gen, repairing pauses the regression but only **cancels** it after 4.5 charges (5 %) of real repair; stopping earlier resumes it and loses the partial cancel progress [A]. Nothing happens once the gates are powered (remaining gens blocked) |
| `heal` | survivor→other | 1.6 m centre-to-centre; 16 charges at 1/s per healer, progress persists on the target; injured→healthy, downed→injured (the bleed-out budget is **not** refilled); never self; not while the target has Deep Wound. **At most 2 healers** per patient (slot rule like gen sides; no cooperation penalty). **Patient participation**: no progress while the patient moves or performs any interaction of its own (as of its latest act) |
| `rescue` | survivor | within 1.8 m of the hook; 1 s; victim → injured + unhook protections (below) |
| `mend` | survivor | Deep Wound only. No target / own id: **self-mend 10 s**. `target: teammateId` (within 1.6 m): **altruistic mend 6 s**; at most **2 helpers**, each at **75 %** when two mend. Self + helpers add up. Progress (0..1) persists on the patient; clears Deep Wound; the patient's timer is paused while anyone mends them. Not conspicuous (keeps protections) |
| `dropPallet` | survivor | within 1.2 m of an *up* pallet; 0.3 s; hunter inside footprint ±1 m along axis → stunned 2 s (a carried survivor is released **injured**); pallet ends dropped either way |
| `openGate` | survivor | gates must be powered; within 1.5 m of the lever; 20 s; **one survivor per lever** (a second one gets nothing while it is occupied — worked this or the previous tick); progress persists on the gate when the opener lets go; the 2 gates are independent; escape by reaching `exit` (≤ 1 m) of an open gate — **downed survivors can crawl out too** |
| `wiggle` | carried survivor | 16 s of total wiggle progress → free **injured**, hunter stunned 1.5 s [A]. Progress persists across drops / re-pickups (reset by a hook, a new down, or a successful escape) |
| `selfUnhook` | hooked survivor | only when offered (`self.canSelfUnhook`: Resolve meter full, gates not powered); repeat for 1.5 s (hook timer paused; interrupted → resets) → normal unhook result |
| `attack` | hunter | 0.35 s windup (4 ticks), then hit if a healthy/injured survivor is within 2.2 m and ±45° of facing and visible; hit cooldown 2.7 s (speed 0.575), miss 1.5 s (speed 1.15). Allowed while carrying (no lunge; e.g. to clear a body block) |
| `pickup` | hunter | downed survivor within 1.5 m; 2 s (the survivor is locked in place meanwhile) |
| `hook` | hunter | carrying, within 1.5 m of a free hook; **1.5 s**. Hook stages (70 s each) are consumed — see Rules |
| `drop` | hunter | carrying; instant (`hunter.dropS` = 0 [A]); the survivor lands downed at the hunter's feet with **+25 % wiggle** progress |
| `openGate` | hunter | gates powered, the collapse **not** begun, within 1.5 m of the lever, not carrying; **0.75 s** (0.8 s in ticks); interrupted progress resets; opening starts the collapse |
| `breakPallet` | hunter | within 1.5 m of a dropped pallet; 2.34 s (2.4 s in whole ticks); removes Bloodlust |
| `kickGen` | hunter | not carrying; within 1.1 m of a gen with progress > 0, not done, not already regressing, gates not powered, **fewer than 8 kicks on that gen so far** (`gens.maxKicks`); 1.8 s → −5 % of the bar and the gen regresses at 0.25 charges/s until repair cancels it (above) or it reaches 0 |

Windows: entering a window cell along its axis triggers a vault (position locked); not possible along the other axis. Hunter 1.7 s.
Survivor tiers: **fast 0.5 s** = running with a straight run-up ≥ 2.5 m (continuous running distance whose heading stays within 25° of the
vault direction; reset on walking, stopping, being blocked, turning, vault end) — fast vaults are LOUD: the hunter gets
`{type:'loudNoise', cause:'vault', x, z, t}` (within `senses.loudNoiseRange`, default map-wide); **medium 0.9 s** = running with a shorter
run-up / angled approach / after bumping a wall; **slow 1.5 s** = walking (quiet, no scratch marks). **Dropped pallets** (survivors only; the
hunter is blocked): running = **fast 1.1 s, LOUD** (`loudNoise` cause `'palletVault'`), walking = **slow 2 s, quiet** [S]. Downed survivors
can't vault. Characters are circles r = 0.4 m that collide with each other (see "Collision").

### Observations

Survivor `obs`:
```js
{ t, tick,
  self: { id,x,z,vx,vz,facing,cam /* {x,z,yaw} camera, null if camera off */,state,hookCount,hookStage,hookStages,hookTimerS,boosted,vaulting,act,progress,
          bleedS /* remaining cumulative bleed-out budget while downed/carried, else null */, healProgress, wiggle,
          deepWoundS /* null if none */, mendProgress /* 0..1, null if no Deep Wound */,
          protectedS /* remaining Endurance+Haste, null if none */, elusiveS /* remaining Elusive, null if none */,
          chased /* chase music */, intentCooldownS },
  hunter: { x,z,vx,vz,facing,fx,fz,carrying,windup,cooldown,stunned,
            vaulting, vault: { window /* id */, fromX, fromZ, toX, toZ, progress /* 0..1 */ } | null } | null,   // only if visible now
  lastHunter: { x,z,vx,vz,facing,t } | null,
  terror: { layer: 1|2|3, approx } | null,   // heard terror-radius layer (thirds of 32 m, 1 = outermost), lagged; approx = band midpoint m
  teammates: [{ id,x,z,vx,vz,facing,state }],                                       // visible now
  lastSeen: [ {x,z,state,t} | null ×4 ],                                            // own memory, index = survivor id
  hud: [{ id, state, hookCount, hookStage, hookStages, beingHealed, activity, activityProgress, chased, resolve, deepWound } ×4],  // game HUD, no positions, no object ids
  downedAuras: [{ id,x,z }],                                                        // live positions of downed (not carried) teammates
  mateAuras: [{ id,x,z,state }] | null,                                             // only while YOU are downed: all teammates still in the match
  gens: [{ id|null,x|null,z|null,slots|null,known,progress(0..1),done,blocked,regressing|null,visible,workers:[ids]|null,slotsTaken:['N'|'E'|'S'|'W'…]|null,seenT }],   // order = ctx.map.generators; id/x/z/slots null until found
  gensDone, gensNeeded, pallets: ['up'|'dropped'|'broken'…],
  gates: [{ id, powered, open, progress? }],   // progress 0..1 only if the lever is perceived (always 1 when open)
  gatesPowered, endgame: { remainingS, slowed } | null,  // null until the first gate is OPENED; slowed = half speed (someone downed/carried/hooked)
  notifications: [all so far], newNotifications: [since last decide] }
```
Hooked survivor `obs` (minimal; the brain is called while hooked):
```js
{ t, tick,
  self: { id,x,z,state:'hooked',hookCount,hookStage,hookStages,hookTimerS,resolve,canSelfUnhook,selfUnhookS /* attempt progress | null */,selfUnhookNeedS,intentCooldownS },
  hud, gensDone, gensNeeded, gatesPowered, endgame, notifications, newNotifications }
```
Hunter `obs`:
```js
{ t, tick,
  self: { x,z,vx,vz,facing,fx,fz,carrying: id|null,cooldownS,windupS,stunS,vaulting,act,progress,bloodlust /*0..3*/,speed /*current normal move speed*/ },
  survivors: [{ id,x,z,vx,vz,facing,state,hookCount,vaulting,deepWound /*bool*/ }],     // in the 100° cone, range 75 m, visibility ≥ 0.5
  lastSeen: [ {x,z,state,t}|null ×4 ],
  grunts: [{x,z,t}],            // injured survivors within 10 m, ±2 m noise, no identity, kept 2 s (none while Elusive)
  scratches: [{x,z,t,dx,dz}],   // sprint marks of the last 10 s inside the cone (≤ 30 m, visible)
  gens: [{ id,x,z,progress,done,blocked,regressing,visible,workers:[ids]|null,seenT,kicksLeft }],   // progress/regressing = last perceived (see Hunter knowledge)
  gensDone, gensNeeded,
  noisyGens: [{ id,x,z }],      // gens with >= 1 worker within senses.repairNoiseRadius (20 m)
  hooked: [{ id,hookId,stage,timerS,hookCount }], status: ['alive'|'dead'|'escaped' ×4],
  chase: { target: id|null, bloodlust: 0..3 },   // engine chase state (see "Chase state")
  pallets: [...], gates /* progress only for levers in the cone */, gatesPowered, endgame, notifications, newNotifications }
```
Notification objects: `{type:'genDone', gen,x,z,t,gensDone}` (everyone), `{type:'gatesPowered', t}` (everyone), `{type:'gateOpen', gate, t}`
(everyone), `{type:'loudNoise', cause:'vault'|'palletVault', x,z,t}` (hunter only), `{type:'scream', kind,x,z,t}` (survivors, if enabled),
`{type:'intent', from, intent, t}` (survivors except the sender), HUD (survivors except the subject): `{type:'hooked', who,hookId,x,z,t}`,
`{type:'unhooked', who, by: id|'self', t}`, `{type:'died', who,t}`. (`{type:'fumble', gen,x,z,t}` to the hunter only if the legacy
fumble knob is turned on.)
Obs objects are freshly allocated every call and owned by the receiving brain.

## Rules summary / sight model

* 10 Hz; match cap 20 min; 7 of the map's generator candidates chosen per match (seeded), 5 needed → both exit gates powered and the
  remaining gens blocked. Powered-but-never-opened matches end at the 20-minute cap (`timeouts`).
* **Match-ending user rules** (checked once per tick, after all actions and timers, in this order):
  1. **All down**: if every survivor still in the match is downed / carried / hooked (nobody healthy or injured), the match ends at once
     as a hunter win: they all die (`cause: 'allDown'`, `endReason: 'allDown'`, event `allDown {who:[ids]}`). Escaped survivors stay escaped.
  2. **Last survivor**: if exactly one survivor is still in the match (escaped ones don't count) and the gates are **not** powered, the
     match ends at once as a hunter win: that survivor dies (`cause: 'lastSurvivor'`, `endReason: 'lastSurvivor'`, event `lastSurvivor`).
     With the gates already powered the last survivor plays on normally (gates / collapse). **There is no hatch** (dropped by design).
* **Endgame collapse** [S]: a 120 s budget that starts when the **first gate is opened** (by a survivor, or by the hunter: 0.75 s, only before
  the collapse); it runs at **half speed** while any survivor is downed / carried / hooked (no stacking; `endgame.slowed`). Survivors still in the
  game when it runs out die (`death.cause: 'endgame'`). Downed survivors can crawl out through an open gate.
* **Hook stages** [S]: 70 s per stage. Every hooking consumes one stage, and so does a stage timer running out (stage 1 → 2 "struggle"); reaching
  stage 3 kills. So: hook 1 = stage 1 → (70 s) stage 2 → (70 s) dead; rescued in stage 1 → next hook starts in stage 2; **rescued after reaching
  struggle on hook 1 → the next hook kills** (`hook3`). The last survivor in the match is sacrificed at once when hooked (`lastHook`; normally
  pre-empted by the all-down rule, since being carried is not standing). `hookCount` counts physical hookings; `hookStages` the consumed stages.
* **Downed** [S]: bleed-out is a **240 s budget cumulative across all downs** (paused while carried/hooked/standing; never refilled). While
  downed and stationary a survivor **recovers automatically at 0.5 charges/s up to 95 %** of the downed→injured heal (30.4 s); crawling pauses
  it; the last 5 % needs a teammate's heal. HUD activity `'recover'`.
* **Carry** [S]: wiggle escape and pallet saves release the survivor **injured**; wiggle progress persists across drops / re-pickups; a
  voluntary `drop` adds 25 % wiggle. A carrying hunter still collides with survivors (body-blocking the carrier).
* **Spawns**: `map.spawns.survivors` are anchor candidates: one is picked (seeded) and the 4 survivors are placed on distinct free
  positions within `spawn.groupRadius` (**12 m** [S] path distance from the anchor and pairwise, ≥ `spawn.minSep` = 3 m apart; other candidates near the anchor
  first, then random free cells). Hunter: `map.spawns.hunter` candidates whose path distance from the anchor is ≥ `spawn.hunterMinFrac`
  (0.8) × the farthest free cell ≥ `spawn.edgeInset` (4 m) inside the outline; seeded pick. If none qualifies (or there are none), that
  farthest inset cell is used — so maps with only central hunter candidates still spawn the hunter on the far side.
* **Unhook protections** (basekit 10.1.0, `config.unhook`) [S]: on any unhook (rescue or self-unhook): **10 s Endurance + 10 % Haste**
  (×1.10; the on-hit ×1.65 burst takes precedence, max of the two) **always**, plus **10 s Elusive** (no scratch marks, no grunts of pain)
  **only if the gates are not powered yet**. Elusive ends early on being hit (incl. an Endurance hit) or going down; Endurance is consumed by
  the absorbed hit; everything ends on a conspicuous action (repair, heal, rescue, openGate; mend and dropPallet are fine). Separate timers:
  `self.protectedS`, `self.elusiveS`. No aura/hunter reveal.
* **Deep Wound** [S]: an Endurance-absorbed downing hit → injured + 20 s Deep Wound; expiry downs. The timer **pauses while running** (incl. a
  rushed vault) **or being mended**. Self-mend 10 s, altruistic 6 s (2 helpers max, 75 % each when two); cannot be healed while it lasts.
  Teammates see the remaining fraction (`hud.deepWound`); the hunter sees only its presence on visible survivors.
* **Bloodlust** [S]: see "Chase state".
* Speeds m/s: survivor 4.0 (walk 2.26, crawl 0.7), on-hit sprint ×1.65 = **6.6 m/s for 1.8 s** [S], hunter 4.6 (+ Bloodlust 0.2/0.4/0.6;
  carrying 3.68, hit cooldown 0.575 × …, see config).
* **Sight**: tall obstacles (height ≥ eyeHeight) and cells outside the outline are opaque. Low obstacles, windows, pallets (up/dropped/broken) and
  generators are semi-transparent: each distinct one a ray crosses multiplies visibility by `sight.semiTransparency` (0.6; a multi-cell obstacle counts once;
  start/end cells excluded). **A target is "seen" iff in range (75 m), in the cone (hunter 100° from its body; survivors: the camera's 100° FOV from the camera position, see "Survivor camera") and visibility ≥ `sight.visThreshold` (0.5)** —
  deterministic, no RNG. So one semi-transparent obstacle is see-through, two are not. Dynamic sight (hunter↔survivors↔survivors) refreshes every
  `perceptionEvery` = 2 ticks; generators/pallets use per-cell cached visibility masks (from the cell centre), shared across matches.
* **Entity blocker** [S]: a survivor's 3rd vault of the same window **within the same chase** (while that survivor is the chase target) blocks
  that window for that survivor only, for 30 s; vaults outside a chase don't count and a new chase restarts the count (`obs.blockedWindows`).

## Survivor camera (`config.survivor.camera`)

Survivors play with a 3rd-person camera behind and slightly above them; what they perceive comes from the **camera**, not
the body. `camera.enabled: false` restores the old model (360° rays from the body; symmetric survivor-survivor sight).

* **Yaw**: each tick the camera turns toward the action's `look` point (if absent: the movement direction while moving,
  else it keeps its yaw) at most `turnRateDegS` (720°/s). It starts at the body's initial facing. The body's `facing` is
  unaffected (movement / `face`).
* **Position**: body − `backM` (2.75 m) along the look direction + `shoulderM` (0.5 m) to the right (`side` +1; −1 = left).
  The segment body → that point is marched in 0.1 m steps and the camera stops `wallMarginM` (0.3 m) short of the first opaque
  cell (tall obstacle / outside the outline) — it never passes through walls, it gets pushed in. Pushed in closer than
  `minM` (0.5 m) → the camera sits at the body. Low obstacles don't push it (it's above them).
* **Perception** (hunter, teammates, generators, pallets, gate levers): a target is perceived if it is inside the camera's
  horizontal FOV cone (`fovDeg` 100, centred on the yaw, apex at the camera), within range of the camera and visible from the
  camera (same semi-transparency rule; gens/pallets via the per-cell cached masks of the camera's cell) — **or** within
  `bodyAwareM` (2.5 m) of the body with line of sight from the body (360°, things touching you). Generator adjacency
  (`sight.adjacentReach`) and lever adjacency still count. Terror radius, HUD, notifications, auras are unchanged.
* So a survivor can **peek**: body behind a tall corner (out of the hunter's sight), camera past the corner looking at the
  hunter. The hunter's perception is unchanged: it sees survivor **bodies** (its 100° cone from its body).
* Obs: `self.cam = {x, z, yaw}` (null when the camera is off); `obs.hunter` / `teammates` = what the camera (or body
  awareness) perceives. Survivor-survivor sight is no longer symmetric.
* Cost: camera position + rays only on perception ticks (`perceptionEvery`, `staticPerceptionEvery`); the yaw update is O(1).

## Collision (`config.collision`, user rules)

Characters are circles of radius 0.4 m (contact at 0.8 m centre to centre). Survivors block survivors, and the hunter and survivors block
each other (body blocking; `collision.survivors`, `collision.hunterSurvivor`, both on). **Non-colliding** (with anyone): a survivor within
`survivor.noCollideAfterHitS` (2 s) of taking damage (any hit, incl. an Endurance hit); downed / carried / hooked / dead / escaped survivors;
anyone mid-vault. **A carrying hunter collides** (report §17: survivors can body-block the carrier; the carried survivor rides on it).

* Resolved in movement, after the static-grid test: a candidate position is blocked by a body if it overlaps it **and** is closer than before
  the move, so characters that already overlap (vault landing on someone, end of a no-collide window) can always separate. The usual
  axis-slide / shortened-step candidates apply; if a body is in the way the mover also tries to slide along the contact tangent (head-on:
  rotate the step +90°, so both parties of a head-on meeting sidestep to opposite sides and pass). Bodies never push each other.
* Order: survivors move in the rotating per-tick order, then the hunter, each against the others' current positions. Deterministic, ≤ 16 pair checks per tick.
* Nav is static (no dynamic avoidance in the planner). **Anti-deadlock**: a survivor pushing against another *survivor* without progress for
  `collision.unstickS` (2 s) stops colliding with survivors for `collision.unstickGhostS` (1 s) (event `unstick`; still collides with the
  hunter). That is what gets two survivors through a 1-cell corridor head-on.
* **Hunter AFK rule** [S: official 10 s; A: the rest]: a hunter that keeps trying to move while within 1.05 m of a colliding survivor body for
  `collision.hunterUnstickS` (10 s, continuous) stops colliding with survivors for `collision.hunterGhostS` (3 s [A]) (event `unstick {who:'hunter'}`).
* Limitations: no pushing; a survivor can be sidestepped against a wall corner when using raw `moveDir` (`moveTo` re-centres via the nav);
  vault landings don't check bodies (overlap resolves as above); a survivor body-blocking the hunter in a corridor holds until hit or the AFK rule.

## Generators: side slots

A generator is a solid 1×1 cell. Its **side slots** are the orthogonal neighbour cells (N = −z, E = +x, S = +z, W = −x) that are plain walkable
cells (not solid / window / pallet / outside); the slot point is that cell's centre. Each slot holds **one** repairing survivor: repair needs the
survivor within `reach.repairSlot` (0.6 m) of a slot point that nobody else repaired from this tick or the previous one (first come keeps it;
the next one gets nothing until it is free). Max workers = number of usable sides (≤ 4). Slots are static in `ctx.map.generators[i].slots`;
survivors see the busy sides (`gens[i].slotsTaken`) only for gens they perceive. The hunter kicks from any side within `reach.kickGen`.
All shipped maps: every candidate has 4 usable sides (`node scripts/check-gen-slots.js`). Brains can use `makeSlotPicker()` from `slotpick.js`.

## Anti-camp "Resolve" self-unhook (`config.antiCamp`)

A hooked survivor has a 0..1 meter, **visible to teammates** (`hud[j].resolve`, 9.3.0) and to the survivor itself; not to the hunter.
When it is full the survivor is **offered** a guaranteed self-unhook (`self.canSelfUnhook` in the hooked obs): it may take it with
`act: 'selfUnhook'` (repeated for 1.5 s, hook timer paused; interrupting resets the attempt) or ignore it (the meter stays full, the hook timer
keeps running). Normal unhook result (injured + unhook protections). Not available once the gates are powered. The baseline brains take it at once.
Events: `resolveFull`, then `selfUnhook`.

| part | source |
|---|---|
| fills only while the hunter is within **16 m** of the hook (20 m was the PTB value); closer = faster | sourced (live 9.3.0) |
| camping-time multiplier 1× for the first 10 s of camping, 2× for 10–20 s, 4× beyond; camping time accrues **only while the meter gains** | sourced |
| every hook event gives ALL hooked survivors a 7 s grace pause | sourced |
| other survivors nearby slow/stop it | sourced (the exact rule is assumed: any other non-hooked survivor within 8 m of the hook stops it) |
| full meter ⇒ the survivor may take a guaranteed 1.5 s self-unhook (a choice), either stage; disabled once the gates are powered (no fill, no offer) | sourced |
| faster the further the survivor is through the current hook stage | user (authoritative) |
| rate/s = (1 / `baseFullS`) × proximity × timeMult × (1 + 3·f²), f = elapsed fraction of the current stage | **assumed fill curve** (no verified live formula) |
| proximity 1 within 4 m, linear down to 0.25 at 16 m, 0 beyond | assumed |
| camping time resets after 5 s out of range | assumed |
| no fill while the hunter carries someone or sees a standing survivor within 16 m (in chase) | assumed (the report notes no verified live basis for this pause) |
| meter persists across the stage change within one hook; resets on a new hook and on unhook | assumed |
| `baseFullS` = 100 | assumed. Tuned to the user's 30–40 s face-camp target (still 36.7 s after the 16 m / fill-only-camp-time changes) |

Tuning check (gas-heaven, hunter standing still at the given distance from the hook from the moment of the hook,
stage length 70 s, teammates far away; time from the hook until the meter is full; a self-unhook taken at once ends 1.5 s later):

| hunter distance | 2 m | 6 m | 10 m | 14 m | 16 m |
|---|---|---|---|---|---|
| hooked at 0% of stage | 36.7 s | 38.7 s | 44.2 s | 54.9 s | 65.2 s |
| hooked at 50% of stage | 28.3 s | 29.3 s | 32.4 s | 51.0 s | 73.5 s |
| hooked at 75% of stage | 36.4 s | 39.2 s | 47.3 s | 61.7 s | 74.7 s |

(The 75% row is slower than the 50% row because the stage changes ~17 s in and f restarts at 0.) Tests cover face-camp 30–40 s,
kick-and-leave < 10%, the choice (ignored meter, interrupted attempt), camp time only while filling, the teammate freeze, the chase pause,
carrying, grace re-grant, gates powered, stage 2, persistence across the stage change, and HUD-only visibility.

## Determinism

Seeded: world rng (`'world'` stream: generator choice, spawns, grunt noise, legacy fumbles if enabled) + one stream per agent. Same `(map, seed, config, brains)` ⇒
identical result, events and frames — regardless of what ran before in the process (navigation caches never change routes or distances; tested cold vs warm).
Brains must not use `Math.random`/`Date.now` — use `ctx.rng`.

## Deviations / choices not in the brief

* Unused generator candidates stay as inert solid low blocks ("wrecks") so the nav grid is static and distance fields can be cached across matches.
* Timers elapse in whole ticks (rounded up): windup 0.35 s = 0.4 s, hunter gate opening 0.75 s = 0.8 s. Broken pallets stay semi-transparent for sight.
* Attack: the hunter keeps moving along its facing during the windup but plants as soon as a valid target is inside 0.9×range and the arc (no overshoot), so effective reach is
  larger than 2.2 m. Unspecified numbers chosen in `config.js`: `wiggleStunS 1.5`, `dropS 0`, `hunterGhostS 3`, `chase.runSpeed 3`, reach distances, `scratchEveryS 0.5`, `gruntIntervalS 1`.
* A dropped pallet that drops onto an actor pushes the actor to the nearer approach side.
* `face` is a point to look at, not a direction. Hunter grunts carry no survivor id.
* Re-vault behind the hunter: for `survivor.revaultNoFastS` (2 s, user rule) after the hunter finishes vaulting a window, survivors get at best a medium vault through it. Survivors are hittable for the whole vault until they land.
* Survivors cannot act while downed except crawling (and lying still recovers); a carried survivor can only `wiggle`; a hooked one only `selfUnhook` / `intent`.

## Research report implementation (`docs/research/missing-mechanics.md`, user-reviewed)

Implemented (report § numbers): §1 hook-stage accounting · §2 Bloodlust + chase rules · §3 downed recovery, cumulative bleed-out, dying
survivors' teammate auras · §4 anti-tap (8 kicks, 5 % to cancel regression) · §6 carry escapes injured, persistent wiggle, voluntary drop ·
§7 Deep Wound running pause + altruistic mending · §8 solo-queue HUD (activity + progress, no object identity; Resolve; intent messages) ·
§9 (partial) on-hit sprint 6.6 m/s · §10 collapse (half speed while incapacitated, hunter gate opening, crawl-out) · §11 Resolve 16 m /
fill-only camp time / choice / disabled when powered · §12 split 10.1.0 protections · §14 repair noise 20 m · §15 pallet vault tiers ·
§17 carrying hunter collides (+ official 10 s AFK collision loss) · §27 window blocker per chase · §31 spawn cluster 12 m · §32 two healers +
patient participation · §33 hook 1.5 s.

**Sourced vs assumed**: config comments mark each number `[S]` (report / official notes / wiki) or `[A]` (our choice). Main assumptions:
chase `runSpeed` 3 m/s and the Bloodlust reset at chase end (the report mentions a decay); anti-tap partial-cancel reset on interruption;
intent cooldown escalation details and the default 8-word vocabulary (pre-release screenshot); Resolve fill curve, proximity, mate/chase
pauses; wiggle stun 1.5 s; voluntary drop instant; hunter AFK ghost duration 3 s and the 1.05 m "contact" band; mend self+helpers additive.

**Changed by user decision (override the report)**: §5 **hatch removed by design** — instead the *last-survivor* rule (one survivor left
before the gates are powered = hunter win); plus the *all-down* rule (no survivor standing = hunter win). Collapse is triggered only by a
gate opening.

**Deferred / not implemented** (by request): skill checks of any kind (§13; the legacy random repair fumble is off by default and no
longer part of obs expectations), quick-vs-lunge attack phases / swept hit volume (§9), generator sound / progress-band perception (§14
beyond the 20 m radius), §13, interrupt grabs (§16), sound channels (§18), red stain (§19), scratch-mark patches (§20), blood pools (§21),
crouching (§22), lockers (§23), breakable walls (§24), hook breaking / basement (§25), struggle checks / 4 % attempts (§26), gate
lights / escape geometry (§28), crows (§29), camera model (§30), finisher mori / surrender (§34), totems (§35), height / falls (§36),
loadout items L1–L7 (med-kits, toolboxes, flashlights, fog vials, chests, keys, maps), carry sway.

## Performance (gas-heaven 112×96, baseline brains, one core)

~145–155k ticks/s ≈ **24 matches/s** (matches average ~6000 ticks ≈ 10 game-minutes); `decisionEvery: 2` ≈ 31/s; `decisionEvery: 3, sight.perceptionEvery: 3` ≈ 35/s.
Matches are independent and share only read-only data, so run one process/worker per core for hill-climbing. Brain cost is on top: calls to
`nav.dist`/`nextWaypoint` for non-feature targets and large obs scans dominate; prefer feature targets and Euclid for moving ones.

## Genre-alignment pass (2026-11-15)

Numbers checked against the community wiki (deadbydaylight.wiki.gg): walk 2.26, carry 3.68, lunge 1.5× (≈6.9 m/s),
hit/miss cooldown speeds 0.575 / 1.15, on-hit boost 1.8 s, generators 90 s, pallet break 2.34 s, scratch marks fade after 10 s.
Window vaults: fast 0.5 s (straight 2.5 m run-up, loud) / medium 0.9 s / slow 1.5 s (walking). Entity blocker: a survivor's 3rd vault of
the same window within 60 s (superseded 2026-11-16: within the same chase) blocks that window for **that survivor only** for 30 s (`obs.blockedWindows` lists the ones
blocked for you). Swings only connect if no solid cell (wall, low wall, generator) is between hunter and target —
windows and pallets can be hit across.
