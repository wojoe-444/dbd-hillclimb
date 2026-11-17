// Game-modifier badges for the viewer pages (src/sim/modifiers.js). Standard rules render nothing.
import { describeMods, normalizeMods, modsOf } from '../src/sim/modifiers.js';

export { modsOf };
export const MOD_TINT = '#f59e0b14';   // chart background tint for modified runs
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** safe: unknown modifier names (a run from a newer checkout) still show, raw */
export function modLabel(mods) {
  try { return describeMods(mods); } catch { return Object.entries(mods ?? {}).map(([k, v]) => `${k}=${v}`).join(', '); }
}
export function isModded(mods) {
  try { return Object.keys(normalizeMods(mods)).length > 0; } catch { return Object.keys(mods ?? {}).length > 0; }
}
export const modBadge = (mods, prefix = 'MODIFIED') =>
  isModded(mods) ? `<span class="modbadge" title="non-standard game rules (game modifiers)">${esc(prefix)}: ${esc(modLabel(mods))}</span>` : '';
