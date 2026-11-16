// Hunter reward (user table, out of 100). Replaces bloodpoints as the hunter's fitness; survivors stay on bloodpoints.
//   4k (all four survivors dead): 100 with no gens completed, minus 1 per completed gen (95 with all gens done).
//   otherwise: hook stages consumed across all survivors -> 0 stages = 0, 1 = 10, then +8 per stage (11 stages = 90).
// A survivor's consumed stages are the engine's stage accounting (max 3); a dead survivor counts as 3.
export function hookStagesTotal(res) {
  return res.survivors.reduce((a, s) => a + (s.outcome === 'dead' ? 3 : Math.min(3, s.hookStages ?? 0)), 0);
}

export function hunterTableScore(res) {
  const dead = res.survivors.filter((s) => s.outcome === 'dead').length;
  if (dead === 4) return 100 - Math.min(5, res.gensDone);
  const st = Math.min(11, hookStagesTotal(res));
  return st === 0 ? 0 : 10 + 8 * (st - 1);
}

// Survivor survival score with a time gradient (user-approved 2026-11-16): 1 - (hook stages held, integrated over time)
// / (12 x horizon). A survivor's stage count steps up at each hook / struggle event and goes to 3 at death; after the
// match ends it stays at its final value (dead = 3, per hookStagesTotal) until the horizon, while an escaped survivor
// drops to 0 from the moment it escapes. So a 4k at 900 s scores better than a 4k at 300 s, and an escape beats both.
export function survivalTimeScore(res, horizonS = 1200) {
  const H = Math.max(horizonS, res.durationS || 0);
  const ev = res.events || [];
  let burden = 0;
  res.survivors.forEach((s, i) => {
    let stage = 0, last = 0, acc = 0, escT = null;
    for (const e of ev) {
      if (e.who !== i) continue;
      let next = null;
      if (e.type === 'hook' || e.type === 'hookStage') next = Math.min(3, e.stage);
      else if (e.type === 'death') next = 3;
      else if (e.type === 'escape') { escT = e.t; break; }
      if (next !== null && next !== stage) { acc += stage * (e.t - last); stage = next; last = e.t; }
    }
    if (escT !== null) { acc += stage * (escT - last); }
    else {
      const end = res.durationS || last;
      acc += stage * (end - last);
      const tail = s.outcome === 'dead' ? 3 : Math.min(3, Math.max(stage, s.hookStages ?? 0));
      acc += tail * (H - end);
    }
    burden += acc;
  });
  return Math.max(0, Math.min(1, 1 - burden / (12 * H)));
}
