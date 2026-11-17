// Game modifiers: named rule overrides layered on top of the standard config (config.js), e.g. faster generators
// to give survivors an easier game and denser training signal. A modifier set is a plain object
// { name: value } (e.g. { genSeconds: 80 }); the empty set {} is the standard game.
//
// Adding a modifier = one REGISTRY line: the standard value, a short label for the viewer badge, and the config
// override it expands to. Keep the override self-consistent (e.g. genSeconds changes gens.repairS, the solo repair
// time in charges; kick loss / regression / cancel thresholds are fractions or rates of it, so they follow along).
//
// CLI: every match-running script accepts `--mod name=value` (repeatable, or a comma list: --mod a=1,b=2).
// Pure module (no node imports): the viewer imports it too.
import { deepMerge } from './config.js';

export const REGISTRY = {
  genSeconds: { std: 90, label: (v) => `gens ${v} s`, config: (v) => ({ gens: { repairS: v } }) },
  // future modifiers, one line each, e.g.
  // hookStageS: { std: 70, label: (v) => `hook stage ${v} s`, config: (v) => ({ hooks: { stageS: v } }) },
  // survivorSpeed: { std: 4.0, label: (v) => `surv run ${v} m/s`, config: (v) => ({ survivor: { runSpeed: v } }) },
};

/** Validate + canonicalise a modifier set: known names only, finite numbers, standard values dropped, keys sorted. */
export function normalizeMods(mods) {
  const out = {};
  for (const k of Object.keys(mods ?? {}).sort()) {
    const def = REGISTRY[k];
    if (!def) throw new Error(`unknown game modifier '${k}' (known: ${Object.keys(REGISTRY).join(', ')})`);
    const v = Number(mods[k]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`game modifier ${k}=${mods[k]}: expected a positive number`);
    if (v !== def.std) out[k] = v;
  }
  return out;
}

/** Parse 'a=1,b=2' strings (or an array of them) into a normalised modifier set. */
export function parseMods(specs) {
  const out = {};
  for (const spec of [].concat(specs ?? [])) {
    for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(part);
      if (!m) throw new Error(`--mod ${part}: expected name=value`);
      out[m[1]] = m[2];
    }
  }
  return normalizeMods(out);
}

/** Every `--mod X` / `--mod=X` occurrence in an argv array (independent of each script's own arg parser). */
export function modsFromArgv(argv = process.argv.slice(2)) {
  const specs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mod' && argv[i + 1] !== undefined) specs.push(argv[++i]);
    else if (argv[i].startsWith('--mod=')) specs.push(argv[i].slice(6));
  }
  return parseMods(specs);
}

export const isStandard = (mods) => Object.keys(normalizeMods(mods)).length === 0;

/** The config override a modifier set expands to ({} for the standard game). */
export function modsConfig(mods) {
  let cfg = {};
  for (const [k, v] of Object.entries(normalizeMods(mods))) cfg = deepMerge(cfg, REGISTRY[k].config(v));
  return cfg;
}

/** Merge a modifier set over an existing config override (modifiers win). */
export const withMods = (config, mods) => deepMerge(config ?? {}, modsConfig(mods));

/** Human label, e.g. 'gens 80 s' ('' for standard). */
export const describeMods = (mods) => Object.entries(normalizeMods(mods)).map(([k, v]) => REGISTRY[k].label(v)).join(', ');

/** Canonical key for comparing two modifier sets. */
export const modsKey = (mods) => JSON.stringify(normalizeMods(mods));

/** Fields to record in run files: { modifiers, standard }. */
export const modsRecord = (mods) => { const m = normalizeMods(mods); return { modifiers: m, standard: Object.keys(m).length === 0 }; };

/** Read the modifier set of a run's config.json / champions.json object (missing = standard, for older runs). */
export const modsOf = (rec) => normalizeMods(rec?.modifiers ?? {});
