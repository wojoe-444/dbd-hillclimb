// Run with node --experimental-vm-modules --test scripts/test-viewer.js.
// Exercise the viewer's event handlers and real sim with a minimal DOM and a fake renderer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const viewer = new URL('../viewer/main.js', import.meta.url);
const source = readFileSync(viewer, 'utf8');
const baseMap = 'maps/gas-heaven.json', variant0 = 'maps/gas-heaven/v000.json', variant1 = 'maps/gas-heaven/v001.json';
const smallMap = 'maps/test-small.json';
const goalBrains = getBrains('param', 'goal'), paramBrains = getBrains();
function champ(brains, survivor = {}) {
  return { hunter: defaults(brains.hunter.space), survivor: { ...defaults(brains.survivor.space), ...survivor } };
}
function goalRow(gen, reflex) {
  const params = champ(goalBrains, { [`r${reflex}_on`]: 1 });
  return {
    gen,
    hunters: { ranking: [{ id: 'hunter', params: params.hunter }], knobs: {} },
    survivors: { ranking: [{ id: 'survivor', params: params.survivor }], knobs: {} },
  };
}
const jsonl = (...rows) => rows.map((row) => JSON.stringify(row)).join('\n');
const legacyLog = '../runs/legacy/meta.jsonl', goalLog = '../runs/goal/evo.jsonl';
const goalConfig = '../runs/goal/config.json';
const goalSettings = { hunterBrain: 'param', survivorBrain: 'goal', modifiers: { genSeconds: 65 } };
const noop = () => {};

async function startViewer() {
  const elements = new Map(), staticMaps = [], replays = [], delayed = new Map();
  const inputs = { run: 'legacy', seed: '1', gen: '0' };
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: inputs[id] ?? '', checked: id === 'useChamp',
      style: { setProperty: noop }, classList: { toggle: noop, remove: noop },
      addEventListener: noop, insertAdjacentHTML: noop,
    });
    return elements.get(id);
  };
  const response = (data) => ({ ok: data != null, json: async () => data, text: async () => data });
  const resources = new Map([
    ['/api/runs', [{ name: 'legacy', kind: 'climb' }, { name: 'goal', kind: 'evolve' }]],
    ['/api/maps', [baseMap, variant0, variant1, smallMap]],
    [legacyLog, jsonl({ gen: 5, champ: champ(paramBrains) })],
    [goalLog, jsonl(goalRow(10, 0))],
    [goalConfig, goalSettings],
  ]);
  const mapData = (path) => JSON.parse(readFileSync(new URL('../' + path, viewer), 'utf8'));
  const fetch = async (path) => {
    if (delayed.has(path)) {
      const promise = delayed.get(path);
      delayed.delete(path);
      return promise;
    }
    return response(path.startsWith('../maps/') ? mapData(path.slice(3)) : resources.get(path));
  };
  const delay = (path) => {
    let complete;
    const promise = new Promise((resolve) => { complete = resolve; });
    delayed.set(path, promise);
    return (data) => complete(response(data));
  };
  let poll;
  const context = createContext({
    fetch, performance, console, innerWidth: 1200, innerHeight: 800,
    document: { getElementById: el, body: el('body'), querySelectorAll: () => [], hidden: false, addEventListener: noop },
    addEventListener: noop, ResizeObserver: class { observe() {} }, requestAnimationFrame: noop,
    setInterval: (fn, ms) => { assert.equal(ms, 30_000); poll = fn; },
  });
  const stubs = {
    './scene.js': { createScene: () => ({
      buildStatic: (map) => staticMaps.push(map.id),
      buildDynamic: (match, map) => replays.push({ match, map }),
      sync: noop, setTopDown: noop,
    }), survCss: [], stateNames: ['healthy', 'injured'] },
    './layers.js': { createLayers: () => ({ onChange: noop, isOn: () => false, rebuild: noop }) },
  };
  context.window = context;
  const mod = new SourceTextModule(source, { context, identifier: viewer.href });
  await mod.link(async (specifier) => {
    const exports = stubs[specifier] ?? await import(new URL(specifier, viewer));
    const values = specifier === './charts.js' ? { ...exports, attachHover: noop } : exports;
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await mod.evaluate();
  return {
    el, staticMaps, replays, latest: () => replays.at(-1), mapData, delay, poll,
    selectRun: (name) => { el('run').value = name; return el('run').onchange(); },
  };
}

const reflexes = (match) => match.survivors[0].brain.debug().goal?.reflexes.map((r) => r.k);

test('run selection commits metadata and config together and ignores an older load', async () => {
  const v = await startViewer();
  const olderConfig = v.delay(goalConfig);
  const older = v.selectRun('goal');
  await setImmediate();
  v.el('gen').oninput();
  assert.equal(v.el('genLabel').textContent, 'gen 5/5');
  assert.equal(v.replays.length, 1);

  const newerMeta = v.delay(goalLog);
  const newerConfig = v.delay(goalConfig);
  await v.selectRun('legacy');
  const newer = v.selectRun('goal');
  newerConfig(goalSettings);
  await setImmediate();
  assert.equal(v.el('genLabel').textContent, 'gen 5/5');
  assert.equal(v.el('modBadge').innerHTML, '');
  newerMeta(jsonl(goalRow(20, 2)));
  await newer;
  assert.equal(v.el('genLabel').textContent, 'gen 20/20');
  assert.match(v.el('modBadge').innerHTML, /gens 65 s/);
  assert.deepEqual(reflexes(v.latest().match), [2]);
  assert.equal(v.latest().match.cfg.gens.repairS, 65);

  olderConfig({ survivorBrain: 'param', modifiers: { genSeconds: 40 } });
  await older;
  assert.equal(v.replays.length, 3);
  assert.equal(v.el('genLabel').textContent, 'gen 20/20');
  assert.match(v.el('modBadge').innerHTML, /gens 65 s/);
});

test('polls apply only to their own selection and preserve a historical generation', async () => {
  const v = await startViewer();
  await v.selectRun('goal');
  const completeStalePoll = v.delay(goalLog);
  const stalePoll = v.poll();
  await v.selectRun('legacy');
  assert.equal(reflexes(v.latest().match), undefined);
  assert.equal(v.latest().match.cfg.gens.repairS, 90);
  await v.selectRun('goal');
  const live = v.latest();
  completeStalePoll(jsonl(goalRow(10, 0), goalRow(11, 1), goalRow(12, 2)));
  await stalePoll;
  assert.equal(v.el('gen').max, 1);

  const completePoll = v.delay(goalLog);
  const poll = v.poll();
  completePoll(jsonl(goalRow(10, 0), goalRow(11, 1)));
  await poll;
  assert.equal(v.el('gen').value, 2);
  v.el('gen').value = '1';
  v.el('gen').oninput();
  const completeNextPoll = v.delay(goalLog);
  const nextPoll = v.poll();
  completeNextPoll(jsonl(goalRow(10, 0), goalRow(11, 1), goalRow(12, 2)));
  await nextPoll;
  assert.equal(v.el('gen').max, 3);
  assert.equal(+v.el('gen').value, 1);
  assert.equal(v.latest(), live);
});

test('a delayed auto map keeps its seed and champions when the picker moves', async () => {
  const v = await startViewer();
  await v.selectRun('goal');
  const completeMap = v.delay('../' + variant0);
  v.el('seed').value = '2';
  const replay = v.el('seed').onchange();
  v.el('seed').value = '3'; // edit without committing a new match
  const completePoll = v.delay(goalLog);
  const poll = v.poll();
  completePoll(jsonl(goalRow(10, 0), goalRow(11, 1)));
  await poll;
  completeMap(v.mapData(variant0));
  await replay;
  const { match, map } = v.latest();
  assert.equal(map._path, variant0);
  assert.equal(match.seed, 2);
  assert.deepEqual(reflexes(match), [0]);
  assert.equal(v.el('genLabel').textContent, 'gen 11/11');
  assert.equal(match.cfg.gens.repairS, 65);
});

test('late map responses cannot rebuild the newer match or scene', async () => {
  const v = await startViewer();
  const completeMap = v.delay('../' + variant0);
  v.el('seed').value = '2';
  const older = v.el('seed').onchange();
  v.el('map').value = smallMap;
  v.el('seed').value = '3';
  await v.el('map').onchange();
  completeMap(v.mapData(variant0));
  await older;
  assert.equal(v.replays.length, 2);
  assert.equal(v.staticMaps.at(-1), 'test-small');
  assert.equal(v.latest().map._path, smallMap);
  assert.equal(v.latest().match.seed, 3);
});

test('switching runs invalidates an in-flight replay and uses current controls after loading', async () => {
  const v = await startViewer();
  const completeMap = v.delay('../' + variant0);
  v.el('seed').value = '2';
  const older = v.el('seed').onchange();
  const completeConfig = v.delay(goalConfig);
  const changeRun = v.selectRun('goal');
  v.el('seed').value = '4';
  await v.el('seed').onchange();

  completeMap(v.mapData(variant0));
  await older;
  assert.equal(v.replays.length, 1);
  assert.equal(v.latest().map._path, variant1);
  completeConfig(goalSettings);
  await changeRun;
  assert.equal(v.replays.length, 2);
  assert.equal(v.latest().map._path, variant0);
  assert.equal(v.latest().match.seed, 4);
  assert.deepEqual(reflexes(v.latest().match), [0]);
});

test('replays use the saved goal brain with either champion or default parameters', async () => {
  const v = await startViewer();
  assert.equal(reflexes(v.latest().match), undefined);
  await v.selectRun('goal');
  assert.deepEqual(reflexes(v.latest().match), [0]);
  v.el('useChamp').checked = false;
  await v.el('restart').onclick();
  assert.deepEqual(reflexes(v.latest().match), []);
  assert.equal(v.latest().match.cfg.gens.repairS, 65);
});
