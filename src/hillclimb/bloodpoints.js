// Bloodpoint-style scoring (pilot-phase fitness). Values copied from the community wiki's general Score Events
// (deadbydaylight.wiki.gg/wiki/Score_Events), mapped onto the events our engine has. Each category is capped at
// 10,000 BP, so a perfect match is 40,000 BP per player. Events the sim doesn't model (skill checks, chests, totems,
// lockers, flashlights, perks) are omitted.
//
// survivorBP = mean over the 4 survivors of their own BP (one parameter set plays all four, so the team average is
// what that parameter set "earns"). hunterBP = the hunter's BP. Both are also given normalised to [0,1] (/ 40,000).

export const CAP = 10000;
export const MAX = 4 * CAP;

export const BP = {
  survivor: {
    // Objectives
    repairPerGen: 2500,        // Repairs: 25 BP per % of a generator (own contribution, net of the efficiency penalty)
    leverPerSecond: 100,       // Unlocking: 20 BP per % of a 20 s lever
    // Survival
    survived: 7000,            // escaped the trial
    hookEscape: 1500,          // self-unhook (anti-camp Resolve)
    graspEscape: 1250,         // wiggled free
    palletDrop: 200,
    fullyMended: 100,
    // Altruism
    heal: 750,                 // per health state healed (7.5 BP per %)
    rescue: 1000,              // before all gens
    rescueAfterGens: 1500,     // gates powered
    rescueEndgame: 2000,       // endgame collapse running
    safeRescue: 1250,          // rescued survivor not hit within safeRescueS
    safeRescueS: 10,
    // Boldness
    chasedPerSecond: 50,
    // --- our deviations (chase splitting): reward taking a real chase, not dipping into someone else's ---
    chaseRampS: 8,             // the first 8 s of any chase earn no 'chased' points
    chaseEscapeMinS: 15,       // 'escaped the chase' bonus only for chases at least this long
    chaseShare: 0.5,           // while chased, earn this share of the objective BP teammates make (Boldness)
    chaseEscapeFirst: 750,     // losing the hunter
    chaseEscapeLater: 375,
    vaultInChase: 100, vaultInChaseCap: 1500,
    stun: 500,                 // pallet stun
  },
  hunter: {
    // Brutality
    hit: 300, damageGen: 100, destruction: 100,
    // Deviousness
    bleedOut: 50, noOneEscaped: 2500,
    // Hunter
    chaseFirst60PerSecond: 10, chaseAfterPerSecond: 2,
    survivorFoundFirst4: 500, survivorFoundLater: 250,
    // Sacrifice
    caught: 1000,              // first hook of each survivor
    hooked: 1000,              // each of the first three hooks
    entitySummoned: 250,       // a hooked survivor enters stage 2 (incl. a 2nd hook, which starts there)
    sacrifice: 250,            // hooked survivor dies on the hook
    lateHook: 250,             // hook while the endgame collapse runs
    timesUp: 250,              // per survivor killed by the endgame collapse
  },
};

const cap = (v) => Math.min(CAP, v);

/** Score a match result (needs result.events and result.survivors[].repairC/leverS). */
export function scoreBloodpoints(res) {
  const S = BP.survivor, K = BP.hunter;
  const ev = res.events || [];
  const end = res.durationS;
  const gatesT = ev.find((e) => e.type === 'gatesPowered')?.t ?? Infinity;
  const egcT = ev.find((e) => e.type === 'endgame')?.t ?? Infinity;

  const surv = [0, 1, 2, 3].map(() => ({ obj: 0, survival: 0, altruism: 0, boldness: 0, chaseEsc: 0, vaultBP: 0 }));
  const hun = { brutality: 0, deviousness: 0, hunter: 0, sacrifice: 0 };

  // chase share: objective BP (repair + lever) teammates earned while survivor i was the chased one (from the worker)
  if (res.chaseShareObj) res.chaseShareObj.forEach((v, i) => { surv[i].boldness += S.chaseShare * v; });
  res.survivors.forEach((s, i) => {
    surv[i].obj += (s.repairC ?? 0) * S.repairPerGen + (s.leverS ?? 0) * S.leverPerSecond;
    if (s.outcome === 'escaped') surv[i].survival += S.survived;
  });

  const chaseOpen = {};           // who -> start time
  const lastLen = {};             // who -> length of their last closed chase
  let chases = 0;
  const firstHooked = new Set();
  const hits = ev.filter((e) => e.type === 'hit');
  const closeChase = (who, t) => {
    const len = Math.max(0, t - chaseOpen[who]);
    surv[who].boldness += Math.max(0, len - S.chaseRampS) * S.chasedPerSecond;
    lastLen[who] = len;
    hun.hunter += Math.min(60, len) * K.chaseFirst60PerSecond + Math.max(0, len - 60) * K.chaseAfterPerSecond;
    delete chaseOpen[who];
  };

  for (const e of ev) {
    switch (e.type) {
      case 'chaseStart':
        chaseOpen[e.who] = e.t;
        hun.hunter += chases < 4 ? K.survivorFoundFirst4 : K.survivorFoundLater;
        chases++;
        break;
      case 'chaseEnd':
        if (chaseOpen[e.who] !== undefined) closeChase(e.who, e.t);
        if (e.reason === 'lost' && (lastLen[e.who] ?? 0) >= S.chaseEscapeMinS) { surv[e.who].boldness += surv[e.who].chaseEsc ? S.chaseEscapeLater : S.chaseEscapeFirst; surv[e.who].chaseEsc++; }
        break;
      case 'vault':
        if (e.chased && surv[e.who].vaultBP < S.vaultInChaseCap) { surv[e.who].vaultBP += S.vaultInChase; surv[e.who].boldness += S.vaultInChase; }
        break;
      case 'palletDrop':
        surv[e.by].survival += S.palletDrop;
        if (e.stun) surv[e.by].boldness += S.stun;
        break;
      case 'selfUnhook': surv[e.who].survival += S.hookEscape; break;
      case 'wiggle': surv[e.who].survival += S.graspEscape; break;
      case 'mend': surv[e.who].survival += S.fullyMended; break;
      case 'heal': surv[e.by].altruism += S.heal; break;
      case 'rescue': {
        surv[e.by].altruism += e.t >= egcT ? S.rescueEndgame : e.t >= gatesT ? S.rescueAfterGens : S.rescue;
        const hitSoon = hits.some((h) => h.who === e.who && h.t > e.t && h.t <= e.t + S.safeRescueS);
        if (!hitSoon && e.t + S.safeRescueS <= end) surv[e.by].altruism += S.safeRescue;
        break;
      }
      // ---- hunter ----
      case 'hit': hun.brutality += K.hit; break;
      case 'genKick': hun.brutality += K.damageGen; break;
      case 'palletBreak': hun.brutality += K.destruction; break;
      case 'hook':
        if (e.count <= 3) hun.sacrifice += K.hooked;
        if (!firstHooked.has(e.who)) { firstHooked.add(e.who); hun.sacrifice += K.caught; }
        if (e.stage === 2) hun.sacrifice += K.entitySummoned;
        if (e.t >= egcT) hun.sacrifice += K.lateHook;
        break;
      case 'hookStage': if (e.stage === 2) hun.sacrifice += K.entitySummoned; break;
      case 'death':
        if (e.cause === 'bleedout') hun.deviousness += K.bleedOut;
        else if (e.cause === 'hookDeath' || e.cause === 'hook3' || e.cause === 'lastHook') hun.sacrifice += K.sacrifice;   // any death on the hook
        else if (e.cause === 'endgame') hun.sacrifice += K.timesUp;
        break;
      default: break;
    }
  }
  for (const who of Object.keys(chaseOpen)) closeChase(+who, end);
  if (res.escapes === 0) hun.deviousness += K.noOneEscaped;

  const survTotals = surv.map((c) => cap(c.obj) + cap(c.survival) + cap(c.altruism) + cap(c.boldness));
  const survivorBP = survTotals.reduce((a, b) => a + b, 0) / 4;
  const hunterBP = cap(hun.brutality) + cap(hun.deviousness) + cap(hun.hunter) + cap(hun.sacrifice);
  const avgCat = (k) => surv.reduce((a, c) => a + cap(c[k]), 0) / 4;
  return {
    survivorBP, hunterBP,
    survivorFit: survivorBP / MAX, hunterFit: hunterBP / MAX,
    survivorCats: { objectives: avgCat('obj'), survival: avgCat('survival'), altruism: avgCat('altruism'), boldness: avgCat('boldness') },
    hunterCats: { brutality: cap(hun.brutality), deviousness: cap(hun.deviousness), hunter: cap(hun.hunter), sacrifice: cap(hun.sacrifice) },
  };
}
