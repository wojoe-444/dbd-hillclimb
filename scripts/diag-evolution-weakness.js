// Read completed v14/v15 logs only. --runs may point at the main checkout's runs directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), root = args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 'runs';
const result = {};
const avg = xs => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
for (const run of ['evo-v14', 'evo-v15']) {
  const config = JSON.parse(readFileSync(join(root, run, 'config.json'), 'utf8'));
  const rows = readFileSync(join(root, run, 'evo.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const outcome = slice => Object.fromEntries(Object.keys(rows[0].outcome).map(k => [k, avg(slice.map(r => r.outcome[k]))]));
  const knobs = {};
  for (const [k, first] of Object.entries(rows[0].survivors.knobs)) {
    const space = config.spaces.survivor[k], [lo, hi] = space, range = hi - lo;
    const late = rows.slice(-10).map(r => r.survivors.knobs[k]);
    knobs[k] = { range: space, firstMedian: first.med, lastMedian: rows.at(-1).survivors.knobs[k].med,
      lateMedianMean: avg(late.map(x => x.med)), lateSdMean: avg(late.map(x => x.sd)),
      medianDrift: (rows.at(-1).survivors.knobs[k].med - first.med) / range,
      lateMedianWander: (Math.max(...late.map(x => x.med)) - Math.min(...late.map(x => x.med))) / range,
      lateLowerEdge: avg(late.map(x => x.values.filter(v => v <= lo + range * 0.05).length / x.values.length)),
      lateUpperEdge: avg(late.map(x => x.values.filter(v => v >= hi - range * 0.05).length / x.values.length)),
      lateQ25: avg(late.map(x => x.q25)), lateQ75: avg(late.map(x => x.q75)) };
  }
  result[run] = { generations: rows.length, config, first10: outcome(rows.slice(0, 10)), last10: outcome(rows.slice(-10)), last: rows.at(-1).outcome, knobs };
}
if (args.includes('--out')) writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(result, null, 2));
for (const [run, r] of Object.entries(result)) {
  console.log(run, 'generations', r.generations, 'config', JSON.stringify(Object.fromEntries(Object.entries(r.config).filter(([k]) => k !== 'spaces'))));
  console.log('first10', JSON.stringify(r.first10)); console.log('last10', JSON.stringify(r.last10));
  console.log('| knob | range | initial median | final median | late mean median | late IQR | lower/upper edge % | late median wander % range |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, x] of Object.entries(r.knobs)) console.log(`| ${k} | ${x.range[0]}..${x.range[1]} | ${x.firstMedian.toFixed(2)} | ${x.lastMedian.toFixed(2)} | ${x.lateMedianMean.toFixed(2)} | ${x.lateQ25.toFixed(2)}..${x.lateQ75.toFixed(2)} | ${(100*x.lateLowerEdge).toFixed(0)}/${(100*x.lateUpperEdge).toFixed(0)} | ${(100*x.lateMedianWander).toFixed(0)} |`);
}
