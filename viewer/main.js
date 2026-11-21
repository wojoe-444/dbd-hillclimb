// 3D viewer: runs the real 2D sim live in the browser and renders it with Three.js (scene.js), with a resizable
// stats dock (Match | Evolution | Knobs | Map | Champion tabs) and a one-key immersive full-screen mode (F / Esc).
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults, evolutionChampion } from '../src/hillclimb/params.js';
import { scoreBloodpoints } from '../src/hillclimb/bloodpoints.js';
import { hunterTableScore } from '../src/hillclimb/hunterscore.js';
import { createScene, survCss, stateNames } from './scene.js';
import { createLayers } from './layers.js';
import { lineChart, attachHover, histogram, sparkline, prep, fmtNum, CAT, INK, niceCeil } from './charts.js';
import { modsConfig } from '../src/sim/modifiers.js';
import { modBadge, isModded, modLabel, MOD_TINT } from './mods.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const store = { get: (k, d) => { try { const v = localStorage.getItem('dbdv.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('dbdv.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

const baseMapPath = 'maps/gas-heaven.json';
const mapFiles = new Map();
async function loadMapFile(path) {
  if (!mapFiles.has(path)) {
    const response = await fetch('../' + path.split('/').map(encodeURIComponent).join('/'));
    if (!response.ok) throw new Error('Map file unavailable');
    const data = await response.json();
    if (!mapFiles.has(path)) mapFiles.set(path, data);
  }
  return mapFiles.get(path);
}
async function loadMap(path) {
  const data = await loadMapFile(path);
  if (!data?.size) throw new Error('Expected a map');
  data._path = path;
  return data;
}
let map = await loadMap(baseMapPath);
let brains = getBrains();
const variantIndex = await loadMapFile('maps/gas-heaven/index.json').catch(() => null);
const variantInfo = new Map(Array.isArray(variantIndex?.variants) ? variantIndex.variants.map((v) => [v?.id, v]) : []);

// Older runs record absolute paths. Use their maps/ suffix as a checkout-relative path.
function repoMapPath(source) {
  if (typeof source !== 'string') return null;
  const path = source.replaceAll('\\', '/');
  const parts = path.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return null;
  const start = /^(?:[a-z]:)?\//i.test(path) ? parts.indexOf('maps') : 0;
  if (start < 0 || parts[start] !== 'maps') return null;
  const relative = parts.slice(start);
  // Windows can alias path segments with trailing spaces or dots.
  if (relative.some((part) => /[:\0]|[ .]$/.test(part))) return null;
  return relative.join('/');
}

function indexedMapPath(dir, file) {
  if (typeof file !== 'string' || !file || /^[/\\]|[:\0]/.test(file)) return null;
  const parts = dir.split('/');
  for (const part of file.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 1) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

async function savedMapPool(source) {
  const path = repoMapPath(source);
  if (!path) return [];
  const prefix = `${path}/`;
  const children = mapList.filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'));
  if (children.length) return children.sort();

  // The map catalog omits index.json. Explicit indexes use manifest order, including duplicates.
  const isIndex = path.endsWith('/index.json');
  if (!isIndex && !mapPaths.has(path)) return [];
  const data = await loadMapFile(path);
  if (!isIndex && !Array.isArray(data?.variants)) return [path];
  const entries = data?.variants ?? data;
  if (!Array.isArray(entries)) return [];
  const dir = path.slice(0, path.lastIndexOf('/'));
  const pool = entries.map((entry) => indexedMapPath(dir, typeof entry === 'string' ? entry : entry?.file));
  return pool.every((file) => mapPaths.has(file)) ? pool : [];
}

// ---------------------------------------------------------------- 3D
const view = $('view');
const S3 = createScene(view);
const layers = createLayers({ scene3d: S3, panel: $('layerPanel'), storeKey: 'layers.main' });
const syncHeatBox = () => { $('heat').checked = layers.isOn('h-belief'); };
layers.onChange(syncHeatBox); syncHeatBox();
window.__layers = layers;   // console access (layer costs: __layers.costs())

// ---------------------------------------------------------------- layout: dock, tabs, immersive full screen
const body = document.body;
const layout = { pos: store.get('dockPos', 'right'), hidden: store.get('dockHidden', false), w: store.get('dockW', null), h: store.get('dockH', null), tab: store.get('tab', 'match') };
function applyLayout() {
  body.classList.toggle('dock-bottom', layout.pos === 'bottom');
  body.classList.toggle('dock-hidden', layout.hidden);
  const defW = Math.round(Math.min(1100, Math.max(420, innerWidth * 0.36)));
  body.style.setProperty('--dock-w', (layout.w ?? defW) + 'px');
  body.style.setProperty('--dock-h', (layout.h ?? Math.round(innerHeight * 0.42)) + 'px');
  $('dockPos').textContent = layout.pos === 'bottom' ? '⇸' : '⇵';
  store.set('dockPos', layout.pos); store.set('dockHidden', layout.hidden);
  queueRender();
}
function setTab(t) {
  layout.tab = t; store.set('tab', t);
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.classList.toggle('active', b.dataset.tab === t);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('active', p.id === 'pane-' + t);
  if (layout.hidden) { layout.hidden = false; applyLayout(); }
  dirty.evo = dirty.knobs = dirty.champ = dirty.map = true;
  queueRender();
}
for (const b of document.querySelectorAll('#tabs [data-tab]')) b.onclick = () => setTab(b.dataset.tab);
$('dockPos').onclick = () => { layout.pos = layout.pos === 'bottom' ? 'right' : 'bottom'; applyLayout(); };
$('dockHide').onclick = () => { layout.hidden = true; applyLayout(); };
{ // resizer drag
  const rz = $('resizer');
  rz.addEventListener('pointerdown', (ev) => {
    rz.setPointerCapture(ev.pointerId); rz.classList.add('drag');
    const move = (e) => {
      const r = $('main').getBoundingClientRect();
      if (layout.pos === 'bottom') layout.h = Math.round(Math.max(160, Math.min(r.height - 160, r.bottom - e.clientY)));
      else layout.w = Math.round(Math.max(300, Math.min(r.width - 280, r.right - e.clientX)));
      body.style.setProperty(layout.pos === 'bottom' ? '--dock-h' : '--dock-w', (layout.pos === 'bottom' ? layout.h : layout.w) + 'px');
    };
    const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); store.set('dockW', layout.w); store.set('dockH', layout.h); queueRender(); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up, { once: true });
  });
  rz.addEventListener('dblclick', () => { layout.w = layout.h = null; store.set('dockW', null); store.set('dockH', null); applyLayout(); });
}
let immersive = false, idleTimer = 0;
function setImmersive(on) {
  if (on === immersive) return;
  immersive = on;
  body.classList.toggle('immersive', on);
  if (!on && $('layerFloat').classList.contains('show')) { $('layerFloat').classList.remove('show'); $('pane-layers').appendChild($('layerPanel')); }
  if (on) { document.documentElement.requestFullscreen?.().catch(() => {}); poke(); }
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  hud(true);
}
function poke() { body.classList.remove('idle'); clearTimeout(idleTimer); if (immersive) idleTimer = setTimeout(() => body.classList.add('idle'), 2500); }
addEventListener('mousemove', poke);
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && immersive) setImmersive(false); });
$('fsBtn').onclick = () => setImmersive(true);
$('fsBtn2').onclick = () => setImmersive(!immersive);
new ResizeObserver(() => queueRender()).observe($('dock'));

// ---------------------------------------------------------------- per-match tracking (viewer-side stats)
let match = null, track = null, matchSource = null;
function newTrack() {
  return {
    chaseT: [0, 0, 0, 0], chases: [0, 0, 0, 0], hitsTaken: [0, 0, 0, 0], heals: [0, 0, 0, 0], rescues: [0, 0, 0, 0], drops: [0, 0, 0, 0], stunsBy: [0, 0, 0, 0],
    palletBreaks: 0, kicks: 0, hunterChaseT: 0,
    tl: { t: [], gens: [], stages: [], alive: [] }, nextSample: 0, evN: 0, bp: null, bpAt: -Infinity,
  };
}
const stagesNow = (m) => m.survivors.reduce((a, s) => a + (s.outcome === 'dead' || s.st === 5 ? 3 : Math.min(3, s.hookStage)), 0);
function sample() {
  const m = match, tl = track.tl;
  let gp = 0; for (const g of m.gens) gp += g.done ? 1 : Math.min(1, g.p / m.need);
  tl.t.push(m.t); tl.gens.push(gp); tl.stages.push(stagesNow(m)); tl.alive.push(m.survivors.filter((s) => s.st < 5).length);
}
function afterStep() {
  const m = match;
  if (m.chaseTgt >= 0) { track.chaseT[m.chaseTgt] += m.dt; track.hunterChaseT += m.dt; }
  if (m.t >= track.nextSample) { sample(); track.nextSample += 1; }
  const ev = m.events;
  for (; track.evN < ev.length; track.evN++) {
    const e = ev[track.evN];
    switch (e.type) {
      case 'chaseStart': track.chases[e.who]++; break;
      case 'hit': track.hitsTaken[e.who]++; break;
      case 'heal': track.heals[e.by]++; break;
      case 'rescue': track.rescues[e.by]++; break;
      case 'palletDrop': track.drops[e.by]++; if (e.stun) track.stunsBy[e.by]++; break;
      case 'palletBreak': track.palletBreaks++; break;
      case 'genKick': track.kicks++; break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- minimal HUD (both layouts; the only stats in full screen)
const shortState = { healthy: 'healthy', injured: 'injured', downed: 'downed', carried: 'carried', hooked: 'hooked', dead: 'dead', escaped: 'escaped' };
function hunterMode(m) {
  const H = m.hunter, A = H.lastAction || {};
  const actName = { pickup: 'picking up', hook: 'hooking', breakPallet: 'breaking pallet', kickGen: 'kicking gen', drop: 'dropping', openGate: 'opening gate', attack: 'attacking' };
  let mode;
  if (H.stunT > 0) mode = 'stunned';
  else if (H.vault) mode = 'vaulting';
  else if (H.windT > 0) mode = 'lunging';
  else if (H.curAct && actName[H.curAct]) mode = actName[H.curAct] + (H.carrying >= 0 && H.curAct === 'hook' ? ` S${H.carrying}` : '');
  else if (H.carrying >= 0) mode = `carrying S${H.carrying}`;
  else if (H.cdT > 0) mode = 'cooldown';
  else if (m.chaseTgt >= 0) mode = `chasing S${m.chaseTgt}`;
  else mode = A.moveTo ? 'patrolling' : 'idle';
  let target = '—';
  if (m.chaseTgt >= 0) target = `S${m.chaseTgt} (chase)`;
  else if (H.carrying >= 0) target = A.target != null ? `hook ${A.target}` : `S${H.carrying}`;
  else if (A.target != null) target = typeof A.target === 'number' ? `S${A.target}` : String(A.target);
  else if (A.moveTo) target = `→ (${A.moveTo.x.toFixed(0)}, ${A.moveTo.z.toFixed(0)})`;
  return { mode, target };
}
let hudAt = 0;
function hud(force) {
  const now = performance.now();
  if (!force && now - hudAt < 100) return;
  hudAt = now;
  const m = match; if (!m) return;
  const chips = m.survivors.map((s, i) => {
    const st = stateNames[s.st];
    const pips = s.st < 5 && s.hookStage ? ` ${'▮'.repeat(Math.min(3, s.hookStage))}` : '';
    return `<span class="chip"><span class="dot" style="background:${survCss[i]}"></span>S${i} ${shortState[st]}${pips}${m.chaseTgt === i ? ' ⚑' : ''}</span>`;
  }).join('');
  const hm = hunterMode(m);
  const res = m.over ? m.result() : null;
  $('hud').innerHTML = `<div class="top"><span class="clock">${fmtT(m.t)}</span>${modBadge(matchSource.mods)}<span>gens <b>${m.gensDone}/${m.gensNeeded}</b></span>${m.gatesPowered ? `<span><b>GATES</b>${m.endgameT > 0 ? ' ' + fmtT(m.endgameT) : ''}</span>` : ''}${res ? `<span><b>OVER</b> ${res.kills}K / ${res.escapes}E</span>` : ''}${paused ? '<span class="muted">paused</span>' : ''}</div>
    <div class="chips"><span class="chip"><span class="dot" style="background:#d8313b"></span>Hunter ${esc(hm.mode)}</span>${chips}</div>
    ${matchSource.mapWarning ? `<div style="margin-top:4px;color:var(--warn)">${esc(matchSource.mapWarning)}</div>` : ''}
    ${immersive ? `<div class="muted" style="margin-top:4px;font-size:11px">${esc(mapLabel())} · seed ${match.seed} · ${esc(matchSource.genLabel)}</div>` : ''}`;
}
const mapLabel = () => map.id || map._path || '';

// ---------------------------------------------------------------- Match tab
let renderQueued = false;
const dirty = { evo: true, knobs: true, champ: true, map: true };
function queueRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderActive(true); }); }
let lastPane = 0;
function renderActive(force) {
  if (layout.hidden || immersive) return;
  const now = performance.now();
  if (!force && now - lastPane < 200) return;
  lastPane = now;
  if (layout.tab === 'match') renderMatch();
  else if (layout.tab === 'evo' && (force || dirty.evo)) { renderEvo(); dirty.evo = false; }
  else if (layout.tab === 'knobs' && (force || dirty.knobs)) { renderKnobs(); dirty.knobs = false; }
  else if (layout.tab === 'map') renderMap(force || dirty.map);
  else if (layout.tab === 'champ' && (force || dirty.champ)) { renderChamp(); dirty.champ = false; }
}

const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const pips = (n) => `<span class="pips">${[0, 1, 2].map((k) => `<i class="${k < n ? 'on' : ''}"></i>`).join('')}</span>`;
const bar = (p) => `<div class="prog"><i style="width:${Math.round(100 * Math.max(0, Math.min(1, p)))}%"></i></div>`;
function renderMatch() {
  const m = match; if (!m) return;
  // bloodpoints / hunter score from the live events (≈: excludes the evolution worker's chase-share bonus)
  if (performance.now() - track.bpAt > 1000 || m.over) {
    const res = m.result();
    track.bp = { ...scoreBloodpoints(res), hs: hunterTableScore(res), res };
    track.bpAt = performance.now();
  }
  const bp = track.bp, res = bp.res;
  const stages = stagesNow(m);
  $('tiles').innerHTML = [
    tile('Clock', fmtT(m.t), m.over ? `over: ${esc(m.endReason ?? '')}` : m.endgameT > 0 ? `collapse ${fmtT(m.endgameT)}` : m.gatesPowered ? 'gates powered' : paused ? 'paused' : `×${$('speed').value}`),
    tile('Generators', `${m.gensDone}/${m.gensNeeded}`, `${m.gens.length} on map`),
    tile('Hook stages', `${stages}<span class="muted" style="font-size:13px">/12</span>`, `${m.stats.hooks} hooks`),
    tile('Kills · Escapes', `${res.kills} · ${res.escapes}`, `${m.survivors.filter((s) => s.st < 5).length} in trial`),
    tile('Hunter score', `${bp.hs}`, 'table, of 100'),
    tile('Hunter BP', fmtNum(bp.hunterBP), 'live estimate'),
    tile('Survivor BP', fmtNum(bp.survivorBP), 'team avg, est.'),
    tile('Chase', m.chaseTgt >= 0 ? `S${m.chaseTgt}` : '—', m.blTier ? `bloodlust ${m.blTier}` : `${fmtT(track.hunterChaseT)} total`),
  ].join('');
  $('gensBar').innerHTML = m.gens.map((g) => { const p = g.done ? 1 : Math.min(1, g.p / m.need); return `<div class="gen${g.done ? ' done' : ''}" title="${esc(g.id)}"><i style="width:${(p * 100).toFixed(0)}%"></i><span>${g.done ? 'done' : Math.round(p * 100) + '%'}</span></div>`; }).join('');
  m._hudBase();                     // engine's per-tick HUD summary (activity + progress); cached per tick, read-only use
  const hb = m._hudB;
  $('survCards').innerHTML = m.survivors.map((s, i) => {
    const st = stateNames[s.st], e = hb[i];
    const chased = m.chaseTgt === i;
    let act = e.activity ? `${e.activity}${e.activityProgress != null ? ` ${Math.round(100 * e.activityProgress)}%` : ''}` : s.vault ? 'vaulting' : (s.vx || s.vz) ? 'moving' : 'still';
    if (s.st >= 5) act = s.st === 5 ? `dead (${esc(s.cause ?? '?')}) at ${fmtT(s.tOut)}` : `escaped at ${fmtT(s.tOut)}`;
    const objBP = (s.repairC ?? 0) * 2500 + (s.leverS ?? 0) * 100;
    return `<div class="card${chased ? ' chased' : ''}" style="--c:${survCss[i]}">
      <div class="hd">S${i} ${chased ? '<span class="badge b-chase">CHASED</span>' : ''}<span class="badge b-${st}">${st}</span></div>
      <div class="kv">
        <span>hook stages</span><span>${pips(Math.min(3, s.hookStage))} ${s.hookCount} hook${s.hookCount === 1 ? '' : 's'}${s.st === 4 ? ` · ${s.hookTimer.toFixed(0)} s left` : ''}</span>
        <span>activity</span><span>${act}${e.activityProgress != null && s.st < 5 ? bar(e.activityProgress) : ''}</span>
        <span>chase time</span><span>${track.chaseT[i].toFixed(0)} s · ${track.chases[i]} chase${track.chases[i] === 1 ? '' : 's'}</span>
        <span>repairs</span><span>${(s.repairC ?? 0).toFixed(2)} gens · ${(s.repairS ?? 0).toFixed(0)} s</span>
        <span>altruism</span><span>${track.heals[i]} heals · ${track.rescues[i]} rescues</span>
        <span>pallets</span><span>${track.drops[i]} dropped · ${track.stunsBy[i]} stuns</span>
        <span>hits taken</span><span>${track.hitsTaken[i]}${e.deepWound != null ? ' · deep wound' : ''}${s.protT > 0 ? ' · protected' : ''}</span>
        <span>objective BP</span><span>${fmtNum(objBP)}</span>
      </div></div>`;
  }).join('');
  const H = m.hunter, hm = hunterMode(m);
  const kills = m.survivors.filter((s) => s.outcome === 'dead' || s.st === 5).length;
  $('hunterCard').innerHTML = `<div class="card" style="--c:#d8313b">
    <div class="hd">Hunter <span class="badge" style="background:#5a1a1a">${esc(hm.mode)}</span></div>
    <div class="kv" style="grid-template-columns:auto 1fr auto 1fr">
      <span>target</span><span>${esc(hm.target)}</span><span>bloodlust</span><span>${m.blTier}</span>
      <span>hits</span><span>${m.stats.hits} (${m.stats.downs} downs)</span><span>hooks</span><span>${m.stats.hooks}</span>
      <span>kills</span><span>${kills}</span><span>chase time</span><span>${track.hunterChaseT.toFixed(0)} s</span>
      <span>pallets broken</span><span>${track.palletBreaks}</span><span>stunned</span><span>${m.stats.stuns}×</span>
      <span>gen kicks</span><span>${track.kicks}</span><span>missed swings</span><span>${m.stats.missed}</span>
    </div></div>`;
  drawTimeline();
  logUpdate();
}

function drawTimeline(hover = {}) {
  const tl = track.tl, xl = (i) => fmtT(tl.t[i] ?? 0);
  return {
    gens: lineChart($('tlGens'), { series: [{ name: 'gens', color: CAT[3], values: tl.gens }], yMax: match.gensNeeded, yTicks: match.gensNeeded, xLabel: xl, hover: hover.gens }),
    stages: lineChart($('tlStages'), { series: [{ name: 'stages', color: CAT[7], values: tl.stages }], yMax: 12, yTicks: 4, xLabel: xl, hover: hover.stages }),
    alive: lineChart($('tlAlive'), { series: [{ name: 'alive', color: CAT[0], values: tl.alive }], yMax: 4, yTicks: 4, xLabel: xl, hover: hover.alive }),
  };
}
attachHover($('tlGens'), (i) => drawTimeline({ gens: i }).gens, (i) => `${fmtT(track.tl.t[i])}<div class="r">gens <b>${track.tl.gens[i].toFixed(2)}</b></div>`);
attachHover($('tlStages'), (i) => drawTimeline({ stages: i }).stages, (i) => `${fmtT(track.tl.t[i])}<div class="r">hook stages <b>${track.tl.stages[i]}</b></div>`);
attachHover($('tlAlive'), (i) => drawTimeline({ alive: i }).alive, (i) => `${fmtT(track.tl.t[i])}<div class="r">in trial <b>${track.tl.alive[i]}</b></div>`);

// event log
const KEY_EVENTS = new Set(['start', 'end', 'hit', 'hook', 'hookStage', 'death', 'escape', 'rescue', 'genDone', 'gatesPowered', 'gateOpen', 'endgame', 'palletDrop', 'palletBreak', 'chaseStart', 'chaseEnd', 'pickup', 'wiggle', 'selfUnhook', 'heal', 'genKick', 'lastSurvivor', 'allDown', 'deepWoundDown', 'drop', 'dropped']);
const evColor = (t) => (/hit|hook|death|pickup|allDown|deepWound/.test(t) ? '#e66767' : /gen|gate|endgame|escape/.test(t) ? '#c98500' : /pallet|stun|wiggle|vault|window/.test(t) ? '#d95926' : /chase|bloodlust/.test(t) ? '#d55181' : /heal|rescue|mend|protect|selfUnhook/.test(t) ? '#199e70' : INK.secondary);
let logShown = 0;
function fmtEvent(e) {
  const { t, type, ...rest } = e;
  const parts = Object.entries(rest).map(([k, v]) => ((k === 'who' || k === 'by') && typeof v === 'number' ? `${k}=S${v}` : `${k}=${Array.isArray(v) ? v.join(',') : v}`));
  return { t, type, txt: parts.join(' ') };
}
function logUpdate(rebuild = false) {
  const el = $('log'), ev = match.events;
  if (rebuild) { el.innerHTML = ''; logShown = 0; }
  if (logShown === ev.length) return;
  const all = $('logMode').value === 'all', q = $('logFilter').value.trim().toLowerCase();
  let html = '';
  for (; logShown < ev.length; logShown++) {
    const e = ev[logShown];
    if (!all && !KEY_EVENTS.has(e.type)) continue;
    const f = fmtEvent(e);
    if (q && !(`${f.type} ${f.txt}`.toLowerCase().includes(q))) continue;
    html += `<div class="e"><span class="t">${fmtT(f.t)}</span><span class="ty" style="color:${evColor(f.type)}">${esc(f.type)}</span> ${esc(f.txt)}</div>`;
  }
  if (html) {
    el.insertAdjacentHTML('beforeend', html);
    while (el.childElementCount > 1500) el.firstElementChild.remove();
    if ($('logFollow').checked) el.scrollTop = el.scrollHeight;
  }
}
$('logMode').onchange = () => logUpdate(true);
$('logFilter').oninput = () => logUpdate(true);

// ---------------------------------------------------------------- runs (meta.jsonl climb runs / evo.jsonl population runs)
let meta = [], runKinds = {}, runConfig = null;
let runMods = {}, runModsByName = {};
// A new object for each selection also distinguishes switching away and back to the same run.
let selectedRun = null, loadedRun = null;
const defaultParams = () => ({ hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) });
let champ = defaultParams();
const spaceOf = (side) => runConfig?.spaces?.[side] ?? brains[side].space;
async function loadRuns() {
  const runs = await fetch('/api/runs').then((r) => r.json()).catch(() => []);
  runKinds = Object.fromEntries(runs.map((r) => [r.name, r.kind]));
  runModsByName = Object.fromEntries(runs.map((r) => [r.name, r.modifiers ?? {}]));
  const keep = $('run').value || store.get('run', '');
  $('run').innerHTML = runs.length ? runs.map((r) => { const md = isModded(r.modifiers); return `<option value="${esc(r.name)}"${md ? ' class="modded"' : ''}>${md ? `⚠ [${esc(modLabel(r.modifiers))}] ` : ''}${esc(r.name)}${r.kind === 'evolve' ? ' (population)' : ''}</option>`; }).join('') : '<option value="">(no runs — defaults)</option>';
  if (keep && runKinds[keep]) $('run').value = keep;
  await loadMeta();
}
async function fetchMeta({ name, kind }) {
  if (name && kind === 'evolve') {
    const txt = await (await fetch(`../runs/${name}/evo.jsonl`)).text();
    return txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => ({
      gen: e.gen, side: 'population', accepted: false, evo: e,
      after: { ...e.outcome },
      champ: evolutionChampion(e),
    }));
  } else if (name) {
    const txt = await (await fetch(`../runs/${name}/meta.jsonl`)).text();
    return txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return [];
}
async function loadMeta() {
  const name = $('run').value;
  const selection = { name, kind: runKinds[name] };
  selectedRun = selection;
  store.set('run', name);
  const [rows, config] = await Promise.all([
    fetchMeta(selection).catch(() => []),
    name ? fetch(`../runs/${name}/config.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  if (selection !== selectedRun) return;

  meta = rows;
  runConfig = config;
  try { brains = getBrains(config?.hunterBrain, config?.survivorBrain); }
  catch (e) { console.warn('run brains not supported by this checkout:', e.message); brains = getBrains(); }
  runMods = runConfig?.modifiers ?? meta.find((r) => r.evo?.modifiers)?.evo.modifiers ?? runModsByName[name] ?? {};
  loadedRun = selection;
  showRunMods();
  const evo = meta.length && meta[0].evo;
  if (evo) {
    const cur = $('knob').value || store.get('knob', 'hunter:tunnel');
    const opts = [...Object.keys(evo.hunters.knobs).map((k) => 'hunter:' + k), ...Object.keys(evo.survivors.knobs).map((k) => 'survivor:' + k)];
    $('knob').innerHTML = opts.map((o) => `<option>${esc(o)}</option>`).join('');
    $('knob').value = opts.includes(cur) ? cur : opts[0];
  }
  $('gen').max = meta.length;
  $('gen').value = meta.length;
  pickGen();
  await newMatch();
}
// poll a live population run: new generations show up without a reload (the match keeps playing)
setInterval(async () => {
  const run = loadedRun;
  if (!run || run !== selectedRun || run.kind !== 'evolve' || document.hidden) return;
  const fresh = await fetchMeta(run).catch(() => null);
  if (run !== selectedRun || !fresh || fresh.length <= meta.length) return;
  const atEnd = +$('gen').value === meta.length;
  meta = fresh; $('gen').max = meta.length;
  if (atEnd) $('gen').value = meta.length;
  pickGen();
}, 30000);

function showRunMods() {
  const md = isModded(runMods);
  $('modBadge').innerHTML = modBadge(runMods);
  $('toolbar').classList.toggle('modded', md);
  $('run').classList.toggle('modded', md);
  dirty.evo = true;
}
function genLabelText() {
  const g = +$('gen').value;
  return g === 0 || !meta.length ? 'default params' : `gen ${meta[g - 1].gen}/${meta[meta.length - 1].gen}`;
}
function pickGen() {
  const g = +$('gen').value;
  champ = g === 0 || !meta.length ? defaultParams() : meta[g - 1].champ;
  $('genLabel').textContent = genLabelText();
  dirty.evo = dirty.knobs = dirty.champ = true;
  queueRender();
}
function setGen(i, commit) {   // i = 1-based index into meta (0 = defaults)
  i = Math.max(0, Math.min(meta.length, i));
  if (+$('gen').value !== i) { $('gen').value = i; pickGen(); }
  if (commit) newMatch();
}

// ---------------------------------------------------------------- Evolution tab
function evoChartDefs() {
  if (!meta.length) return [];
  const has = (k) => meta.some((r) => r.after && r.after[k] !== undefined);
  const pop = !!meta[0].evo;
  const gensMax = Math.max(5, runConfig?.gensNeeded ?? 0);
  const defs = [];
  if (has('hookStages')) defs.push({ title: 'Hunter: hook stages per match', unit: 'avg, 0–12', yMax: 12, series: [{ name: 'hook stages', key: 'hookStages', color: CAT[7] }] });
  defs.push({ title: 'Kills & escapes per match', unit: 'avg, 0–4', yMax: 4, series: [{ name: 'kills', key: 'kills', color: CAT[7] }, { name: 'escapes', key: 'escapes', color: CAT[0] }].filter((s) => has(s.key)) });
  defs.push({ title: 'Generators per match', unit: 'avg', yMax: gensMax, series: [{ name: 'gens done', key: 'gensDone', color: CAT[3] }, ...(has('genProgress') ? [{ name: 'gen progress', key: 'genProgress', color: CAT[2] }] : [])] });
  if (has('survivalTime')) defs.push({ title: 'Survivor survival-time score', unit: '0–1', yMax: 1, series: [{ name: 'survival', key: 'survivalTime', color: CAT[2] }] });
  if (has('hunterScore100')) defs.push({ title: 'Hunter score', unit: 'table, 0–100', yMax: 100, series: [{ name: 'hunter score', key: 'hunterScore100', color: CAT[1] }] });
  if (has('hunterBP') || has('survivorBP')) defs.push({ title: 'Bloodpoints per match', unit: 'avg', series: [{ name: 'hunter BP', key: 'hunterBP', color: CAT[1] }, { name: 'survivor BP', key: 'survivorBP', color: CAT[0] }].filter((s) => has(s.key)) });
  if (has('hooks')) defs.push({ title: 'Hooks per match', unit: 'avg', series: [{ name: 'hooks', key: 'hooks', color: CAT[4] }] });
  if (has('durationS')) defs.push({ title: 'Match length', unit: 'seconds', series: [{ name: 'duration', key: 'durationS', color: CAT[6] }] });
  if (pop) defs.push({ title: 'Best individual fitness (ranking bp)', unit: 'per gen', series: [{ name: 'best hunter', get: (r) => r.evo.hunters.ranking[0].bp, color: CAT[1] }, { name: 'best team', get: (r) => r.evo.survivors.ranking[0].bp, color: CAT[0] }] });
  for (const d of defs) for (const s of d.series) s.values = meta.map((r) => (s.get ? s.get(r) : r.after?.[s.key]) ?? null);
  return defs.filter((d) => d.series.length);
}
let evoDefs = [], evoCanvases = [];
function renderEvo() {
  const g = +$('gen').value, name = loadedRun?.name ?? '';
  const r = g > 0 ? meta[g - 1] : null;
  const md = isModded(runMods) && meta.length;
  $('evoCharts').classList.toggle('modded', !!md);
  $('evoInfo').innerHTML = (md ? `<div class="modbanner">${modBadge(runMods)} this run was evolved under <b>non-standard game rules</b> (${esc(modLabel(runMods))}); its numbers are not comparable with standard runs.</div>` : '') + (!meta.length ? 'No run selected — the match plays default params. Pick a run in the toolbar.'
    : `<b style="color:var(--ink)">${esc(name)}</b> · ${meta[0].evo ? 'population run' : 'hill-climb run'} · ${meta.length} generations${runConfig?.gens ? ` of ${runConfig.gens}` : ''}${runConfig?.pop ? ` · pop ${runConfig.pop}` : ''}${runConfig?.rounds ? ` · ${runConfig.rounds} rounds` : ''}`
      + (r ? `<br>selected: <b style="color:var(--ink)">gen ${r.gen}</b>` + (r.evo ? ` · best hunter ${esc(r.evo.hunters.ranking[0].id)} vs best team ${esc(r.evo.survivors.ranking[0].id)} · ${r.evo.matches ?? '?'} matches in ${(r.evo.seconds ?? 0).toFixed(0)} s` : ` · ${esc(r.side)} ${r.accepted ? 'ACCEPTED' : 'kept'}`) : '<br>selected: generation 0 (default params)'));
  evoDefs = evoChartDefs();
  const box = $('evoCharts');
  const modTag = md ? `<span class="modtag">MODIFIED: ${esc(modLabel(runMods))}</span>` : '';
  const sig = evoDefs.map((d) => d.title).join('|') + '#' + modTag;
  if (box.childElementCount !== evoDefs.length || box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = evoDefs.map((d, k) => `<div class="chartbox"><div class="ttl">${esc(d.title)} ${modTag}<span class="lg">${esc(d.unit)}${d.series.length > 1 ? ' · ' + d.series.map((s) => `<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('') : ''}</span></div><canvas class="chart" data-k="${k}"></canvas></div>`).join('');
    evoCanvases = [...box.querySelectorAll('canvas')];
    evoCanvases.forEach((c, k) => attachHover(c, (h) => drawEvo(k, h), (i) => evoTip(k, i), (i, commit) => setGen(i + 1, commit)));
  }
  evoCanvases.forEach((_, k) => drawEvo(k, null));
  renderRankings(r);
}
function drawEvo(k, hover) {
  const d = evoDefs[k]; if (!d) return null;
  const markers = meta.map((r, i) => (r.accepted ? { i, color: r.side === 'hunter' ? CAT[1] : CAT[0] } : null)).filter(Boolean);
  return lineChart(evoCanvases[k], { series: d.series, yMax: d.yMax, xLabel: (i) => String(meta[i].gen), sel: +$('gen').value - 1, hover, markers, bg: isModded(runMods) ? MOD_TINT : null });
}
function evoTip(k, i) {
  const d = evoDefs[k];
  return `gen ${meta[i].gen}` + d.series.map((s) => `<div class="r"><span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><b>${fmtNum(s.values[i])}</b></div>`).join('');
}
function renderRankings(r) {
  const el = $('rankings');
  if (!r) { el.innerHTML = '<span class="muted">Pick a generation to see its rankings.</span>'; return; }
  if (!r.evo) {
    $('rankTitle').textContent = 'Generation record';
    const row = (k, a, b) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td></tr>`;
    el.innerHTML = `<table><tr><th></th><th>before</th><th>after</th></tr>${['kills', 'escapes', 'gensDone'].map((k) => row(k, fmtNum(r.before?.[k]), fmtNum(r.after?.[k]))).join('')}</table>`;
    return;
  }
  $('rankTitle').textContent = `Rankings — gen ${r.gen}`;
  const tbl = (title, rk) => `<div><div class="muted" style="margin-bottom:3px">${title}</div><table><tr><th>#</th><th>id</th><th>score</th><th>kills</th><th>esc.</th><th>gens</th><th>born</th></tr>${rk.slice(0, 10).map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.id)}</td><td>${fmtNum(x.bp)}</td><td>${fmtNum(x.kills)}</td><td>${fmtNum(x.escapes)}</td><td>${fmtNum(x.gensDone)}</td><td>${x.born ?? ''}</td></tr>`).join('')}</table></div>`;
  el.innerHTML = tbl('Hunters (top 10)', r.evo.hunters.ranking) + tbl('Survivor teams (top 10)', r.evo.survivors.ranking);
}

// ---------------------------------------------------------------- Knobs tab
const knobSort = { key: 'edge', dir: -1 };
function knobStats(side, key, r) { return r.evo[side === 'hunter' ? 'hunters' : 'survivors'].knobs[key]; }
function edgeInfo(st, lo, hi, best) {
  const tol = (hi - lo) * 0.02, vals = st.values ?? [];
  const nLo = vals.filter((v) => v <= lo + tol).length, nHi = vals.filter((v) => v >= hi - tol).length, n = Math.max(1, vals.length);
  const at = (v) => (v <= lo + tol ? 'lo' : v >= hi - tol ? 'hi' : null);
  const fLo = nLo / n, fHi = nHi / n;
  const side = fLo >= 0.5 || (fLo > fHi && at(st.med) === 'lo') ? 'lo' : fHi >= 0.5 || at(st.med) === 'hi' ? 'hi' : (at(best) && Math.max(fLo, fHi) >= 0.25 ? at(best) : null);
  return { side, frac: Math.max(fLo, fHi), fLo, fHi };
}
function drawKnobChart(hover = null) {
  const c = $('knobChart');
  if (!meta.length || !meta[0].evo) { prep(c); return null; }
  const [side, key] = $('knob').value.split(':');
  const space = spaceOf(side)[key];
  const p = prep(c); if (!p || !space) return null;
  const { g, W, H } = p;
  const [lo, hi, def] = space;
  const n = meta.length, L = 40, R = 10, T = 10, B = 20;
  const X = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const Y = (v) => H - B - ((v - lo) / (hi - lo || 1)) * (H - T - B);
  g.font = '11px system-ui'; g.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4, y = Math.round(Y(v)) + 0.5; g.strokeStyle = k === 0 || k === 4 ? INK.axis : INK.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillStyle = INK.muted; g.textAlign = 'right'; g.fillText(fmtNum(v), L - 5, y); }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 48))));
  for (let i = 0; i < n; i += step) g.fillText(String(meta[i].gen), X(i), H - 5);
  if (def != null) { g.strokeStyle = INK.muted; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(def)); g.lineTo(W - R, Y(def)); g.stroke(); g.setLineDash([]); }
  const st = (r) => knobStats(side, key, r);
  g.fillStyle = '#3987e533';
  meta.forEach((r, i) => { for (const v of st(r).values ?? []) g.fillRect(X(i) - 1.5, Y(v) - 1.5, 3, 3); });
  g.fillStyle = '#3987e566'; g.beginPath();
  meta.forEach((r, i) => (i ? g.lineTo(X(i), Y(st(r).q75)) : g.moveTo(X(i), Y(st(r).q75))));
  for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(st(meta[i]).q25));
  g.closePath(); g.fill();
  g.strokeStyle = '#9cc4f5'; g.lineWidth = 2; g.beginPath();
  meta.forEach((r, i) => (i ? g.lineTo(X(i), Y(st(r).med)) : g.moveTo(X(i), Y(st(r).med))));
  g.stroke(); g.lineWidth = 1;
  g.fillStyle = '#ffd24a';
  meta.forEach((r, i) => { const v = r.evo[side === 'hunter' ? 'hunters' : 'survivors'].ranking[0].params[key]; if (v != null) g.fillRect(X(i) - 2, Y(v) - 2, 4, 4); });
  const sel = +$('gen').value - 1;
  if (sel >= 0) { g.strokeStyle = '#ffffff55'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(sel), T); g.lineTo(X(sel), H - B); g.stroke(); g.setLineDash([]); }
  if (hover != null) { g.strokeStyle = '#ffffff99'; g.beginPath(); g.moveTo(X(hover) + 0.5, T); g.lineTo(X(hover) + 0.5, H - B); g.stroke(); }
  return { n, L, R, W };
}
attachHover($('knobChart'), (h) => drawKnobChart(h), (i) => {
  const [side, key] = $('knob').value.split(':'), s = knobStats(side, key, meta[i]);
  const best = meta[i].evo[side === 'hunter' ? 'hunters' : 'survivors'].ranking[0].params[key];
  return `gen ${meta[i].gen} · ${esc(key)}<div class="r">median <b>${fmtNum(s.med)}</b></div><div class="r">middle 50% <b>${fmtNum(s.q25)} – ${fmtNum(s.q75)}</b></div><div class="r">min / max <b>${fmtNum(s.min)} / ${fmtNum(s.max)}</b></div><div class="r">best <b>${fmtNum(best)}</b></div>`;
}, (i, commit) => setGen(i + 1, commit));
function renderKnobs() {
  const evo = meta.length && meta[0].evo;
  $('knobEmpty').style.display = evo ? 'none' : '';
  $('knobBody').style.display = evo ? '' : 'none';
  if (!evo) return;
  const [side, key] = $('knob').value.split(':');
  const space = spaceOf(side)[key] ?? [0, 1];
  const [lo, hi, def] = space;
  const gi = Math.max(1, +$('gen').value) - 1, r = meta[gi];
  const st = knobStats(side, key, r), best = r.evo[side === 'hunter' ? 'hunters' : 'survivors'].ranking[0].params[key];
  const ed = edgeInfo(st, lo, hi, best);
  $('knobRange').innerHTML = `range ${fmtNum(lo)} – ${fmtNum(hi)} · default ${fmtNum(def)}${ed.side ? ` · <span class="flag ${ed.side}">pinned ${ed.side === 'lo' ? 'low' : 'high'} (${Math.round(ed.frac * 100)}%)</span>` : ''}`;
  $('knobTitle').textContent = `${side} · ${key} — population distribution by generation (click to pick a generation)`;
  $('histTitle').textContent = `Distribution at gen ${r.gen} (yellow = best individual)`;
  drawKnobChart();
  histogram($('knobHist'), st.values ?? [], lo, hi, best, CAT[0]);
  const sds = meta.map((m) => knobStats(side, key, m).sd);
  lineChart($('knobSd'), { series: [{ name: 'sd', color: CAT[6], values: sds }], xLabel: (i) => String(meta[i].gen), sel: gi, yMax: niceCeil(Math.max(...sds, (hi - lo) * 0.05)) });
  // table
  const fSide = $('knobSide').value, q = $('knobSearch').value.trim().toLowerCase(), edgeOnly = $('knobEdge').checked;
  const rows = [];
  for (const sd of ['hunter', 'survivor']) {
    if (fSide !== 'all' && fSide !== sd) continue;
    const knobs = r.evo[sd === 'hunter' ? 'hunters' : 'survivors'].knobs;
    for (const k of Object.keys(knobs)) {
      if (q && !k.toLowerCase().includes(q)) continue;
      const sp = spaceOf(sd)[k]; if (!sp) continue;
      const s = knobs[k], b = r.evo[sd === 'hunter' ? 'hunters' : 'survivors'].ranking[0].params[k];
      const e = edgeInfo(s, sp[0], sp[1], b);
      if (edgeOnly && !e.side) continue;
      const first = knobStats(sd, k, meta[0]).med;
      rows.push({ sd, k, sp, s, b, e, drift: Math.abs(s.med - first) / (sp[1] - sp[0] || 1), spread: s.sd / (sp[1] - sp[0] || 1) });
    }
  }
  const cmp = { name: (a, b) => a.k.localeCompare(b.k), edge: (a, b) => (a.e.side ? 1 : 0) - (b.e.side ? 1 : 0) || a.e.frac - b.e.frac, drift: (a, b) => a.drift - b.drift, spread: (a, b) => a.spread - b.spread };
  rows.sort((a, b) => knobSort.dir * cmp[knobSort.key](a, b) || a.k.localeCompare(b.k));
  $('knobCount').textContent = `${rows.length} knobs · ${rows.filter((x) => x.e.side).length} pinned`;
  const pos = (v, sp) => `${(100 * (v - sp[0]) / (sp[1] - sp[0] || 1)).toFixed(1)}%`;
  const arrow = (k) => (knobSort.key === k ? (knobSort.dir > 0 ? ' ▲' : ' ▼') : '');
  $('knobTable').innerHTML = `<tr><th class="sort" data-s="name">knob${arrow('name')}</th><th>range (band = middle 50%, line = median, yellow = best, tick = default)</th><th>median</th><th>best</th><th class="sort" data-s="spread">sd${arrow('spread')}</th><th class="sort" data-s="drift">drift${arrow('drift')}</th><th class="sort" data-s="edge">edge${arrow('edge')}</th></tr>`
    + rows.map((x) => `<tr class="click${x.sd + ':' + x.k === $('knob').value ? ' selrow' : ''}" data-k="${x.sd}:${esc(x.k)}"><td><span class="muted">${x.sd === 'hunter' ? 'H' : 'S'}</span> ${esc(x.k)}</td>
      <td><div class="rbar" title="${fmtNum(x.sp[0])} – ${fmtNum(x.sp[1])}"><div class="iq" style="left:${pos(x.s.q25, x.sp)};width:calc(${pos(x.s.q75, x.sp)} - ${pos(x.s.q25, x.sp)})"></div>${x.sp[2] != null ? `<div class="df" style="left:${pos(x.sp[2], x.sp)}"></div>` : ''}<div class="md" style="left:${pos(x.s.med, x.sp)}"></div>${x.b != null ? `<div class="bs" style="left:${pos(x.b, x.sp)}"></div>` : ''}</div></td>
      <td>${fmtNum(x.s.med)}</td><td>${fmtNum(x.b)}</td><td><canvas class="spk" data-k="${x.sd}:${esc(x.k)}" style="width:60px;height:16px;vertical-align:middle"></canvas></td><td>${(x.drift * 100).toFixed(0)}%</td>
      <td>${x.e.side ? `<span class="flag ${x.e.side}">${x.e.side === 'lo' ? '⤓ low' : '⤒ high'} ${Math.round(x.e.frac * 100)}%</span>` : ''}</td></tr>`).join('');
  for (const c of $('knobTable').querySelectorAll('canvas.spk')) { const [sd, k] = c.dataset.k.split(':'); sparkline(c, meta.map((m) => knobStats(sd, k, m).sd), CAT[6], 0); }
}
$('knobTable').onclick = (ev) => {
  const th = ev.target.closest('th.sort');
  if (th) { const s = th.dataset.s; knobSort.dir = knobSort.key === s ? -knobSort.dir : s === 'name' ? 1 : -1; knobSort.key = s; renderKnobs(); return; }
  const tr = ev.target.closest('tr[data-k]');
  if (tr) { $('knob').value = tr.dataset.k; store.set('knob', tr.dataset.k); renderKnobs(); $('knobChart').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
};
$('knob').onchange = () => { store.set('knob', $('knob').value); renderKnobs(); };
for (const id of ['knobSide', 'knobSearch', 'knobEdge']) $(id).addEventListener('input', renderKnobs);

// ---------------------------------------------------------------- Map tab
let mmStatic = null;
function renderMap(full) {
  if (full) {
    const info = variantInfo.get(map.id) || {};
    const counts = match ? match.ps.reduce((a, s) => (a[s]++, a), [0, 0, 0]) : [0, 0, 0];
    const rows = [
      ['variant', esc(map.id ?? '—')], ['name', esc(map.name ?? '')], ['file', esc(map._path ?? '')],
      ['picked', match ? esc(matchSource.mapPicked) : '—'],
      ['outline family', esc(info.outline ?? (map.outline.length === 4 ? 'rectangle' : `${map.outline.length}-gon`))],
      ['variant seed', info.seed ?? '—'], ['size', `${map.size.w} × ${map.size.h} m`],
      ['pallets', `${map.pallets?.length ?? 0}${match ? ` · <span style="color:#f2d24b">${counts[0]} up</span> · <span style="color:#ff5a1f">${counts[1]} dropped</span> · <span style="color:#b08d6a">${counts[2]} broken</span>` : ''}`],
      ['pallet quality', info.safePallets != null ? `${info.safePallets} safe · ${info.unsafePallets} unsafe · ${info.godPallets} god` : '—'],
      ['windows', map.windows?.length ?? 0],
      ['loops', info.strongLoops != null ? `${info.strongLoops} strong · ${info.weakLoops} weak` : '—'],
      ['dead ground', info.deadTileFraction != null ? `${Math.round(info.deadTileFraction * 100)}% of tiles · ${Math.round(info.deadZoneFraction * 100)}% dead zone` : '—'],
      ['generators', `${match ? match.gens.length + ' used of ' : ''}${map.generators?.length ?? 0}`], ['hooks', map.hooks?.length ?? 0], ['exit gates', map.exitGates?.length ?? 0],
    ];
    $('mapInfo').innerHTML = rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join('');
    dirty.map = false;
  }
  drawMinimap();
}
function drawMinimap() {
  const c = $('minimap'), p = prep(c); if (!p || !match) return;
  const { g, W, H } = p, m = match;
  const sc = Math.min((W - 16) / map.size.w, (H - 16) / map.size.h), ox = (W - map.size.w * sc) / 2, oz = (H - map.size.h * sc) / 2;
  const X = (x) => ox + x * sc, Z = (z) => oz + z * sc;
  const key = `${map._path}|${W}|${H}`;
  if (!mmStatic || mmStatic.key !== key) {
    const oc = document.createElement('canvas'); oc.width = c.width; oc.height = c.height;
    const o = oc.getContext('2d'); o.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    o.fillStyle = '#2a3226'; o.beginPath(); map.outline.forEach(([x, z], i) => (i ? o.lineTo(X(x), Z(z)) : o.moveTo(X(x), Z(z)))); o.closePath(); o.fill();
    o.strokeStyle = '#555'; o.stroke();
    for (const ob of map.obstacles) { const tall = ob.height >= (map.eyeHeight ?? 1.6); o.fillStyle = tall ? '#6b6e76' : '#4a4d45'; o.fillRect(X(ob.x), Z(ob.z), ob.w * sc, ob.d * sc); }
    o.fillStyle = '#6fc8e8'; for (const w of map.windows) o.fillRect(X(w.x) + (w.axis === 'x' ? sc * 0.35 : 0), Z(w.z) + (w.axis === 'x' ? 0 : sc * 0.35), w.axis === 'x' ? sc * 0.3 : sc, w.axis === 'x' ? sc : sc * 0.3);
    o.fillStyle = '#99232f'; for (const h of map.hooks) { o.beginPath(); o.arc(X(h.x), Z(h.z), Math.max(2, sc * 0.5), 0, 7); o.fill(); }
    o.fillStyle = '#8866cc'; for (const gt of map.exitGates) { o.fillRect(X(gt.lever.x) - 3, Z(gt.lever.z) - 3, 6, 6); o.beginPath(); o.arc(X(gt.exit.x), Z(gt.exit.z), 4, 0, 7); o.fill(); }
    mmStatic = { key, oc };
  }
  g.drawImage(mmStatic.oc, 0, 0, W, H);
  m.md.pallets.forEach((pl, i) => { g.fillStyle = ['#f2d24b', '#ff5a1f', '#8a6d50'][m.ps[i]]; g.fillRect(X(pl.x0), Z(pl.z0), Math.max(2, (pl.x1 - pl.x0) * sc), Math.max(2, (pl.z1 - pl.z0) * sc)); });
  for (const gn of m.gens) { const pr = gn.done ? 1 : gn.p / m.need; g.fillStyle = gn.done ? '#fab219' : '#5a4a20'; const s = Math.max(5, sc * 1.2); g.fillRect(X(gn.x) - s / 2, Z(gn.z) - s / 2, s, s); if (!gn.done && pr > 0) { g.fillStyle = '#c98500'; g.fillRect(X(gn.x) - s / 2, Z(gn.z) + s / 2 - s * pr, s, s * pr); } }
  const H0 = m.hunter;
  g.fillStyle = '#ff404020'; g.beginPath(); g.moveTo(X(H0.x), Z(H0.z)); g.arc(X(H0.x), Z(H0.z), 14 * sc, H0.face - 0.87, H0.face + 0.87); g.closePath(); g.fill();
  const actor = (x, z, face, color, r) => { g.fillStyle = color; g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath(); g.arc(X(x), Z(z), r, 0, 7); g.fill(); g.stroke(); g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(X(x), Z(z)); g.lineTo(X(x) + Math.cos(face) * r * 2, Z(z) + Math.sin(face) * r * 2); g.stroke(); };
  m.survivors.forEach((s, i) => { if (s.st < 5) actor(s.x, s.z, s.face, survCss[i], Math.max(4, sc * 0.6)); });
  actor(H0.x, H0.z, H0.face, '#d8313b', Math.max(5, sc * 0.75));
  g.font = '11px system-ui'; g.fillStyle = INK.muted; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('north = up (z grows downward), live', 8, 6);
}

// ---------------------------------------------------------------- Champion tab
function renderChamp() {
  const r = meta[+$('gen').value - 1], use = $('useChamp').checked;
  const who = r?.evo?.cma ? ' · CMA-ES mean' : r?.evo ? ` · hunter ${esc(r.evo.hunters.ranking[0].id)} · team ${esc(r.evo.survivors.ranking[0].id)}` : '';
  $('champInfo').innerHTML = (isModded(runMods) && meta.length ? modBadge(runMods) + ' ' : '') + (!r ? 'Default parameters (generation 0 / no run).' : `Champions of <b style="color:var(--ink)">${esc(loadedRun.name)}</b> · gen ${r.gen}${who} — ${use ? 'champs enabled' : 'champs unchecked'}`);
  const onlyChanged = $('champChanged').checked, q = $('champSearch').value.trim().toLowerCase();
  const d = defaultParams();
  const tbl = (side) => {
    const sp = spaceOf(side);
    const rows = Object.entries(champ[side] ?? {}).filter(([k, v]) => (!q || k.toLowerCase().includes(q)) && (!onlyChanged || Math.abs(v - (d[side][k] ?? v)) > 1e-6)).map(([k, v]) => {
      const s = sp[k] ?? brains[side].space[k], def = d[side][k];
      const delta = def == null ? 0 : v - def;
      const posv = s ? (v - s[0]) / (s[1] - s[0] || 1) : null;
      const edge = s && (posv <= 0.02 ? 'lo' : posv >= 0.98 ? 'hi' : null);
      return `<tr><td class="${Math.abs(delta) > 1e-6 ? 'changed' : 'muted'}">${esc(k)}</td><td>${fmtNum(+v)}</td><td class="muted">${fmtNum(def)}</td><td>${Math.abs(delta) > 1e-6 ? (delta > 0 ? '▲' : '▼') : ''}</td>
        <td>${s ? `<div class="rbar" title="${fmtNum(s[0])} – ${fmtNum(s[1])}">${def != null ? `<div class="df" style="left:${(100 * (def - s[0]) / (s[1] - s[0] || 1)).toFixed(1)}%"></div>` : ''}<div class="bs" style="left:${(100 * posv).toFixed(1)}%"></div></div>` : ''}</td><td>${edge ? `<span class="flag ${edge}">${edge === 'lo' ? 'at min' : 'at max'}</span>` : ''}</td></tr>`;
    }).join('');
    return `<div><h3>${side === 'hunter' ? 'Hunter' : 'Survivors'}</h3><table><tr><th>param</th><th>value</th><th>default</th><th></th><th>position in range</th><th></th></tr>${rows || '<tr><td colspan="6" class="muted">none</td></tr>'}</table></div>`;
  };
  $('champTables').innerHTML = tbl('hunter') + tbl('survivor');
}
$('champChanged').onchange = renderChamp;
$('champSearch').oninput = renderChamp;

// ---------------------------------------------------------------- loop
let paused = false, acc = 0, last = performance.now();
let matchRequest = 0;
async function newMatch() {
  const run = loadedRun;
  if (!run || run !== selectedRun) return;  // loadMeta starts a match with the latest inputs when the run is ready
  const request = ++matchRequest;
  const seedInput = String($('seed').value).trim();
  const parsedSeed = Number(seedInput);
  const seed = seedInput && Number.isFinite(parsedSeed) ? parsedSeed : 1;
  const useChamp = $('useChamp').checked;
  const params = useChamp ? champ : defaultParams();
  const genLabel = useChamp ? genLabelText() : 'default params';
  const matchBrains = brains;
  let mods = runMods;
  const savedMap = runConfig?.map;
  const savedPoolSize = runConfig?.mapPool?.n;
  const want = $('map').value;
  const isCurrent = () => request === matchRequest && run === selectedRun;
  let nextMap, mapPicked, mapWarning;
  if (want === 'auto') {
    if (savedMap != null) {
      try {
        const pool = await savedMapPool(savedMap);
        if (!isCurrent()) return;
        const path = pool[seed % pool.length];
        if (path && (savedPoolSize == null || pool.length === savedPoolSize)) {
          nextMap = await loadMap(path);
          mapPicked = pool.length === 1 ? 'saved run map' : `saved run pool · seed ${seed} mod ${pool.length}`;
        }
      } catch { /* use the legacy pool if the saved map or index is unavailable */ }
      if (!nextMap) mapWarning = 'Saved run map unavailable. Playing on Gas Heaven.';
    }
    if (!isCurrent()) return;
    if (!nextMap) {
      const path = variantPool[seed % variantPool.length] ?? baseMapPath;
      nextMap = await loadMap(path).catch(() => loadMap(baseMapPath));
      mapPicked = nextMap._path === baseMapPath ? 'Gas Heaven base map' : `Gas Heaven pool · seed ${seed} mod ${variantPool.length}`;
    }
  } else {
    if (!mapPaths.has(want)) return;
    try { nextMap = await loadMap(want); }
    catch (e) {
      if (isCurrent()) console.warn('could not load map:', want, e);
      return;
    }
    mapPicked = 'chosen manually';
  }
  if (!isCurrent()) return;

  const { _path, ...live } = nextMap;
  // the live sim plays under the selected run's game modifiers (also with "champs" unchecked: the run's rules)
  let config;
  try { config = isModded(mods) ? modsConfig(mods) : undefined; }
  catch (e) { console.warn('game modifiers not supported by this checkout:', e.message); mods = {}; }
  const nextMatch = createMatch({ map: live, seed, config, hunter: matchBrains.hunter.make(params.hunter), survivors: matchBrains.survivor.make(params.survivor) });
  if (nextMap !== map) S3.buildStatic(nextMap);
  map = nextMap;
  match = nextMatch;
  matchSource = { mods, genLabel, mapPicked, mapWarning };
  track = newTrack(); sample(); track.nextSample = 1;
  S3.buildDynamic(match, map);
  layers.rebuild(match, map);
  logUpdate(true);
  dirty.map = dirty.champ = true;
  S3.sync(match); hud(true); queueRender();
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!paused && match && !match.over) {
    acc += dt * +$('speed').value * 10;
    let n = 0;
    while (acc >= 1 && n < 400 && !match.over) { match.step(); afterStep(); acc -= 1; n++; }
    if (n >= 400) acc = 0;
    S3.sync(match); hud();
    layers.update();
    renderActive(false);
  }
  S3.render();
  requestAnimationFrame(frame);
}

function togglePause() { paused = !paused; $('play').textContent = paused ? 'Play' : 'Pause'; hud(true); }
$('play').onclick = togglePause;
$('restart').onclick = newMatch;
$('seed').onchange = newMatch;
$('random').onclick = () => { $('seed').value = Math.floor(Math.random() * 1e6); newMatch(); };
$('run').onchange = loadMeta;
$('gen').oninput = pickGen;
$('gen').onchange = newMatch;
$('useChamp').onchange = () => { dirty.champ = true; newMatch(); };
let top = false;
const setTop = (t) => { top = t; $('cam').classList.toggle('on', top); S3.setTopDown(top); };
$('cam').onclick = () => setTop(!top);
$('heat').onchange = () => { layers.set('h-belief', { on: $('heat').checked }); };

addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && immersive) { setImmersive(false); return; }
  const tag = ev.target.tagName;
  if (tag === 'INPUT' && ev.target.type !== 'checkbox' && ev.target.type !== 'range' || tag === 'SELECT' || tag === 'TEXTAREA' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.toLowerCase(), sp = $('speed');
  const tabs = ['match', 'evo', 'knobs', 'map', 'champ', 'layers'];
  if (k === 'f') setImmersive(!immersive);
  else if (k === ' ') togglePause();
  else if (k === 'r') newMatch();
  else if (k === 'n') $('random').click();
  else if (k === 't') setTop(!top);
  else if (k === 'h') { layers.toggle('h-belief'); syncHeatBox(); }
  else if (k === 'd') { layout.hidden = !layout.hidden; applyLayout(); }
  else if (k === 'b') { layout.pos = layout.pos === 'bottom' ? 'right' : 'bottom'; applyLayout(); }
  else if (k === '[') { sp.selectedIndex = Math.max(0, sp.selectedIndex - 1); hud(true); }
  else if (k === ']') { sp.selectedIndex = Math.min(sp.options.length - 1, sp.selectedIndex + 1); hud(true); }
  else if (k === 'arrowleft' && ev.target.type !== 'range') setGen(+$('gen').value - 1, true);
  else if (k === 'arrowright' && ev.target.type !== 'range') setGen(+$('gen').value + 1, true);
  else if (/^[1-6]$/.test(k)) setTab(tabs[+k - 1]);
  else if (k === 'l') { if (immersive) { const fl = $('layerFloat'); fl.classList.toggle('show'); if (fl.classList.contains('show')) fl.appendChild($('layerPanel')); else $('pane-layers').appendChild($('layerPanel')); } else setTab('layers'); }
  else return;
  ev.preventDefault();
});

applyLayout();
setTab(['keys', 'match', 'evo', 'knobs', 'map', 'champ', 'layers'].includes(layout.tab) ? layout.tab : 'match');
const catalog = await fetch('/api/maps').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const mapList = Array.isArray(catalog)
  ? catalog.filter((m) => typeof m === 'string' && repoMapPath(m) === m && m.endsWith('.json') && !m.endsWith('/index.json'))
  : [baseMapPath];
const mapPaths = new Set(mapList);
const variantPool = mapList.filter((m) => m.startsWith('maps/gas-heaven/v')).sort();
$('map').innerHTML = '<option value="auto">Auto (saved run map)</option>' + mapList.map((m) => `<option>${esc(m)}</option>`).join('');
$('map').value = 'auto';
$('map').onchange = newMatch;
S3.buildStatic(map);
S3.setTopDown(false);
await loadRuns();
requestAnimationFrame(frame);
