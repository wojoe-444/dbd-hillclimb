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
  },

  senses: {
    terrorRadius: 32,       // survivors hear the hunter (no direction, no exact distance) inside this
    terrorLayers: 3,        // equal-width music layers (wiki: thirds of the radius); obs.terror.layer 1 = outermost
    terrorEnterLagS: 0.5,   // time to notice entering / leaving the radius
    terrorLayerLagS: 2.5,   // a change between layers must persist this long before it's noticed
    gruntRadius: 10,        // hunter hears injured survivors inside this
    repairNoiseRadius: 10,  // hunter hears generators being repaired inside this (obs.noisyGens, no worker identity/count)
    loudNoiseRange: Infinity, // fast vaults: hunter gets a loudNoise notification within this range (Infinity = map-wide)
    gruntNoise: 2,          // +-m uniform noise on grunt positions
    gruntIntervalS: 1,      // an injured survivor grunts at most this often
    gruntMemoryS: 2,        // grunts stay in hunter obs this long
    scratchMemoryS: 10,     // scratch marks fade after this long (genre: ~10 s)
    scratchEveryS: 0.5,     // sprinting survivors drop a mark this often
    scratchRange: 30,       // hunter sees marks inside its cone up to this distance
    screamRadius: 0,        // survivors hear a teammate being downed/hooked within this. 0 = OFF (solo-queue default)
  },

  survivor: {
    runSpeed: 4.0,
    walkSpeed: 2.26,        // walking leaves no scratch marks
    crawlSpeed: 0.7,
    hitBoostS: 1.8,         // speed boost after being hit (wiki: 1.8 s)
    boostMult: 1.5,         // on-hit sprint burst multiplier (takes precedence over unhook haste: max of the two)
    bleedOutS: 240,         // downed -> dead
    healS: 16,              // heal another survivor (injured->healthy, downed->injured); persists on the target
    wiggleS: 16,            // wiggle seconds needed to escape a carry
    vaultFastS: 0.5,        // window, fast vault: running with a straight run-up >= fastVaultRunupM toward the window (LOUD)
    vaultMediumS: 0.9,      // window, medium vault: running, short run-up / angled approach / bumped into the wall
    vaultSlowS: 1.5,        // window, slow vault: walking (quiet)
    fastVaultRunupM: 2.5,   // continuous running distance with heading within fastVaultAngleDeg of the vault direction
    fastVaultAngleDeg: 25,
    palletVaultS: 1.2,      // dropped pallet
    palletDropS: 0.3,
    rescueS: 1,
    noCollideAfterHitS: 2,  // after taking damage (any hit, incl. an Endurance hit) a survivor collides with nobody for this long
  },

  collision: {              // character bodies (circles of radius `radius`); see README "Collision"
    survivors: true,        // survivor <-> survivor bodies block each other
    hunterSurvivor: true,   // hunter <-> survivor bodies block each other (body blocking)
    // Non-colliding: downed / carried / hooked / dead / escaped survivors, anyone mid-vault, a carrying hunter, and a
    // survivor within survivor.noCollideAfterHitS of being hit. Nav is static (no dynamic avoidance in the planner).
    unstickS: 2,            // a survivor pushing against another SURVIVOR without progress for this long ...
    unstickGhostS: 1,       // ... stops colliding with survivors for this long (anti-deadlock in 1-cell corridors; 0 = off)
  },

  hunter: {
    speed: 4.6,
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
    hookS: 1,
    breakPalletS: 2.34,
    kickS: 1.8,             // kick a generator (stand still within reach.kickGen)
    vaultS: 1.7,
    palletStunS: 2,
    palletStunAlongM: 1.0,  // stun if hunter within pallet footprint +- this along its axis
    wiggleStunS: 1.5,       // stun when a carried survivor wiggles free
  },

  gens: {
    placed: 7,              // generator candidates chosen per match (seeded)
    needed: 5,
    repairS: 90,            // seconds of work for ONE survivor at efficiency 1 (90 charges since 2022)
    efficiency: [1.0, 0.85, 0.7, 0.55], // per-worker efficiency with 1/2/3/4 workers (-15% each per extra repairer; wiki Efficiency Penalty)
    fumbleChancePerS: 0.01, // per worker per repair-second
    fumbleLoss: 0.1,        // fraction of repairS lost on a fumble
    kickLoss: 0.05,         // hunter kick: fraction of repairS lost immediately
    regressRate: 0.25,      // kicked gen regresses at this x a solo survivor's repair rate until someone repairs it (or 0)
  },

  unhook: {                 // basekit "Unhook Protections" (patch 9.3.0), granted to the rescued survivor
    protectS: 10,           // haste + endurance + elusive (no scratch marks / grunts), same before and after gates are powered;
                            // all end early on a conspicuous action (repair, heal, rescue, openGate; mend and dropPallet are allowed)
    haste: 0.10,            // speed x (1 + haste) while protected (not while crawling)
    deepWoundS: 20,         // endurance absorbs a downing hit -> injured + Deep Wound; timer expiry downs (paused while mending)
    mendS: 12,              // self-mend clears Deep Wound; progress persists
  },

  antiCamp: {               // "Resolve" anti-camp self-unhook. [S] = sourced (patch notes / wiki), [A] = assumed model
    enabled: true,
    radius: 20,             // [S] meter fills only while the hunter is within this of the hook
    nearM: 4,               // [A] full proximity factor (1) within this ...
    farFactor: 0.25,        // [A] ... linearly down to this at `radius`, 0 beyond   ([S] closer = faster)
    baseFullS: 100,         // [A] seconds to fill at factor 1 (tuned: face-camp ~33 s incl. grace, kick-and-leave ~0)
    timeMult: [[10, 1], [20, 2], [Infinity, 4]], // [S] by continuous camping seconds: 1x <10 s, 2x 10-20 s, 4x beyond
    campResetS: 5,          // [A] camping time resets after the hunter has been out of range this long
    stageCurve: 3,          // [A] stage factor 1 + stageCurve * f^2, f = elapsed fraction of the current hook stage (user: late = fast)
    graceS: 7,              // [S] every hook event pauses ALL hooked survivors' meters for this long
    mateRadius: 8,          // [A] any other non-hooked survivor this close to the hook stops the meter ([S] nearby survivors slow/stop it)
    chaseRadius: 16,        // [A] no fill while the hunter sees a standing survivor within this (in chase) or is carrying
    selfUnhookS: 1.5,       // [S] full meter => guaranteed self-unhook after this (hook timer paused); normal unhook result
  },

  chase: {                  // [A] engine-level chase state (survivor HUD `chased`, self.chased, hunter obs.chase)
    startRange: 20,         // m: starts when the hunter sees the survivor within this AND moves toward them (> 1 m/s) or swings at them
    loseS: 6,               // ends after the hunter hasn't seen the target for this long (or the target is downed/hooked)
    approachSpeed: 1,       // m/s: hunter velocity component toward the survivor needed to start a chase
  },

  spawn: {
    groupRadius: 15,        // m: the 4 survivors spawn within this (pairwise and path distance from the anchor)
    minSep: 3,              // m: minimum pairwise distance between survivors at spawn
    hunterMinFrac: 0.8,     // hunter candidates eligible if path dist from the anchor >= this x farthest inset walkable cell
    edgeInset: 4,           // m: fallback hunter spawn must be at least this far inside the outline
  },

  hooks: {
    stageS: 60,             // 1st hook: stage1 60 s -> stage2 60 s -> dead. 2nd hook starts in stage 2. 3rd hook = dead.
    maxHooks: 3,
  },

  gates: {
    leverS: 20,             // hold lever; one survivor per lever at a time; progress persists on the gate
    endgameS: 120,          // endgame collapse: starts when the FIRST gate is OPENED (not at power-up); survivors left die
    exitReach: 1.0,         // m to reach `exit` point
  },

  windowBlock: {            // genre-style anti-infinite: N survivor vaults through one window within withinS blocks it for survivors
    vaults: 3,              // per survivor, per window
    withinS: 60,            // approximates "in one chase"
    blockS: 30,             // wiki: 30 s, only for that survivor
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
