// Brain registry. Each entry: { space: {name:[min,max,default]}, make(params) -> brainFactory }.
// Add new hand-written brains here (an empty space {} means "no tunable knobs").
import { hunterSpace, makeHunter } from './hunter.js';
import { survivorSpace, makeSurvivor } from './survivor.js';
import { survivorCtxSpace, makeSurvivorCtx } from './survivor-ctx.js';
import { hunterBrain as testHunter, survivorBrain as testSurvivor } from '../sim/testbrains.js';

export const hunters = {
  param: { space: hunterSpace, make: makeHunter },
  test: { space: {}, make: () => testHunter },
};
export const survivors = {
  param: { space: survivorSpace, make: makeSurvivor },
  ctx: { space: survivorCtxSpace, make: makeSurvivorCtx },   // research: param + context-conditioned knobs (survivor-ctx.js)
  test: { space: {}, make: () => testSurvivor },
};

export function getBrains(hunterName = 'param', survivorName = 'param') {
  const hunter = hunters[hunterName], survivor = survivors[survivorName];
  if (!hunter) throw new Error(`unknown hunter brain ${hunterName}`);
  if (!survivor) throw new Error(`unknown survivor brain ${survivorName}`);
  return { hunter, survivor };
}
