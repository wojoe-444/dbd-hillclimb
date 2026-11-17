// All tunable numbers live here. Pass `config: { ...partial }` to createMatch/runMatch to override
// (deep-merged over defaultConfig; unknown keys are kept so you can add your own).

export const defaultConfig = {
  tickHz: 10,               // simulation rate; dt = 1 / tickHz
  maxMatchS: 1200,          // hard cap (20 min)
  decisionEvery: 1,         // brains decide every N ticks (the last action is repeated in between)
  recordEvery: 2,           // frame log stride when record:true
  recordEvents: true,       // keep the event timeline in the result

  radius: 0.4,              // character circle radius (m)

  sight: {
    semiTransparency: 0.6,  // each low obstacle / window / pallet / generator crossed multiplies visibility by this
    visThreshold: 0.5,      // a target is "seen" iff in range/cone and visibility >= this (deterministic, no RNG)
    range: 75,              // m, both roles (user: the hunter sees ~75 m wherever it looks)
    hunterFovDeg: 100,      // hunter forward cone
    perceptionEvery: 2,     // ticks between hunter/teammate visibility refreshes (reaction latency 0.2 s)
    staticPerceptionEvery: 2, // ticks between generator/pallet visibility refreshes (survivors, staggered; cheap: cached per cell)
    adjacentReach: 2.0,     // m: a generator/pallet this close (to its rectangle) is always "seen"
    // crouching (README "Crouching"): a crouched survivor is fully hidden in the geometric shadow of a low object
    crouchBodyM: 0.95,      // [A] top of a crouched survivor's body (m)
    hunterEyeM: null,       // [A] hunter eye height (m); null = the map's eyeHeight (1.6)
    survivorEyeM: null,     // [A] survivor camera height (m) for spotting crouched teammates; null = map eyeHeight
    windowCoverM: 1.0,      // [A] window sill height: crouched under a window = hidden from afar
    genCoverM: 1.3,         // [A] generator height (in game crouching behind a gen hides you); also the inert wrecks
    palletCoverM: 0,        // [A] pallets give no crouch cover (sight grid is static: up / dropped / broken look the same)
  },

  senses: {
    terrorRadius: 32,       // survivors hear the hunter (no direction, no exact distance) inside this
    terrorLayers: 3,        // equal-width music layers (wiki: thirds of the radius); obs.terror.layer 1 = outermost
    terrorEnterLagS: 0.5,   // time to notice entering / leaving the radius
    terrorLayerLagS: 2.5,   // a change between layers must persist this long before it's noticed
    gruntRadius: 10,        // hunter hears injured survivors inside this
    repairNoiseRadius: 20,  // [S] wiki default repair-noise range; hunter hears gens being repaired inside this (obs.noisyGens, no identity/count)
    loudNoiseRange: Infinity, // fast window vaults / rushed pallet vaults: hunter gets a loudNoise notification within this (Infinity = map-wide)
    gruntNoise: 2,          // +-m uniform noise on grunt positions
    gruntIntervalS: 1,      // an injured survivor grunts at most this often
    gruntMemoryS: 2,        // grunts stay in hunter obs this long
    scratchMemoryS: 10,     // scratch marks fade after this long (genre: ~10 s)
    scratchEveryS: 0.5,     // sprinting survivors drop a mark this often
    scratchRange: 30,       // hunter sees marks inside its cone up to this distance
    screamRadius: 0,        // survivors hear a teammate being downed/hooked within this. 0 = OFF (solo-queue default)
  },

  survivor: {
    // 3rd-person camera vision (README "Survivor camera"). enabled:false = the old 360-degree body-origin vision.
    camera: {
      enabled: true,
      backM: 2.75,          // camera distance behind the body, opposite the look direction
      shoulderM: 0.5,       // sideways offset ...
      side: 1,              // ... to the right of the look direction (+1) or the left (-1)
      minM: 0.5,            // pushed in closer than this to the body (a wall right behind): the camera sits at the body
      wallMarginM: 0.3,     // stop this far short of the first opaque cell when pushed in by a wall
      fovDeg: 100,          // horizontal field of view centred on the look direction
      turnRateDegS: 720,    // max camera yaw rate
      bodyAwareM: 2.5,      // always-on 360-degree awareness around the body (things touching you)
    },
    runSpeed: 4.0,
    accelMS2: 10,           // [S] wiki Movement Speeds "Acceleration 10.0 m/s2": speed ramps up by this (0 -> run in 0.4 s); slowing down is instant
    walkSpeed: 2.26,        // walking leaves no scratch marks
    crouchSpeed: 1.13,      // action crouch:true (standing survivors): no scratch marks, slow (quiet) vaults, low silhouette
    crouchEnterS: 0.3,      // [A] crouch held this long before the low silhouette counts for sight (standing up is instant)
    crawlSpeed: 0.7,
    hitBoostS: 1.8,         // speed boost after being hit (wiki: 1.8 s)
    boostMult: 1.65,        // [S] on-hit sprint 6.6 m/s = 1.65 x 4.0 for hitBoostS (takes precedence over unhook haste: max of the two)
    bleedOutS: 240,         // [S] bleed-out budget, CUMULATIVE across all downs of the match (not reset per down)
    recoverRate: 0.5,       // [S] downed + stationary: automatic recovery in healing charges/s (1 charge = 1 s of healS) ...
    recoverCap: 0.95,       // [S] ... up to this fraction of the downed->injured heal; the last 5 % needs a teammate. Crawling pauses it
    maxHealers: 2,          // [S] at most two survivors heal one patient at once (1 charge/s each, no cooperation penalty)
    healS: 16,              // heal another survivor (injured->healthy, downed->injured); persists on the target
    wiggleS: 16,            // wiggle seconds needed to escape a carry
    vaultFastS: 0.5,        // window, fast vault: running with a straight run-up >= fastVaultRunupM toward the window (LOUD)
    revaultNoFastS: 2,      // [user] a survivor re-vaulting a window within this long after the hunter cleared it gets at best a medium vault
    vaultMediumS: 0.9,      // window, medium vault: running, short run-up / angled approach / bumped into the wall
    vaultSlowS: 1.5,        // window, slow vault: walking (quiet)
    fastVaultRunupM: 2.5,   // continuous running distance with heading within fastVaultAngleDeg of the vault direction
    fastVaultAngleDeg: 45,  // [user] widened from 25 (2026-11-16; the wiki gives no angle, only "runs straight towards")
    palletVaultFastS: 1.1,  // [S] dropped pallet, running: fast vault, LOUD (hunter loudNoise cause 'palletVault')
    palletVaultSlowS: 2.0,  // [S] dropped pallet, walking: slow vault, quiet
    palletDropS: 0.3,
    rescueS: 1,
    noCollideAfterHitS: 2,  // after taking damage (any hit, incl. an Endurance hit) a survivor collides with nobody for this long
  },

  collision: {              // character bodies (circles of radius `radius`); see README "Collision"
    survivors: true,        // survivor <-> survivor bodies block each other
    hunterSurvivor: true,   // hunter <-> survivor bodies block each other (body blocking)
    // Non-colliding: downed / carried / hooked / dead / escaped survivors, anyone mid-vault, and a survivor within
    // survivor.noCollideAfterHitS of being hit. A CARRYING hunter still collides (survivors can body-block the carrier).
    // Nav is static (no dynamic avoidance in the planner).
    unstickS: 2,            // a survivor pushing against another SURVIVOR without progress for this long ...
    unstickGhostS: 1,       // ... stops colliding with survivors for this long (anti-deadlock in 1-cell corridors; 0 = off)
    hunterUnstickS: 10,     // [S] official AFK rule: a hunter body-blocked by survivors without progress for this long ...
    hunterGhostS: 3,        // [A] ... stops colliding with survivors for this long (0 = off)
  },

  hunter: {
    turnRateDegS: 450,      // [user] max view turn rate (no instant 180-degree flicks)
    speed: 4.6,
    accelMS2: 11.25,        // [S] wiki Movement Speeds (killer acceleration, same for all killers): speed ramps up by this; slowing is instant
    vaultExitReset: true,   // [A] the hunter lands a window vault at 0 speed and re-accelerates (no source; like a survivor's slow vault)
    carrySpeed: 3.68,       // wiki: 92%
    windupS: 0.35,          // NOTE: timers elapse in whole ticks (rounded up): 0.35 s -> 4 ticks = 0.4 s
    attackRange: 2.2,
    attackHalfArcDeg: 45,   // hit needs target within +-45 deg of facing
    lungeSpeedMult: 1.5,    // speed multiplier during windup (wiki lunge ~6.9 m/s = 1.5 x 4.6)
    hitCooldownS: 2.7,
    hitCooldownSpeed: 0.575, // wiki
    missCooldownS: 1.5,
    missCooldownSpeed: 1.15, // wiki
    pickupS: 2,
    hookS: 1.5,             // [S] hook animation 1.5 s
    dropS: 0,               // [A] voluntary drop of a carried survivor (exact animation not established => instant)
    dropWiggleBonus: 0.25,  // [S] a voluntary drop adds this fraction of survivor.wiggleS to the dropped survivor's wiggle progress
    openGateS: 0.75,        // [S] hunter opens a powered gate (only before the collapse has begun); interrupted progress resets
    bloodlust: [[15, 0.2], [25, 0.4], [35, 0.6]], // [S] chase seconds -> +m/s on normal movement; reset on hit / pallet break / chase end
    breakPalletS: 2.34,
    kickS: 1.8,             // kick a generator (stand still within reach.kickGen)
    vaultS: 1.7,
    palletStunS: 2,
    palletStunAlongM: 1.0,  // stun if hunter within pallet footprint +- this along its axis
    wiggleStunS: 1.5,       // [A] stun when a carried survivor wiggles free (exact live value not established)
  },

  gens: {
    placed: 7,              // generator candidates chosen per match (seeded)
    needed: 5,
    repairS: 90,            // seconds of work for ONE survivor at efficiency 1 (90 charges since 2022)
    efficiency: [1.0, 0.85, 0.7, 0.55], // per-worker efficiency with 1/2/3/4 workers (-15% each per extra repairer; wiki Efficiency Penalty)
    fumbleChancePerS: 0,    // legacy random repair fumble (skill checks are out of scope). 0 = off (default)
    fumbleLoss: 0.1,        // fraction of repairS lost on a fumble (only if fumbleChancePerS > 0)
    kickLoss: 0.05,         // [S] hunter kick: fraction of repairS lost immediately
    regressRate: 0.25,      // [S] kicked gen regresses at this x a solo survivor's repair rate (0.25 charges/s)
    maxKicks: 8,            // [S] at most this many hunter-caused regression events (kicks) per generator
    cancelRegressFrac: 0.05,// [S] regression only stops after this fraction of repairS of ACTUAL repair (4.5 charges); passive
                            //     regression pauses while repairing and resumes if repair stops early ([A] the partial cancel progress resets)
  },

  unhook: {                 // [S] basekit "Unhook Protections" (patch 10.1.0), granted to the unhooked survivor
    protectS: 10,           // [S] Endurance + Haste for this long (always)
    elusiveS: 10,           // [S] Elusive (no scratch marks / grunts) for this long, ONLY if the gates are not powered yet;
                            //     ends early on being hit (incl. an Endurance hit) or entering the dying state.
                            // All of them end early on a conspicuous action (repair, heal, rescue, openGate; mend / dropPallet allowed)
    haste: 0.10,            // [S] speed x (1 + haste) while protected (not while crawling)
    deepWoundS: 20,         // [S] Endurance absorbs a downing hit -> injured + Deep Wound; timer expiry downs.
                            //     The timer pauses while running or being mended (self or by a teammate)
    mendS: 10,              // [S] self-mend clears Deep Wound; progress persists
    mendOtherS: 6,          // [S] altruistic mend by one teammate (act 'mend', target = patient id)
    mendHelpers: 2,         // [S] at most this many teammates mend one patient at once ...
    mendTwoEff: 0.75,       // [S] ... each at this efficiency when two mend (25 % individual penalty)
  },

  antiCamp: {               // "Resolve" anti-camp self-unhook. [S] = sourced (patch notes / wiki), [A] = assumed model
    enabled: true,
    radius: 16,             // [S] live 9.3.0: meter fills only while the hunter is within this of the hook (20 m was the PTB)
    nearM: 4,               // [A] full proximity factor (1) within this ...
    farFactor: 0.25,        // [A] ... linearly down to this at `radius`, 0 beyond   ([S] closer = faster)
    baseFullS: 100,         // [A] seconds to fill at factor 1 (tuned: face-camp ~33 s incl. grace, kick-and-leave ~0)
    timeMult: [[10, 1], [20, 2], [Infinity, 4]], // [S] by camping seconds: 1x <10 s, 2x 10-20 s, 4x beyond;
                            //     [S] camping seconds accrue ONLY while the meter actually gains progress
    campResetS: 5,          // [A] camping time resets after the hunter has been out of range this long
    stageCurve: 3,          // [A] stage factor 1 + stageCurve * f^2, f = elapsed fraction of the current hook stage (user: late = fast)
    graceS: 7,              // [S] every hook event pauses ALL hooked survivors' meters for this long
    mateRadius: 8,          // [A] any other non-hooked survivor this close to the hook stops the meter ([S] nearby survivors slow/stop it)
    chaseRadius: 16,        // [A] no fill while the hunter sees a standing survivor within this (in chase) or is carrying
    selfUnhookS: 1.5,       // [S] full meter => the hooked survivor MAY self-unhook (act 'selfUnhook' repeated for this long, hook
                            //     timer paused); normal unhook result. Not available once the gates are powered
  },

  chase: {                  // engine-level chase state (survivor HUD `chased`, self.chased, hunter obs.chase, Bloodlust)
    startRange: 12,         // [S] starts when the (non-carrying) hunter sees a RUNNING standing survivor within this
    runSpeed: 3.0,          // [A] m/s: a survivor counts as running above this speed (walk 2.26, run 4.0)
    loseRange: 18,          // [S] ends when the target is farther than this
    loseS: 8,               // [S] ends after the hunter hasn't seen the target for this long (or the target is downed/hooked/out)
  },

  intent: {                 // [S] 10.2.0 survivor intent messages (predefined, no free text / coordinates), survivors only
    messages: ['goingForGen', 'goingForUnhook', 'chasingMe', 'healing', 'help', 'thanks', 'splitUp', 'repair'],
                            // default 8-slot wheel per a pre-release settings screenshot (Going for Generator, Going for unhook,
                            // Chasing Me, Healing, Help!, Thanks, Split up!, Repair) -- vocabulary medium confidence
    minCooldownS: 1,        // [S] anti-spam cooldown starts at 1 s ...
    maxCooldownS: 5,        // [S] ... rising to 5 s with continued spamming
    spamWindowS: 5,         // [A] a send within this of the previous send raises the cooldown by 1 s
    resetS: 10,             // [A] no send for this long resets the cooldown to minCooldownS
  },

  spawn: {
    groupRadius: 12,        // [S] m: the 4 survivors spawn within this when possible (pairwise and path distance from the anchor)
    minSep: 3,              // m: minimum pairwise distance between survivors at spawn
    hunterMinFrac: 0.8,     // hunter candidates eligible if path dist from the anchor >= this x farthest inset walkable cell
    edgeInset: 4,           // m: fallback hunter spawn must be at least this far inside the outline
  },

  hooks: {                  // [S] hook STAGES are consumed, not hookings: each hooking advances one stage, and so does the stage
    stageS: 70,             //     timer running out (stage 1 -> 2 "struggle"). Reaching deathStage kills, so a survivor rescued after
    deathStage: 3,          //     struggle on the 1st hook dies on the next hook. The last survivor left is sacrificed at once when hooked.
  },

  gates: {
    leverS: 20,             // hold lever; one survivor per lever at a time; progress persists on the gate
    endgameS: 120,          // [S] endgame collapse budget: starts when the FIRST gate is OPENED (no hatch: user rule); survivors
                            //     left die. Runs at collapseSlowFactor while any survivor is downed / carried / hooked (no stacking)
    collapseSlowFactor: 0.5,
    exitReach: 1.0,         // m to reach `exit` point
  },

  windowBlock: {            // [S] entity blocker: the Nth vault of one window by one survivor WITHIN THE SAME CHASE (while that
    vaults: 3,              //     survivor is the chase target) blocks the window for that survivor only. Vaults outside a chase don't count
    blockS: 30,             // [S] 30 s, only for that survivor
  },

  reach: {                  // interaction ranges (m)
    repairSlot: 0.6,        // survivor centre to a generator side-slot point (centre of the walkable N/E/S/W neighbour cell)
    heal: 1.6,              // centre to centre
    rescue: 1.8,            // survivor centre to hook centre
    pallet: 1.2,            // survivor centre to pallet footprint rectangle (spec: 1.2)
    lever: 1.5,
    pickup: 1.5,
    hook: 1.5,              // carried survivor -> hook (spec: 1.5)
    breakPallet: 1.5,       // hunter centre to dropped pallet footprint
    kickGen: 1.1,           // hunter centre to generator rectangle
    vaultLane: 0.3,         // max lateral offset from lane centre to start a vault
    arrive: 0.05,           // moveTo stops when this close to its waypoint/target
  },

  nav: {
    fieldCacheSize: 256,    // LRU of distance fields per role (shared across matches on the same map)
    windowCostSurvivor: 2.0,// extra path cost (m) for entering a window cell
    windowCostHunter: 6.0,
    astarMaxExpand: 9000,     // A* expansion budget (the map has ~10k cells; exceeded => field fallback)
    lookahead: 14,          // path nodes considered for string pulling
    fieldAfterHits: 4,      // build a full field for a target after this many A* queries to the same cell
    crossPenalty: 40,       // dist(): hunter route crosses a dropped pallet and the pallet-aware search ran out of budget
  },
};

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

export function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over) return out;
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    out[k] = isObj(b) && isObj(over[k]) ? deepMerge(b, over[k]) : (Array.isArray(over[k]) ? over[k].slice() : over[k]);
  }
  return out;
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** Merge overrides over defaultConfig, returning a fresh frozen config. */
export function mergeConfig(over) {
  return deepFreeze(deepMerge(defaultConfig, over));
}
