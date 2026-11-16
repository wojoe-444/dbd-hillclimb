# Missing and mismodelled base-game mechanics

Research date: **2026-11-16**. Scope: ordinary **1 killer / 4 survivor** trials, without perks, killer powers, add-ons, offerings, or event rules. This is a review backlog, not an implementation specification or authorization to implement.

## Baseline and evidence

Read `src/sim/README.md`, all of `src/sim/config.js`, and `docs/MAP_FORMAT.md`; spot-checked `src/sim/match.js` to distinguish documentation drift from actual behavior. The working tree is changing concurrently, so implementation references use symbols/areas rather than line numbers. **Character collision with a roughly 2-second post-hit exception, four wall-aware generator work sides, and visible-only killer generator-progress knowledge are already planned and are not proposed again.**

Already present: repair cooperation penalties; basic health, altruistic healing, hooks/carrying/wiggle; pallets/windows and window blocking; partial sensory information, scratch marks and injured grunts; chase flags; Resolve; unhook Haste/Endurance/partial Elusive; Deep Wound; two gates and a basic collapse timer. Configuration is more reliable than several older README tables.

Latest live release located: [10.2.2, 2026-10-20](https://forums.bhvr.com/dead-by-daylight/kb/articles/562-10-2-2-bugfix-patch). [10.3.0 was still a PTB with live date TBA](https://deadbydaylight.wiki.gg/wiki/Patch_Notes_10.3.X); its changes are **not** counted as live mechanics. Official live patch notes take precedence over PTBs and older guides. Some wiki.gg direct page fetches returned HTTP 403; their searchable indexed passages were used and cross-checked against official notes where available. Thus exact unpublished geometry, sound thresholds, and some animation details remain explicitly uncertain.

Confidence: **high** = clear current wiki rule and/or official live notes; **medium** = credible description but exact current parameters or 2D translation need verification; **low** = not established well enough to copy. Relevance gives **2D / match meta**, in that order. Ordering is an engineering judgment about likely outcome impact, not a measured effect size. Item-dependent candidates have their own ranked section.

## Core candidates, ordered by expected outcome impact

### 1. Hook-stage accounting and hook duration

**Summary:** Track consumed hook stages, not just the number of physical hookings.

- **Rule/numbers:** Each stage lasts **70 seconds**, increased from 60 in **8.2.0 (2024-08-27)**. A survivor rescued after reaching struggle on their first hooking dies on their next hooking. The last remaining survivor is sacrificed immediately when hooked.
- **Gap:** `hooks.stageS` is 60; `_hookSurvivor` selects stages from `hookCount`, and a timed stage transition does not consume a stage. This grants some survivors an entire extra rescue cycle.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Separate accumulated stages from physical hook count in `match.js`; advance stages on timer expiry and on hooking, and use that state for HUD/death checks. Add last-survivor hook resolution. Sources: [Hooks](https://deadbydaylight.wiki.gg/wiki/Hooks), [official 8.2.0 live notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/468-8-2-0-castlevania).

### 2. Bloodlust and its chase prerequisites

**Summary:** Prolonged chases make the ordinary killer faster, preventing many indefinite loops.

- **Rule/numbers:** At **15 / 25 / 35 seconds** of chase, grant **+0.2 / +0.4 / +0.6 m/s**; a 4.6 m/s killer reaches **4.8 / 5.0 / 5.2 m/s**. Hitting a survivor or breaking a pallet removes it. Chase initiation requires a running survivor in view within **12 m**, with the killer walking. The wiki lists loss conditions including distance above **18 m** and LOS loss above **8 seconds**, and subsequent Bloodlust decay; these deserve live calibration rather than copying the sim's assumed chase rules.
- **Scope/confidence/relevance:** Base game **yes**, no perk needed; **high** for tiers, **medium** for precise chase transitions; **high / high**.
- **Sketch:** Add chase charge/tier state to `match.js` and speed calculation in the hunter movement path, with configuration in `config.js`. Correct `_updateChase` before letting Bloodlust depend on it. Sources: [Bloodlust](https://deadbydaylight.wiki.gg/wiki/Bloodlust), [6.1 patch history](https://deadbydaylight.wiki.gg/wiki/Patch_6.1.0).

### 3. Downed recovery and cumulative bleed-out

**Summary:** Slugged survivors can prepare a near-instant teammate pickup, while repeated downs share a finite life budget.

- **Rule/numbers:** Stationary dying survivors automatically recover at **0.5 healing charges/s**, reaching **95% in 30.4 seconds**; crawling pauses this. The final 5% needs help without an enabling perk. Bleed-out is **240 seconds cumulative across downs**, not a fresh 240 seconds on every down. Dying survivors see their teammates' auras as well as being visible to them.
- **Gap:** Downed actors only crawl; `_downSurvivor` resets `bleedT`; `heal` always starts from whatever the engine's separate heal progress contains. The downed observer lacks the reciprocal teammate auras.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Reuse patient healing charges for automatic recovery in `_worldTimers`, with a 95% cap; keep a lifetime remaining bleed budget and pause it appropriately while carried/hooked. Extend `_survivorObs`. Automatic recovery became base behavior in **9.2.0 (2025-09-23)**. Sources: [Health States](https://deadbydaylight.wiki.gg/wiki/Health_States), [9.2 live notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/523-9-2-0-sinister-grace).

### 4. Generator anti-three-gen and anti-tap rules

**Summary:** Limit repeated kicks and require meaningful repair to cancel regression.

- **Rule/numbers:** Maximum **8 killer-caused regression events per generator**; qualifying events remove at least **2.5%** instantly. Skill-check failures do not consume this allowance. A kick removes **5%**; canceling regression requires **5% actual repair progress = 4.5 charges**, with passive regression paused while repairing and resumed on an early interruption. Current kick duration **1.8 s** and passive rate **0.25 charges/s** are already correct.
- **Gap:** Unlimited kicks and permanent regression cancellation after any repair tick permit strategies the live rules deliberately prevent.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Add kick-event count and regression-cancellation progress to each gen in `match.js`; gate `kickGen` and expose only permitted indicators. Introduced in **7.5.0 (2024-01-30)**. Source: [official 7.5.0 live notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/430-7-5-0-alan-wake).

### 5. Real hatch instead of automatic gate power

**Summary:** The final survivor gets a hidden spatial escape objective before a gate duel.

- **Rule/numbers:** Hatch appears and opens when **one survivor remains**, regardless of completed gens. The killer can close it; closing powers gates and starts collapse. No hatch grab. A closed hatch requires a suitable key to reopen (**2.5 s**, progress persists). Earlier rules allowing hatch to appear with multiple survivors are obsolete since **5.3.0 (2021-10-19)**.
- **Gap:** `_afterOut` immediately powers gates for the final survivor, omitting the hatch search, hatch sound, closing decision, and its immediate collapse trigger.
- **Scope/confidence/relevance:** Base game **yes**; reopening is **loadout-item dependent**; **high**; **high / high**.
- **Sketch:** Add seeded hatch spawn candidates in the map schema/`mapdata.js`, hatch state and actions in `match.js`, and local sight/audio observations. Replace the stand-in without revealing the random hatch location to brains. Sources: [Hatch](https://deadbydaylight.wiki.gg/wiki/Hatch), [Exit Gates](https://deadbydaylight.wiki.gg/wiki/Exit_Gates).

### 6. Carry escapes, saves, and voluntary dropping

**Summary:** A successful wiggle or pallet rescue returns a survivor to injured, able to run.

- **Rule/numbers:** Wiggle requires **16 charges / 16 seconds** of successful participation. Good/great checks change sway to **50% / 120%** of default, not escape speed; failure pauses progress. Voluntary drops add **25% wiggle**, with progress retained through drops/re-pickups. Pallet and flashlight saves release the survivor injured. Ordinary drop and successful escape are different outcomes.
- **Gap:** `_wiggleFree` and a carried survivor released by `_stunHunter` become **downed**; pickup resets wiggle. There is no voluntary `drop` action or sway. The configured **1.5 s wiggle stun** is an assumption; I could not establish a reliable current exact stun duration and would not substitute a perk stun value. Wiggling stuns the killer; it does **not** inherently blind them.
- **Scope/confidence/relevance:** Base game **yes**; flashlight rescue requires an item; **high** for health/progress rules, **low** for the exact wiggle-stun duration; **high / high**.
- **Sketch:** Centralize carry-release outcomes in `match.js`; preserve wiggle between pickups, add voluntary drop/penalty and a bounded sway model. Keep distinct pickup, drop, escape, and hook animation states. Sources: [Wiggle](https://deadbydaylight.wiki.gg/wiki/Wiggle), [Pallets](https://deadbydaylight.wiki.gg/wiki/Pallets), [official wiggle developer explanation](https://store.steampowered.com/news/posts/?appids=381210%5Cu0026appgroupname%3DDead+by+Daylight%5Cu0026enddate%3D1464651414&enddate=1678204556).

### 7. Deep Wound running pause and altruistic mending

**Summary:** Running away after an Endurance hit must not automatically exhaust Deep Wound.

- **Rule/numbers:** **20 s** timer pauses while **running or mending**. Self-mend **10 s**, altruistic mend **6 s**; up to two helpers, with **25% individual efficiency penalty** when two mend. Mending progress persists. The times changed from **12 / 8 s** in **8.6.0 (2025-04-02 live; 2025-03-11 PTB)**. It leaves the survivor injured and is generally not a healing action.
- **Gap:** Our timer pauses only on `mend`, self-mend is 12 s, teammates cannot mend, and Deep Wound is hidden from the HUD. Teammates can see remaining timer progress; the killer sees its presence, not exact depletion.
- **Scope/confidence/relevance:** Base game **yes**, because unhook Endurance can cause it; **high**; **high / high**.
- **Sketch:** Modify `_worldTimers`, allow a self/other mend target in `_survivorAct`, and add asymmetric HUD fields. Preserve the distinction between mending and conspicuous healing. Sources: [Deep Wound](https://deadbydaylight.wiki.gg/wiki/Deep_Wound), [official 8.6.0 live mending changes](https://forums.bhvr.com/dead-by-daylight/kb/articles/498-8-6-0-tokyo-ghoul), [Health States: mending](https://deadbydaylight.wiki.gg/wiki/Downed).

### 8. Solo-queue information: progress without generator identity, plus intent messages

**Summary:** Match the information solo players actually receive instead of exchanging an unintended location signal.

- **Rule/numbers:** Activity HUD shows interaction type and progress circles, including repair/recovery and, since **8.4.0**, other supported interactions. It does not label a teammate's specific generator. Resolve is teammate-visible since **9.3.0**. **10.2.0 (2026-10-06)** added predefined survivor intent messages: a wheel of **8 selections**, with anti-spam cooldown starting at **1 s**, rising to **5 s**.
- **Gap:** `hud.repairing = genId` reveals exact location through the known map, while actual HUD repair progress and Resolve progress are omitted. A categorical no-communication convention now excludes a live solo-queue feature.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Change `_buildHud`/observation serialization to activity + progress without target IDs; add bounded engine-delivered intent enums, never arbitrary text/coordinates/shared memory. The exact live message vocabulary still needs enumeration before implementation. Sources: [Status HUD](https://deadbydaylight.wiki.gg/wiki/Status_HUD), [official 10.2.0 live notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/560-10-2-0-mid-chapter), [official Resolve HUD change](https://support.deadbydaylight.com/hc/en-us/articles/43679054706708-9-3-0-Mid-Chapter).

### 9. Basic attack choices, hit burst, and swept hit geometry

**Summary:** A single fixed windup and endpoint range check are a consequential chase approximation.

- **Rule/numbers:** Distinguish quick attacks and held lunges. The wiki's code-analysis discussion describes an opening phase up to **0.5 s**, a **0.3 s** hitting phase, and a speed ramp reaching **1.5×** killer base speed. Successful-hit cooldown **2.7 s** and miss cooldown **1.5 s** match the sim. Current movement tables list the survivor on-hit sprint at **6.6 m/s for 1.8 s**, whereas the sim grants **6.0 m/s**; treat the magnitude as a verification target, not an unquestioned correction.
- **Scope/confidence/relevance:** Base game **yes**; **medium** for detailed attack curves and burst magnitude, **high** for cooldown durations; **high / high**.
- **Sketch:** Add quick/lunge intent and phase-based attack state in `match.js`; sweep a small hit volume through the hitting phase instead of a single 2.2 m/90-degree endpoint fan. Retain solid-wall rejection but do not require the body to satisfy ordinary visual detection in order for a physically intersecting attack to connect. Sources: [Attacks code discussion](https://deadbydaylight.wiki.gg/wiki/Talk:Attacks), [movement tables](https://deadbydaylight.wiki.gg/wiki/Movement_Speeds), [6.1 notes](https://deadbydaylight.wiki.gg/wiki/Patch_6.1.0).

### 10. Endgame collapse, killer gate opening, and crawling escapes

**Summary:** Endgame rescue timing and escape eligibility differ materially from the current timer model.

- **Rule/numbers:** Collapse is a **120 s** budget triggered by opening a gate **or closing hatch**. It runs at **half speed** while any survivor is dying or hooked, so it can last **240 s**; slowdowns do not stack. The killer may open a powered gate in **0.75 s** if collapse has not begun, with interrupted killer opening reset. Dying survivors can crawl out through gates or hatch.
- **Gap:** Fixed-speed collapse; no killer `openGate`; `_tryEscape` rejects downed survivors. The game's normal endgame clock is not equivalent to the engine's separate 20-minute research cap.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Extend world timers, gate actions and exit-state checks in `match.js`. Count incapacitation once per tick and keep the global collapse bar public. Sources: [Endgame Collapse](https://deadbydaylight.wiki.gg/wiki/Endgame_Collapse), [Exit Gates](https://deadbydaylight.wiki.gg/wiki/Exit_Gates), [Health States](https://deadbydaylight.wiki.gg/wiki/Health_States).

### 11. Resolve range, timing, and player choice

**Summary:** Our deliberately tuned anti-camp model should not be presented as exact live Resolve.

- **Rule/numbers:** Live anti-facecamp range is **16 m**, not the **20 m PTB** value. The **7 s** grace and **1× / 2× / 4×** camping multipliers at **0–10 / 10–20 / >20 s** are sourced. Camping time accumulates **only while the meter gains progress**, not merely while the killer is inside the radius. Full meter permits a guaranteed self-unhook; it does not force the player to take it. Disabled when gates are powered.
- **Gap:** The radius, accumulation during grace/pauses, automatic self-unhook, hidden teammate bar, and assumed proximity/stage curves alter rescue/camp incentives. No verified live formula supports the engine's `1 + 3*f*f` stage multiplier or blanket visible-survivor chase pause.
- **Scope/confidence/relevance:** Base game **yes**; **high** for official rules, **low** for exact replacement fill curve; **high / high**.
- **Sketch:** Correct supported predicates in `_antiCamp`, expose the HUD bar, and let hooked brains choose the enabled action. Keep unknown fill parameters labelled approximations until measured. Source: [official 9.3.0 live notes, including PTB reversions](https://support.deadbydaylight.com/hc/en-us/articles/43679054706708-9-3-0-Mid-Chapter).

### 12. Current unhook protections and Elusive lifecycle

**Summary:** Ten-second protections are currently right; stealth is applied in the wrong endgame/hit situations.

- **Rule/numbers:** **10.1.0 (2026-08-25)** changed protections to **10 s Endurance + 10% Haste**, adding **10 s Elusive only before generators are powered**. Thus reverting the sim to 15 s based on 9.3.0 would be wrong today. Elusive suppresses grunts, scratch marks, blood pools and aura reading; it ends on taking a basic/special attack or entering dying. It is not a blanket guarantee of silent footsteps.
- **Gap:** One `protT` controls everything, including stealth after an Endurance hit and after gates power. Missing blood/aura systems will need the full effect later. Conspicuous-action handling must include cleansing, sabotage and any new healing action when those are added.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / high**.
- **Sketch:** Split stealth from Haste/Endurance state in `match.js`; clear stealth on hit and omit it on endgame unhooks. Keep each effect's cancellation rules explicit. Sources: [official 10.1.0 live notes](https://forums.bhvr.com/dead-by-daylight/kb/articles/556-10-1-0-chorus-of-sin), [Elusive](https://deadbydaylight.wiki.gg/wiki/Status_HUD/Elusive), [Conspicuous Actions](https://deadbydaylight.wiki.gg/wiki/Conspicuous_Actions).

### 13. Repair/heal skill checks rather than undifferentiated fumbles

**Summary:** Separate opportunities, player performance and outcomes; repair failures also halt all repair on that gen.

| Interaction | Opportunity chance per second | Great result | Failure |
|---|---:|---:|---|
| Bare-hand repair | 8% | +1% total generator progress | −10% total progress; loud notification; 3 s repair lockout |
| Altruistic healing | 15% | +3% health-state progress | −10% progress; 3 s interruption; audible failure |
| Med-kit self-heal, if items enabled | 12.5% | +3% | −10%; 3 s interruption |
| Toolbox repair, if items enabled | 40% | +1% | repair failure behavior |

- **Rule/numbers:** Good checks continue normal progress without the great bonus. Repair checks have **1.1 s** pointer rotation; healing **1.2 s**. Base good/great success-zone lengths are **13% / 3%** for repair and **15% / 3%** for healing. **8.7.0 (2025-05-06)** added protection around checks triggered just as an interaction is interrupted; do not blindly apply historical let-go failures in that protected interval.
- **Gap:** `fumbleChancePerS = 0.01` is an unconditional failure model; there are no good/great results, healing checks or failure lockout. One percent is not directly comparable to an 8% check-opportunity probability.
- **Scope/confidence/relevance:** Base game **yes**; **high**, **medium** for exact interrupt-protection window; **high / medium-high**.
- **Sketch:** Add seeded check opportunities with a separately configurable bot timing/success model in `match.js`/`config.js`; use real decisions only if timing skill is part of the experiment. Apply gen-wide failure lockout and cap bonus progress at completion. Source: [Skill Checks](https://deadbydaylight.wiki.gg/wiki/Skill_Checks).

### 14. Generator sound, coarse visual progress and aura limits

**Summary:** Perception should distinguish locations, local work sounds and approximate progress.

- **Rule/numbers:** Unfinished generator locations are ordinarily aura-visible to the killer; that aura is not a universal progress or worker-count detector. Nearby piston activity and operating sounds convey progress even when nobody is repairing; regression sparks identify damage state. The wiki gives **20 m** as the default audible repair-noise range, versus our **10 m**.
- **Gap:** Planned visible-only progress knowledge is good, but current audible information only reports active workers; it misses unattended machinery. Exact numeric progress on every visible gen is also more precise than human piston/audio estimates.
- **Scope/confidence/relevance:** Base game **yes**; **high** for cue existence, **medium** for faithful attenuation/progress quantization; **high / medium-high**.
- **Sketch:** Extend gen perception in `match.js`, keeping global aura locations separate from local progress bands and worker sounds. Do not add perk-like repaired-gen aura tracking. Sources: [Generators](https://deadbydaylight.wiki.gg/wiki/Generators), [default repair sound range](https://deadbydaylight.wiki.gg/wiki/Surveillance), [Auras](https://deadbydaylight.wiki.gg/wiki/Auras).

### 15. Fast/slow pallet vaults and stun timing

**Summary:** Pallet use offers a noise/speed choice, and saves depend on when and where the stun connects.

- **Rule/numbers:** Pallet fast vault **1.1 s**, loud; slow vault **2 s**, quiet. Our one **1.2 s** tier misses both. Base pallet stun **2 s** and break **2.34 s** are correct. Stun is checked about **halfway through the falling pallet**, and same-side killer/survivor positioning does not qualify in the same way as crossing the drop zone.
- **Scope/confidence/relevance:** Base game **yes**; **high** for times, **medium** for geometric translation; **high / medium-high**.
- **Sketch:** Use movement intent to choose vault tier in `_startVault`; emit rushed-pallet noise. Move stun testing to an explicit fall-animation phase and side-aware swept footprint; do not treat the current ±1 m rectangle as verified game geometry. Source: [Pallets](https://deadbydaylight.wiki.gg/wiki/Pallets).

### 16. Interaction interrupts / grabs

**Summary:** An inattentive survivor can be lifted directly onto the killer's shoulder without two hits.

- **Rule/numbers:** Close rear grabs apply to various interactions, including generators, exit switches, chests and lockers; injured survivors can be grabbed during eligible window/pallet vaults. **Unhook grabs were removed in 7.1.0 (2023-07-25)**. Do not reinstate them as part of a generic grab system.
- **Scope/confidence/relevance:** Base game **yes**; **high** for eligible families, **medium** for exact prompt/angle and animation thresholds; **high / medium-high**.
- **Sketch:** Add `grab` eligibility before ordinary quick-attack damage in `match.js`; convert to carried using a timed animation and existing carry state. Use explicit per-interaction and health predicates. Sources: [Interrupt](https://deadbydaylight.wiki.gg/wiki/Interrupt), [Hooks history](https://deadbydaylight.wiki.gg/wiki/Hooks).

### 17. Collision exceptions beyond the already planned bodies

**Summary:** Carrying should not globally disable body blocking; post-hit ghosting is a temporary exception.

- **Rule/numbers:** Survivors can body-block a carrying killer, who may hit them to clear a path. The currently read configuration excludes **all carrying hunters** from body collision, removing that strategic possibility. The planned roughly **2 s** post-hit no-collision is accepted here; its exact live duration is not independently certified. Current AFK rules also have a **10 s** collision-loss escape from prolonged blocking.
- **Scope/confidence/relevance:** Base game **yes**; **medium** for general carry collision, **high** for the official AFK exception; **high / medium-high**.
- **Sketch:** Review only the carry exemption and interaction/vault transitions in `_survBody`/body collision helpers. Avoid layering an arbitrary two-second teammate anti-deadlock ghost over live collision and calling it an exact base mechanic. Sources: [official AFK collision rule](https://forums.bhvr.com/dead-by-daylight/kb/articles/510-9-0-0-five-nights-at-freddys), [community carry/bodyblock example](https://www.reddit.com/r/deadbydaylight/comments/1tz40on/hit_while_carry_survival_as_killer/). Exact live collision timing and unhook-body behavior remain measurement items.

### 18. Sound channels for both roles

**Summary:** Healthy survivors, downed survivors and nearby killers should not be acoustically nonexistent.

- **Rule/numbers:** Base audio includes breathing, footsteps by gait/surface, injured and dying vocalizations, healing/mending, vault/locker doors, screams, killer movement/attacks and machinery. These do not all share one fixed hearing radius or require sight. Character voices differ; there is no reliable universal metre value established here.
- **Gap:** The sim emits jittered injured grunts at 1 s intervals within 10 m, no dying grunts/healthy breathing/footsteps, and survivor scream hearing is disabled. Terror radius alone does not capture close killer footsteps.
- **Scope/confidence/relevance:** Base game **yes**; **high** for existence, **low** for exact audibility curves; **high / medium-high**.
- **Sketch:** Add cheap seeded categorical sound events in `match.js` with distance/occlusion attenuation in `sight.js` or a small audio helper. Report bearing/range uncertainty, not exact source coordinates and identities for every sound. Sources: [killer tracking tutorial](https://deadbydaylight.wiki.gg/wiki/Playing_Killer:_Tips_and_Tricks), [Lockers](https://deadbydaylight.wiki.gg/wiki/Lockers), [official audio fixes confirming surface-dependent footsteps](https://forums.bhvr.com/dead-by-daylight/kb/articles/544-9-6-0-patch-notes).

### 19. Red stain and deliberate facing deception

**Summary:** Survivors can see where a killer is looking around a corner before seeing their body.

- **Rule/numbers:** The ordinary killer emits a forward red glow; moving backward/sideways can hide or misdirect it. It is separate from terror radius and is normally always present in this power/perk-free ruleset. No trustworthy universal size is established here.
- **Scope/confidence/relevance:** Base game **yes**; **high** for behavior, **low** for footprint size; **high / medium-high**.
- **Sketch:** Cast a short forward visible footprint in survivor perception in `match.js`/`sight.js`, intersecting illuminated ground rather than exposing the killer position through walls. Existing independent `face`/movement actions can support moonwalk mind games. Source: [Red Stain](https://deadbydaylight.wiki.gg/wiki/Red_Stain).

### 20. Scratch-mark uncertainty and generation

**Summary:** Tracks should be patches, not exact movement vectors stamped with exact creation times.

- **Rule/numbers:** Created with sprint input at at least **60%** of default movement speed; persist **10 s**: **1 s** brighten, **8 s** full, **1 s** fade. Spawn in chunks on nearby ground/walls/objects. Not generated by ordinary walking, crouching or crawling.
- **Gap:** Marks appear as regularly spaced centerline points every **0.5 s**, immediately readable, with exact `{t, dx, dz}` in observations. That overstates track direction/age and understates wall-visible tracks. Do not confuse a brightness ramp with an absolute one-second invisible delay.
- **Scope/confidence/relevance:** Base game **yes**; **high** for broad behavior/timing, **medium** for patch distribution; **high / medium**.
- **Sketch:** Change mark emission/perception in `match.js`; keep timestamps internal for lifetime, expose brightness/age bands and noisy patch geometry. Seed placement to preserve determinism. Sources: [Scratch Marks](https://deadbydaylight.wiki.gg/wiki/Scratch_Marks), [community tracking guide](https://eip.gg/dbd/guides/how-to-find-hiding-survivors/).

### 21. Blood pools

**Summary:** Injured survivors remain trackable while walking or crouching.

- **Rule/numbers:** Blood pools are visible world traces from injured survivors, readable by killer and survivors. Exact default interval and lifetime were not established confidently; do not adopt a remembered 10/20/90-second number. Bleeding does **not** itself drain the injured health state or create a bleed-out clock.
- **Scope/confidence/relevance:** Base game **yes**; **high** for behavior, **low** for numerical cadence/lifetime; **high / medium**.
- **Sketch:** Add a separate short-lived trace array in `match.js`, sight-filter it, and suppress it under Elusive. Keep it independent from scratches and the dying-state bleed budget. Source: [Pools of Blood](https://deadbydaylight.wiki.gg/wiki/Pools_of_Blood).

### 22. Crouching and low-cover posture

**Summary:** Walking is not the only quiet movement mode.

- **Rule/numbers:** Crouch speed **1.13 m/s**, walk **2.26 m/s**, run **4 m/s**. Crouching leaves no scratch marks and can avoid ordinary nearby crow triggers; it changes silhouette/visibility behind low cover. It does not heal or grant universal silence.
- **Scope/confidence/relevance:** Base game **yes**; **high** for movement, **medium** for 2D concealment; **high / medium**.
- **Sketch:** Add `crouch` to actions, speed selection and posture-specific eye/body visibility in `match.js`/`sight.js`; use obstacle heights already in the map rather than making crouch universally invisible. Sources: [Movement Speeds](https://deadbydaylight.wiki.gg/wiki/Movement_Speeds), [Crows](https://deadbydaylight.wiki.gg/wiki/Crows).

### 23. Lockers

**Summary:** Risky hiding creates a search-versus-pursuit decision and direct captures.

- **Rule/numbers:** One survivor per locker. Rushed entry/exit creates a loud notification; slow use is quieter but audible. Breathing/grunts are muffled, not eliminated. Empty search **2.333 s**, occupied search/capture **5 s**. Lockers block ordinary body sight/aura reading and also constrain the occupant's information; no aura-shared omniscience from inside.
- **Scope/confidence/relevance:** Base game **yes**; reloads/teleports/Head On are **excluded power/perk behaviors**; **high** for these rules, **medium** for exact entry/exit durations not established here; **high / medium**.
- **Sketch:** Extend map schema and `mapdata.js` with locker solids/interaction points; add occupancy and enter/exit/search states in `match.js`. Let AFK crows reveal an occupied locker. Source: [Lockers](https://deadbydaylight.wiki.gg/wiki/Lockers).

### 24. Breakable walls

**Summary:** The killer can pay time to permanently change routes and loop strength.

- **Rule/numbers:** Ordinary killer wall break **2.34 s**, the same baseline as breaking a pallet. Survivors cannot dismantle them. No special power is required.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / medium**, potentially high on maps whose loops depend on a wall.
- **Sketch:** Add breakable obstacle IDs/states to map schema, dynamic collision and LOS in `mapdata.js`/`sight.js`, and a break action in `match.js`. Invalidate navigation fields affected by newly opened connections in `nav.js`. Source: [Breakable Walls](https://deadbydaylight.wiki.gg/wiki/Breakable_Walls).

### 25. Hook availability and basement topology

**Summary:** Hook choice should temporarily alter the carry network, and basement is a concentrated rescue hazard.

- **Rule/numbers:** Ordinary hooks used for a sacrifice break for **60 s**, then repair (**8.1.0, 2024-07-16**). Basement has **four unbreakable hooks** on a central post, immune to sacrifice damage and sabotage. The current hook network is immediately reusable after a death.
- **Scope/confidence/relevance:** Base game **yes**; sabotage needs a toolbox in this scope; **high**; **high / medium-high**.
- **Sketch:** Add hook cooldowns and an `unbreakable` attribute in `match.js`/`mapdata.js`. A flat basement room with one access corridor can reproduce much of its rescue/carry bottleneck without pretending the engine supports multiple floors. Sources: [official 8.1.0 hook respawn](https://forums.bhvr.com/dead-by-daylight/kb/articles/459-8-1-0-tomb-raider), [Basement](https://deadbydaylight.wiki.gg/wiki/Basement).

### 26. Struggle checks and conditional self-unhook attempts

**Summary:** Hooked players have choices, but unconditional four-percent escapes are no longer the live base rule.

- **Rule/numbers:** First-stage attempts take **1.5 s**, normally with **4%** success and **20 s** failure cost **when attempts are enabled**. Since **9.0.0 (2025-06-17)**, the no-loadout case enables chance attempts when only **two survivors remain**; qualifying perks/offerings otherwise unlock them and are excluded here. Resolve is the independent guaranteed route. Struggle checks can incur **20 s** penalties; the two-ignored-check shortcut has changed repeatedly, with a two-survivor exception in **9.1.0**. Last hooked/all-struggle terminal cases require special handling.
- **Scope/confidence/relevance:** Base game **conditional yes**; unconditional 4% with four alive **no**; **high** for eligibility, **medium** for full current failure/no-input cadence; **high / medium**.
- **Sketch:** Allow hooked decisions, implement explicit attempt/struggle success policy and terminal predicates in `match.js`; keep human deliberate-quit behavior separate from an optimal bot's rules. Sources: [official going-next prevention](https://forums.bhvr.com/dead-by-daylight/kb/articles/510-9-0-0-five-nights-at-freddys), [Hooks: current struggle/self-unhook rules](https://deadbydaylight.wiki.gg/wiki/Hooks).

### 27. Window blocking tied to a chase

**Summary:** Three safe out-of-chase vaults should not consume a future chase's window resource.

- **Rule/numbers:** The **third vault of the same window within the same chase** blocks it for that survivor for **30 s**. Other survivors and killer can still use it. Current window vault durations are already close to the sourced base tiers.
- **Gap:** `withinS: 60` is a rolling-time approximation independent of actual chase state; it can block peaceful repeated traversal or fail to count a long chase correctly.
- **Scope/confidence/relevance:** Base game **yes**; **high**; **high / medium**.
- **Sketch:** Key `_noteWindowVault` counts to a validated chase episode and per-survivor/per-window state in `match.js`, rather than replacing the existing blocker from scratch. Source: [Windows](https://deadbydaylight.wiki.gg/wiki/Windows).

### 28. Gate information and escape boundaries

**Summary:** Gate progress is signaled in coarse stages, and the escape area has physical depth.

- **Rule/numbers:** Two gates are located on the map perimeter. Powered-switch aura reveal lasts **12 s** for survivors, permanent for killer; extended from 7 s in **8.6.0**. Lights indicate **25 / 50 / 75%**, with a buzzer in the last quarter. Partial lever progress persists; 99%-ing is a real base strategy. There is no default gate regression.
- **Gap:** Static known positions remove discovery; local observations return exact progress, and gate-open broadcasts should not automatically grant global identity/location beyond the public collapse cue. An exit point within 1 m omits the doorway-to-escape run and endgame bodyblock geometry.
- **Scope/confidence/relevance:** Base game **yes**; **high** for thresholds, **medium** for cue visibility/global notification audit; **high / medium**.
- **Sketch:** Separate lever, door, corridor and escape-line geometry in map data; expose lights at sight range while reserving exact progress for an active opener. Source: [Exit Gates](https://deadbydaylight.wiki.gg/wiki/Exit_Gates).

### 29. AFK crows and ordinary environmental crows

**Summary:** Hiding forever or bodyblocking without participating has a base-game counter.

- **Rule/numbers:** Current AFK thresholds **80 / 100 / 120 points**, with **30 s** grace; movement accrues at **0.25×**, killer proximity within **32 m** at **0.5×**, powered gates at **0.25×**. These are conditional point thresholds, not universal wall-clock timers. Three crows cause repeated loud notifications; the system disables at hatch/endgame. Ordinary crows can be startled by either role and return after **15 s**; no perk-free automatic Spies-style HUD alert.
- **Scope/confidence/relevance:** Base game **yes**; **high** for sourced thresholds, **medium** for complete inactivity classification; **high / medium**.
- **Sketch:** Add an inactivity accumulator with real action/chase exceptions in `match.js`, plus optional seeded crow props. Prevent stationary optimal bots from exploiting the 20-minute cap. Major changes: **9.0.0**, **9.0.1**, **9.3.0 (2025-11-25)**. Sources: [Crows](https://deadbydaylight.wiki.gg/wiki/Crows), [official current thresholds](https://support.deadbydaylight.com/hc/en-us/articles/43679054706708-9-3-0-Mid-Chapter).

### 30. Camera, visibility, and terror-radius fidelity

**Summary:** An adjustable killer camera and freely aimed survivor camera are not equivalent to omnidirectional body sight.

- **Rule/numbers:** First-person killer FOV is adjustable **87–103 degrees** since **7.5.0**; **100 degrees** is a reasonable chosen setting. Survivor third-person camera can look behind independently of movement, but does not observe all directions simultaneously. Terror radius's three equal proximity thirds are broadly correct; chase music is a separate fourth layer. A default **32 m** radius is reasonable for the chosen generic 4.6 m/s killer.
- **Gap:** Survivor 360-degree sight and guaranteed invisibility behind two arbitrary semi-transparent objects distort stealth; **75 m** sight and **0.5 / 2.5 s** terror lags are simulation choices, not established universal live limits. Solid walls do not make terror radius disappear. Standing still does not confer Undetectable without a perk/power.
- **Scope/confidence/relevance:** Base game **yes**; **high** for FOV/settings/layers, **medium-low** for a faithful 2D camera projection; **high / medium**.
- **Sketch:** Keep configurable abstractions or introduce independent camera facing in observations; document the selected information budget. Use chase state for the fourth cue and avoid arbitrary wall occlusion of terror radius. Sources: [official FOV feature](https://forums.bhvr.com/dead-by-daylight/kb/articles/430-7-5-0-alan-wake), [FOV range reference](https://www.pcgamingwiki.com/wiki/Dead_by_Daylight), [Terror Radius](https://deadbydaylight.wiki.gg/wiki/Terror_Radius).

### 31. Map/spawn uncertainty and procedural resources

**Summary:** Seeded layout/resource variation changes which strategies survive across matches.

- **Rule/numbers:** Since **9.0.0**, survivors spawn within **12 m of each other when possible**, on the same floor. The sim uses 15 m. Map tiles can rotate and resource locations vary; unused generator candidates are not automatically visible solid wrecks. Official **9.2.0 / 9.3.0** updates also changed pallet distributions, so old reference-map counts are not necessarily current.
- **Scope/confidence/relevance:** Base game **yes**; **high** for spawn rule, **medium** for map-specific probabilities and physical remnants; **high / medium**.
- **Sketch:** Adjust spawn constraints in `match.js`/`config.js`; audit generator-candidate solids in `mapdata.js`. Treat randomized tile/pallet layout generation and survivor map discovery as optional experimental expansions rather than requiring full procedural maps immediately. Sources: [official spawn update](https://forums.bhvr.com/dead-by-daylight/kb/articles/510-9-0-0-five-nights-at-freddys), [map tile dimensions/rotation](https://deadbydaylight.wiki.gg/wiki/Distances), [official pallet updates](https://forums.bhvr.com/dead-by-daylight/kb/articles/523-9-2-0-sinister-grace).

### 32. Altruistic healing limits and patient participation

**Summary:** Our no-item self-heal restriction is right; multiple helpers and moving patients need explicit rules.

- **Rule/numbers:** One health state is **16 charges**; bare-hand altruistic heal **1 charge/s**, and up to **two helpers** give **2 charges/s / 8 s** total. No generator-style cooperation penalty on ordinary healing. Self-heal needs a med-kit or qualifying perk; adding free self-heal would be wrong. Partial healing normally persists without a modifying effect.
- **Gap:** Each healer independently increments `t.heal`, potentially allowing three helpers. The target can move/perform another action while healing accrues if still in range; real healing is a shared interaction requiring the patient to remain available.
- **Scope/confidence/relevance:** Base game **yes**; **high** for rates/limit, **medium** for cancellation details; **high / medium**.
- **Sketch:** Gather healing participants and patient acceptance once per tick in `match.js`, cap at two and reject incompatible movement/actions. Preserve current persistent progress. Source: [Health States: healing](https://deadbydaylight.wiki.gg/wiki/Downed).

### 33. Animation commitments and interaction movement

**Summary:** Pickup, drop, hook and save windows must use distinct commitments rather than instantaneous state changes.

- **Rule/numbers:** Hooking is **1.5 s** versus our **1 s**; unhook is **1 s**, already correct. Empty/occupied locker searches differ as above. Pickup and voluntary drop have separate animations; I did not establish exact current universal pickup/drop durations well enough to replace our **2 s pickup** confidently.
- **Scope/confidence/relevance:** Base game **yes**; **high** for hook/unhook values, **low-medium** for remaining animation timing; **high / medium**.
- **Sketch:** Expand `_hunterAct` interaction states in `match.js` with lock, commit and recovery phases; specify when wiggle begins, when a save can connect, and when the survivor regains control. Source: [Hooks](https://deadbydaylight.wiki.gg/wiki/Hooks), [Flashlights](https://deadbydaylight.wiki.gg/wiki/Flashlights). Do not assume an instantaneous blind during every pickup phase guarantees a save.

### 34. Finisher mori and optional surrender

**Summary:** Some terminal situations can finish without another carry or waiting for four bleed-outs.

- **Rule/numbers:** Base finisher kill works on the final dying survivor. **9.0.0** also allows it with **two alive** when one is hooked in struggle and the other dying, simultaneously sacrificing that hooked survivor. **10.2.0** offers survivors surrender when all are dying. These are not universal self-recovery or extra hook-state protection.
- **Scope/confidence/relevance:** Base finisher/surrender **yes**; other moris require a power/perk/offering and are **excluded**; **high**; **high / low-medium** (mostly duration/terminal decisions).
- **Sketch:** Add terminal `finish`/team-surrender actions in `match.js`, with no kill credit until the chosen action completes. Treat the simulation's AI agents as normal participants, not automatically as live-game disconnect replacement bots for Abandon/End Trial rules. Sources: [official mori update](https://forums.bhvr.com/dead-by-daylight/kb/articles/510-9-0-0-five-nights-at-freddys), [official surrender conditions](https://forums.bhvr.com/dead-by-daylight/kb/articles/560-10-2-0-mid-chapter).

### 35. Dull totems; Hex state excluded from active play

**Summary:** Base maps contain optional totems, but a no-perk match has no active Hex curse.

- **Rule/numbers:** **Five totems** spawn; base dull cleanse takes **14 s**, resets on interruption and destroys the totem. Without perks they are dull and have no repair/healing/escape benefit. Hex/boon/rekindled effects require perks; inert state/schema support can exist, but lit Hexes should not randomly spawn in this ruleset.
- **Scope/confidence/relevance:** Dull objects/cleanse **yes**; active Hex/Boon **no**; **high**; **high / low** unless score optimization is included.
- **Sketch:** Optional map props and a cleanse action in `match.js`/`mapdata.js`; do not spend hill-climb effort cleansing them unless the experiment intentionally rewards points. Source: [Totems](https://deadbydaylight.wiki.gg/wiki/Totems).

### 36. Height, drops and fall stagger

**Summary:** Real but mostly outside the current flat-map model.

- **Rule/numbers:** Survivors stagger after sufficiently high falls; killers do not. Movement tables describe no stagger at **≤1.25 m**, then **0.5–2 s** through **1.25–5 m**, maximum **2 s**. No ordinary fall damage. Height-based wiggle bonuses from Boil Over are a perk and excluded.
- **Scope/confidence/relevance:** Base fall/stagger **yes**; **medium** for detailed curve; **low / low** for current single-floor maps, high if multi-floor maps are introduced.
- **Sketch:** Defer; obstacle `height` currently describes sight blocking, not walkable elevation. A future map version would need floors/drop edges and vertical navigation in `mapdata.js`/`nav.js`, then survivor landing state in `match.js`. Source: [fall-stagger movement tables](https://deadbydaylight.wiki.gg/wiki/Stagger).

### 37. Chase scoring, chase music and the optimization target

**Summary:** Being chased is an information/scoring event, not a team objective that directly repairs generators.

- **Rule/numbers:** Chases and escapes award score; activity HUD indicates chased survivors, and chase music signals an active pursuit. These cues should follow validated chase state, including the running/view/range prerequisites in candidate 2. Ordinary chase score does not grant a speed or repair bonus; Bloodlust is the associated base killer mechanic.
- **Scope/confidence/relevance:** Base game **yes**; **high** for existence, **medium** for exact scoring chase lifecycle; **high / low** unless score is used as fitness.
- **Sketch:** Keep scoring telemetry in `match.js` distinct from kill/escape fitness and from emblems' potentially different chase bookkeeping. Do not derive live chase termination solely from an emblem article: the wiki's Bloodlust and emblem timing descriptions differ. Sources: [Score Events](https://deadbydaylight.wiki.gg/wiki/Score_Events), [Terror Radius](https://deadbydaylight.wiki.gg/wiki/Terror_Radius), [Bloodlust](https://deadbydaylight.wiki.gg/wiki/Bloodlust).

## Loadout items — separate scope decision, ranked within this group

All entries below can operate without perks/powers/add-ons/offerings, but **are optional survivor loadout items**. They can also enter a match through chests. If the intended experiment is empty-handed, leave them disabled, including chest loot. Do not implement only med-kits while silently assuming every survivor owns one.

### L1. Med-kits

**Summary:** Finite independent healing changes split pressure and injury persistence.

- **Rule/numbers:** Standard kits have **24 charges**, generally enough for **one approximately 24 s self-heal** without add-ons/great checks. Self-heal speed and efficiency have roughly one-third penalties. Altruistic speed bonuses by standard rarity are **+35 / +40 / +45 / +50%**. The major rework was **6.7.0 (2023-04-18)**.
- **Scope/confidence/relevance:** Loadout item **yes**, entirely add-on-free; **high** for ordinary capacities/times, **medium** for exact charge-consumption implementation (the wiki prose/formulas are not perfectly consistent); **high / high**.
- **Sketch:** Add inventory/charges and self-heal intent to `match.js`, defining consumption from measured one-heal capacity instead of multiplying ambiguous efficiency wording. Source: [Med-Kits](https://deadbydaylight.wiki.gg/wiki/Med-Kits).

### L2. Toolboxes and hook sabotage

**Summary:** A finite repair burst and time-sensitive hook denial introduce new resource allocation.

- **Rule/numbers:** Examples: Worn-Out **16 charges, +50% repair**; Toolbox **20, +50%**; Commodious **32, +50%**; Mechanic's **16, +75%**; Engineer's **16, +100%**. Repair consumes toolbox charges at the boosted transfer rate, so 16 charges is not 16 seconds at every rarity. Base sabotage **3 s / 6 charges before toolbox speed modifiers**; hooks repair after **30 s**. No perk-free bare-hand sabotage; basement hooks cannot be sabotaged.
- **Scope/confidence/relevance:** Loadout item **yes**; **high** for these examples, **medium** for exact sabotage consumption under speed modifiers; **high / high**.
- **Sketch:** Add `useToolbox`/`sabotage` actions and inventory in `match.js`; share hook-unavailable state with candidate 25. Exclude Brand New Part and all add-on bonuses. Sources: [Toolboxes](https://deadbydaylight.wiki.gg/wiki/Toolboxes), [Hooks](https://deadbydaylight.wiki.gg/wiki/Hooks).

### L3. Flashlights / blinds

**Summary:** A teammate can contest pickups and the killer's visual tracking.

- **Rule/numbers:** Default beam **10 m**, blind buildup **1 s**, blind duration **2 s**, beam angle **20 degrees**. Battery capacities vary by model; ordinary Flashlight is **8 s**. Looking away defeats buildup; blind does not mute hearing or inherently stop walking. A blinded killer cannot lunge, but can quick-attack. Carry blind can release an injured survivor with a stun; distinguish that from an ordinary stationary blind.
- **Scope/confidence/relevance:** Loadout item **yes**; **high** for baseline beam/timing, **medium** for precise pickup-save windows/angle projection; **high / high**.
- **Sketch:** Add beam alignment/buildup and temporary visual suppression in `match.js`/`sight.js`; retain sound observations and implement carry-save release. A horizontal-only sim needs a deliberate look-away abstraction because real players also look up/down. Source: [Flashlights](https://deadbydaylight.wiki.gg/wiki/Flashlights).

### L4. Fog vials — easy to miss in older base-game inventories

**Summary:** Current regular items can temporarily alter visibility and tracking.

- **Rule/numbers:** Introduced **9.1.0 (2025-07-29)**; current standard variants have **4 charges** after **9.5.0 (2026-03-17)**, expand over **2 / 1.5 / 1.2 s**, persist **8 / 10 / 12 s**, and recharge over **70 / 65 / 60 s**. Current wiki lists **8 m** maximum size; older patch text lists 10 m, so verify whether this parameter is a radius/size and which patch changed it. Fog suppresses scratches/auras and affects sound/vision; essential hooked/downed auras remain visible after 9.5.0.
- **Scope/confidence/relevance:** Loadout item **yes**, not a killer power; **high** for current charge/history, **medium** for cloud geometry/attenuation; **high / medium-high**.
- **Sketch:** Add transient spatial fields in `match.js`, consulted by `sight.js` and sound/trace emission. Verify geometry before coding. Sources: [Fog Vials](https://deadbydaylight.wiki.gg/wiki/Fog_Vials), [current item parameters](https://deadbydaylight.wiki.gg/wiki/Module:Datatable/Loadout), [official 9.5.0 fog update](https://forums.bhvr.com/dead-by-daylight/kb/articles/538-9-5-0-all-kill-comeback).

### L5. Chests and inventory exchange

**Summary:** Survivors can spend time acquiring an item mid-match instead of repairing.

- **Rule/numbers:** Normally **3 chests**, one in basement; unlock **8 s** with persistent progress, down from 10 s in **8.4.0 (2024-11-28)**. Unlock sound range **20 m**. One ordinary item per unmodified chest, with separate inspect/retrieve/drop/swap behavior. Ordinary repeat rummaging is not free basekit; current keys can enable a special teammate rummage.
- **Scope/confidence/relevance:** Chest object **base yes**, useful loot **loadout-item scope**; **high** for counts/timing, **low-medium** for current loot probabilities; **high / medium**.
- **Sketch:** Add chest candidates/loot seed to map data and a single ordinary inventory slot to actors in `match.js`. Do not infer current drop rates from old chest studies. Source: [Chests](https://deadbydaylight.wiki.gg/wiki/Chests).

### L6. Keys — use the reworked base item, not obsolete add-on-only behavior

**Summary:** Keys now supply teammate information without add-ons; suitable keys also reopen hatch.

- **Rule/numbers:** Post-**9.1.0** Broken / Dull / Skeleton have **6 / 5 / 6 uses**, revealing teammates within **48 / 56 / 64 m** for **8 / 9 / 10 s**. Dull/Skeleton open closed hatch in **2.5 s** and can quickly unlock a chest with rare-or-better loot and one teammate rummage. Each ability use consumes one charge; hatch use no longer destroys the whole key. Broken Key cannot reopen hatch.
- **Scope/confidence/relevance:** Loadout item **yes**; **high**; **high / medium**, potentially high in final-survivor play.
- **Sketch:** Implement timed aura grants, per-use charges, chest interaction and hatch unlock in `match.js`; keep killer-aura add-ons excluded. Source: [Keys](https://deadbydaylight.wiki.gg/wiki/Keys), [rework chronology](https://deadbydaylight.wiki.gg/wiki/Fog_Vials).

### L7. Maps — current pallet/window information plus a team beacon

**Summary:** Reworked maps reveal nearby loop resources and can mark a generator-search area.

- **Rule/numbers:** Post-**9.1.0** Cryptic / Scribbled / Annotated: **4 / 5 / 6 uses**, pallet/window ranges **24 / 32 / 40 m**, durations **10 / 12 / 14 s**. Their survivor-only light beam lasts **16 s**, revealing generator auras within **32 m** to teammates. Totem/hatch/killer tracking should not be imported from old map/add-on descriptions.
- **Scope/confidence/relevance:** Loadout item **yes**; **high**; **high / low-medium** under current full static-map knowledge, higher if resource discovery is hidden.
- **Sketch:** Add per-survivor timed object-aura grants and beacon state in `match.js`; first remove omniscient resource knowledge if evaluating their information value. Event Bloodsense Map is excluded from the default inventory. Source: [Maps](https://deadbydaylight.wiki.gg/wiki/Maps), [rework chronology](https://deadbydaylight.wiki.gg/wiki/Fog_Vials).

## Things currently wrong, separated from merely missing features

These are observed in the read snapshot, not changes made by this report. Numbers and sources are in the linked candidate sections above.

| Priority | Current model | Base-game difference / action for review |
|---|---|---|
| Critical | `hooks.stageS = 60` | [1](#1-hook-stage-accounting-and-hook-duration): 70 s per stage. |
| Critical | `_hookSurvivor` bases sacrifice on physical hook count | [1](#1-hook-stage-accounting-and-hook-duration): reaching struggle consumes a stage; next hooking can already sacrifice. Last-survivor hooks resolve immediately. |
| Critical | `_wiggleFree` / carried pallet release -> downed | [6](#6-carry-escapes-saves-and-voluntary-dropping): successful escape/save -> injured. |
| High | `_downSurvivor` resets 240 s bleed budget | [3](#3-downed-recovery-and-cumulative-bleed-out): budget is cumulative across downs. |
| High | Repair touch stops regression; unlimited kicks | [4](#4-generator-anti-three-gen-and-anti-tap-rules): 5% repair threshold and eight-event ceiling. |
| High | One survivor left immediately powers gates | [5](#5-real-hatch-instead-of-automatic-gate-power): hatch opens first; closing it powers gates and starts collapse. |
| High | Deep Wound ticks while running; self-mend 12 s | [7](#7-deep-wound-running-pause-and-altruistic-mending): running pause, 10 s self / 6 s altruistic. |
| High | HUD exports exact teammate generator ID, hides repair/Resolve progress | [8](#8-solo-queue-information-progress-without-generator-identity-plus-intent-messages): reverse that information trade; bounded intent messages are now base solo-queue. |
| High | Anti-camp 20 m; camp time advances during grace/non-fill | [11](#11-resolve-range-timing-and-player-choice): live 16 m and multiplier time only during fill; stage/proximity formula remains an approximation. |
| High | One protection timer grants stealth after gates power/after an absorbed hit | [12](#12-current-unhook-protections-and-elusive-lifecycle): separate Elusive lifecycle from Haste/Endurance. **10-second duration itself is currently right.** |
| High | No downed exit; constant-speed collapse | [10](#10-endgame-collapse-killer-gate-opening-and-crawling-escapes): crawling escape and half-speed incapacitation timer. |
| Medium-high | Carrying hunter globally non-colliding in newly added config | [17](#17-collision-exceptions-beyond-the-already-planned-bodies): conflicts with carry bodyblocking; verify live exception timing. |
| Medium | Pallet vault always 1.2 s; no rushed notification | [15](#15-fastslow-pallet-vaults-and-stun-timing): 1.1 s loud / 2 s quiet. |
| Medium | Window blocker uses rolling 60 s regardless of chase | [27](#27-window-blocking-tied-to-a-chase): same-chase count, still per survivor. |
| Medium | Hook animation 1 s | [33](#33-animation-commitments-and-interaction-movement): 1.5 s. |
| Medium | Healers can potentially exceed two or heal an active moving patient | [32](#32-altruistic-healing-limits-and-patient-participation): cap participants and model shared interaction. |
| Medium | Three separate assumptions: burst 6.0 m/s, one-phase attack, 1.5 s wiggle stun | [9](#9-basic-attack-choices-hit-burst-and-swept-hit-geometry), [6](#6-carry-escapes-saves-and-voluntary-dropping): verify burst/current stun and phase curves; do not call guessed replacements exact. |
| Medium | Repair noise 10 m and active workers only | [14](#14-generator-sound-coarse-visual-progress-and-aura-limits): wiki baseline 20 m and separate machinery/progress cues. |
| Medium | Marks expose exact velocity direction/time | [20](#20-scratch-mark-uncertainty-and-generation): patch-based visual evidence is less precise. |
| Medium | Spawn cluster 15 m | [31](#31-mapspawn-uncertainty-and-procedural-resources): current intended default within 12 m, when possible. |
| Experimental choice | 20-minute match cap, 75 m sight, omnidirectional survivor perception, numerical progress on sight | Preserve if desired, but label them experimental abstractions rather than certified DBD mechanics. |

## Boundary checks: do not accidentally add excluded mechanics

- **No universal base self-heal** without an item; no universal full self-pickup. Automatic **95% recovery** is distinct from self-recovery. The proposed cumulative anti-slug Resolve self-pickup in the **9.2 / 9.3 PTBs** was postponed/reverted in live notes; this research found no later live rule establishing that proposal. Sources: [9.2 live reversions](https://forums.bhvr.com/dead-by-daylight/kb/articles/523-9-2-0-sinister-grace), [9.3 live reversions](https://support.deadbydaylight.com/hc/en-us/articles/43679054706708-9-3-0-Mid-Chapter), [Health States](https://deadbydaylight.wiki.gg/wiki/Health_States).
- **No base Decisive Strike, Borrowed Time perk extension, Off the Record, Unbreakable, Deliverance, Saboteur or No One Escapes Death.** Some now have general/free-perk availability; “available to everyone” still does not make them basekit. No free Haste for unique hooks or 30-second unhook protection copied from the abandoned 9.3 PTB.
- **No exhaustion, exposed, mangled, hemorrhage healing regression, broken, undetectable, oblivious, killer instinct, lullabies, pallet-vaulting killer or instant-down attack by default.** Implement only if a genuinely included source creates them; most here require a forbidden perk/power/add-on. Ordinary injury blood pools are not the Hemorrhage status effect.
- **No active Hex/Boon effects.** Dull totems are valid environmental objects; lit Hexes require perks. No points-only chest/totem behavior should accidentally become part of kill/escape fitness.
- **No killer power items or event consumables in default loot.** Vaccines, sprays and EMPs are power-counter items. Firecrackers are an optional event-item extension; Flashbang/Blast Mine need perks and are excluded. Fog Vials, however, are regular current survivor items, separately flagged above.
- **No automatic experimental diminishing-returns stack system needed for an empty-loadout match.** Live **9.6.0** added diminishing returns for stacked modifiers (**100 / 50 / 25 / 12.5 / 5%** contribution sequence), but most triggering combinations in this scope do not exist. Revisit only if simultaneously stacking eligible item/base modifiers; do not treat all unrelated multipliers as interchangeable. Source: [official 9.6.0](https://forums.bhvr.com/dead-by-daylight/kb/articles/544-9-6-0-patch-notes).

Before implementing medium/low-confidence geometry or timing, choose a frozen target live patch and measure it in an empty-loadout custom match. In particular: attack/burst curves, wiggle/forced-drop stun and control windows, collision exceptions, exact Resolve fill curve, sensory attenuation, fog size, and current skill-check interruption protection remain calibration tasks rather than settled constants.
