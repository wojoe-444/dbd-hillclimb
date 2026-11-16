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
