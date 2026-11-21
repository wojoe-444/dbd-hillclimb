// Map pools: --map can be a single map JSON, a directory of variants, or an index.json listing them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// onMapBytes can fingerprint the variant files in the exact order used for seed selection.
export function loadMapPool(path, onMapBytes) {
  const load = (f) => {
    const bytes = readFileSync(f);
    onMapBytes?.(bytes);
    return JSON.parse(bytes.toString('utf8'));
  };
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
    return files.map((f) => load(join(path, f)));
  }
  const bytes = readFileSync(path);
  const j = JSON.parse(bytes.toString('utf8'));
  if (basename(path) === 'index.json' || Array.isArray(j.variants)) {
    const list = j.variants ?? j;
    return list.map((v) => load(join(dirname(path), typeof v === 'string' ? v : v.file)));
  }
  onMapBytes?.(bytes);
  return [j];
}
