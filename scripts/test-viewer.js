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
const duelViewer = new URL('../viewer/duel.js', import.meta.url);
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

async function startHarness(page, { inputs, checked, files }) {
  const elements = new Map(), staticMaps = [], replays = [], delayed = new Map(), requests = [], storage = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: inputs[id] ?? '', checked: checked.includes(id), children: [],
      style: { setProperty: noop }, classList: { toggle: noop, remove: noop },
      addEventListener: noop, insertAdjacentHTML: noop,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    });
    return elements.get(id);
  };
  const response = (data) => ({ ok: data != null, json: async () => data, text: async () => data });
  const resources = new Map(files);
  const mapData = (path) => JSON.parse(readFileSync(new URL('../' + path, page), 'utf8'));
  const fetch = async (path) => {
    requests.push(path);
    if (delayed.has(path)) {
      const promise = delayed.get(path);
      delayed.delete(path);
      return promise;
    }
    if (resources.has(path)) return response(resources.get(path));
    return response(path.startsWith('../maps/') ? mapData(path.slice(3)) : undefined);
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
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    addEventListener: noop, ResizeObserver: class { observe() {} }, requestAnimationFrame: noop,
    setInterval: (fn, ms) => { assert.equal(ms, 30_000); poll = fn; },
  });
  const stubs = {
    './scene.js': { createScene: () => ({
      buildStatic: (map) => staticMaps.push(map.id),
      buildDynamic: (match, map) => replays.push({ match, map }),
      sync: noop, setTopDown: noop,
    }), survCss: [], stateNames: ['healthy', 'injured'] },
    './layers.js': { createLayers: () => ({ onChange: noop, isOn: () => false, rebuild: noop, update: noop }) },
  };
  context.window = context;
  const mod = new SourceTextModule(readFileSync(page, 'utf8'), { context, identifier: page.href });
  await mod.link(async (specifier) => {
    const exports = stubs[specifier] ?? await import(new URL(specifier, page));
    const values = specifier === './charts.js' ? { ...exports, attachHover: noop } : exports;
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await mod.evaluate();
  return { el, staticMaps, replays, latest: () => replays.at(-1), mapData, delay, poll, requests, storage };
}

async function startViewer({ settings = goalSettings, mapList = [baseMap, variant0, variant1, smallMap], files = [] } = {}) {
  const v = await startHarness(viewer, {
    inputs: { run: 'legacy', seed: '1', gen: '0' },
    checked: ['useChamp'],
    files: [
      ['/api/runs', [{ name: 'legacy', kind: 'climb' }, { name: 'goal', kind: 'evolve' }]],
      ['/api/maps', mapList],
      [legacyLog, jsonl({ gen: 5, champ: champ(paramBrains) })],
      [goalLog, jsonl(goalRow(10, 0))],
      [goalConfig, settings],
      ...files,
    ],
  });
  const { el } = v;
  return {
    ...v,
    selectMap: (path) => { el('map').value = path; return el('map').onchange(); },
    selectRun: (name) => { el('run').value = name; return el('run').onchange(); },
    selectSeed: (seed) => { el('seed').value = String(seed); return el('seed').onchange(); },
  };
}

function startDuel(runs, files = []) {
  return startHarness(duelViewer, {
    inputs: { idx: '0', setup: '0', seed: '1000', hmode: 'strong', assistAfter: '3', jitter: '0.5', cap: '5' },
    checked: ['pushfix'],
    files: [['/api/runs', runs], ...files],
  });
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

const replayMapId = (v) => v.latest().match.result().mapId;

test('match viewer keeps seed zero and defaults blank or invalid seeds', async () => {
  const v = await startViewer();
  await v.selectSeed('0');
  assert.equal(v.latest().match.seed, 0);
  assert.equal(replayMapId(v), 'gas-heaven-v000');
  for (const input of ['', 'invalid', '1e999']) {
    await v.selectSeed(input);
    assert.equal(v.latest().match.seed, 1);
    assert.equal(replayMapId(v), 'gas-heaven-v001');
  }
});

test('Auto replays a saved Windows map path and manual selections override it', async () => {
  const v = await startViewer({ settings: { ...goalSettings, map: 'C:\\Users\\example\\dbd-hillclimb\\maps\\test-small.json' } });
  assert.equal(replayMapId(v), 'gas-heaven-v001'); // legacy run has no saved map
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'test-small');
  assert.equal(v.latest().map._path, smallMap);
  assert.deepEqual(reflexes(v.latest().match), [0]);
  assert.equal(v.latest().match.cfg.gens.repairS, 65);
  assert.ok(v.requests.includes('../' + smallMap));
  assert.doesNotMatch(v.requests.join('\n'), /Users|example/);

  await v.selectMap(variant0);
  assert.equal(replayMapId(v), 'gas-heaven-v000');
  await v.selectRun('legacy');
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'gas-heaven-v000');
  await v.selectMap('auto');
  assert.equal(replayMapId(v), 'test-small');
});

test('Auto sorts direct JSON children of a saved pool directory like the CLI', async () => {
  const custom = 'maps/gas-heaven/custom.json';
  const nested = 'maps/gas-heaven/nested/map.json';
  const customMap = JSON.parse(readFileSync(new URL('../' + smallMap, viewer), 'utf8'));
  const v = await startViewer({
    settings: { ...goalSettings, map: '/home/example/dbd-hillclimb/maps/gas-heaven/' },
    mapList: [baseMap, variant1, nested, variant0, custom, smallMap],
    files: [['../' + custom, customMap]],
  });
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'gas-heaven-v000'); // seed 1 of [custom, v000, v001]
  await v.selectSeed(2);
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  await v.selectSeed(3);
  assert.equal(replayMapId(v), 'test-small');
  assert.equal(v.latest().map._path, custom);
  assert.ok(!v.requests.includes('../' + nested));
});

test('Auto uses explicit index order and keeps duplicate entries and string or object references', async () => {
  const index = 'maps/pools/index.json';
  const entries = ['../gas-heaven/v001.json', { file: '../test-small.json' }, '../gas-heaven/v001.json', { file: '../gas-heaven/v000.json' }];
  const v = await startViewer({ settings: { ...goalSettings, map: './' + index }, files: [['../' + index, entries]] });
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'test-small');
  await v.selectSeed(2);
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  await v.selectSeed(3);
  assert.equal(replayMapId(v), 'gas-heaven-v000');
  await v.selectSeed(4);
  assert.equal(replayMapId(v), 'gas-heaven-v001');
});

test('Auto accepts a named manifest with a variants array', async () => {
  const manifest = 'maps/replay-pool.json';
  const v = await startViewer({
    settings: { ...goalSettings, map: manifest },
    mapList: [variant0, variant1, baseMap, smallMap, manifest],
    files: [['../' + manifest, { variants: ['gas-heaven/v001.json', { file: 'test-small.json' }] }]],
  });
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'test-small');
});

test('Auto reports unavailable historical maps without fetching or displaying host paths', async () => {
  const v = await startViewer({ settings: { ...goalSettings, map: 'D:/private/historical/test-small.json' } });
  assert.doesNotMatch(v.el('hud').innerHTML, /map unavailable/);
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  assert.match(v.el('hud').innerHTML, /Saved run map unavailable\. Playing on Gas Heaven\./);
  assert.doesNotMatch(v.el('hud').innerHTML, /private|historical/);
  assert.doesNotMatch(v.requests.join('\n'), /private|historical|test-small/);
  await v.selectMap(smallMap);
  assert.equal(replayMapId(v), 'test-small');
  assert.doesNotMatch(v.el('hud').innerHTML, /map unavailable/);
});

test('Auto falls back as a whole when an explicit pool refers outside the map catalog', async () => {
  const index = 'maps/pools/index.json';
  const v = await startViewer({
    settings: { ...goalSettings, map: index },
    files: [['../' + index, { variants: ['../../private/other.json', '../test-small.json'] }]],
  });
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  assert.match(v.el('hud').innerHTML, /map unavailable/);
  assert.doesNotMatch(v.requests.join('\n'), /private|test-small/);
});

test('Auto warns when the available directory pool differs in size from the saved pool', async () => {
  const v = await startViewer({ settings: { ...goalSettings, map: 'maps/gas-heaven', mapPool: { n: 3 } } });
  await v.selectRun('goal');
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  assert.match(v.el('hud').innerHTML, /map unavailable/);
});

test('Auto still honors a saved file without a Gas Heaven pool and reports a failed map fetch', async () => {
  const v = await startViewer({ settings: { ...goalSettings, map: smallMap }, mapList: [baseMap, smallMap] });
  const completeMap = v.delay('../' + smallMap);
  const replay = v.selectRun('goal');
  await setImmediate();
  completeMap(null);
  await replay;
  assert.equal(v.latest().map._path, baseMap);
  assert.match(v.el('hud').innerHTML, /map unavailable/);

  await v.el('restart').onclick();
  assert.equal(replayMapId(v), 'test-small');
  assert.doesNotMatch(v.el('hud').innerHTML, /map unavailable/);
});

test('a late index response cannot load its map or replace a replay for a newer selection', async () => {
  const index = 'maps/pools/index.json';
  const v = await startViewer({ settings: { ...goalSettings, map: index } });
  const completeIndex = v.delay('../' + index);
  const older = v.selectRun('goal');
  await setImmediate();
  assert.ok(v.requests.includes('../' + index));
  await v.selectRun('legacy');
  const latest = v.latest();
  completeIndex(['../test-small.json']);
  await older;
  assert.equal(v.latest(), latest);
  assert.equal(replayMapId(v), 'gas-heaven-v001');
  assert.ok(!v.requests.includes('../' + smallMap));
  assert.doesNotMatch(v.el('hud').innerHTML, /map unavailable/);
});

test('a late duel champion cannot replace the current restart, timeline or UI', async () => {
  const v = await startDuel([{ name: 'A' }, { name: 'B' }]);
  const completeA = v.delay('../runs/A/champions.json');
  const completeB = v.delay('../runs/B/champions.json');
  v.el('params').value = 'A';
  const older = v.el('params').onchange();

  v.el('params').value = 'B';
  v.el('seed').value = '0';
  v.el('setup').value = '4';
  v.el('hmode').value = 'assist';
  const newer = v.el('params').onchange();
  completeB({ champ: champ(paramBrains), modifiers: { genSeconds: 65 } });
  await newer;
  const latest = v.latest();
  const timeline = v.el('result').innerHTML;
  const form = v.storage.get('dbdv.duel.form');
  assert.equal(latest.match.survivors[0].st, 1);
  v.el('scrub').value = '3';
  v.el('scrub').oninput();

  completeA({ champ: champ(paramBrains), modifiers: { genSeconds: 80 } });
  await older;
  assert.equal(v.el('params').value, 'B');
  assert.equal(v.latest().match.cfg.gens.repairS, 65);
  assert.equal(v.latest(), latest);
  assert.equal(v.replays.length, 2);
  assert.equal(v.el('result').innerHTML, timeline);
  assert.equal(v.storage.get('dbdv.duel.form'), form);
  assert.match(v.el('modBadge').innerHTML, /gens 65 s/);
  assert.equal(latest.match.seed, 0);
  assert.match(v.el('hud').innerHTML, /inside\/injured.*seed 0.*assist/);
  assert.equal(latest.match.tick, 3);

  v.el('scrub').value = '1';
  v.el('scrub').oninput();
  assert.equal(v.latest().match.tick, 1);
  assert.equal(v.latest().match.seed, 0);
  assert.equal(v.latest().match.cfg.gens.repairS, 65);
});

test('duel restarts use a single form snapshot and encode the run name', async () => {
  const name = 'challenge #50%';
  const path = '../runs/challenge%20%2350%25/champions.json';
  const v = await startDuel([{ name, modifiers: { genSeconds: 55 } }]);
  const complete = v.delay(path);
  v.el('params').value = name;
  v.el('seed').value = '42';
  const replay = v.el('params').onchange();
  v.el('seed').value = '43'; // edit without starting a new duel
  v.el('setup').value = '4';
  complete({ champ: champ(paramBrains) });
  await replay;

  assert.ok(v.requests.includes(path));
  assert.equal(v.el('err').textContent, '');
  assert.equal(v.latest().match.seed, 42);
  assert.equal(v.latest().match.survivors[0].st, 0);
  assert.equal(v.latest().match.cfg.gens.repairS, 55);
  const form = JSON.parse(v.storage.get('dbdv.duel.form'));
  assert.equal(form.seed, '42');
  assert.equal(form.setup, '0');
});

test('duel viewer defaults blank or invalid seeds', async () => {
  const v = await startDuel([]);
  for (const input of ['', 'invalid', '1e999']) {
    v.el('seed').value = input;
    await v.el('seed').onchange();
    assert.equal(v.latest().match.seed, 1000);
  }
});
