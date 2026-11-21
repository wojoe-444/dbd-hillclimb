// Shack duel viewer: plays one 1 hunter vs 1 survivor duel from scripts/duel-shack.js's setup grid (shared code in
// src/duel/shack.js) with play / pause / step / scrub and the overlay layers (viewer/layers.js). Scrubbing backwards
// re-simulates from the start (deterministic, ~0.1 s), so every layer always reads the brains' live state.
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults, clampParams } from '../src/hillclimb/params.js';
import { buildGrid, createDuel, pushFix, duelParams, situation, NEUTRALIZE } from '../src/duel/shack.js';
import { createScene, survCss, stateNames } from './scene.js';
import { createLayers } from './layers.js';
import { prep, fmtNum } from './charts.js';
import { withMods } from '../src/sim/modifiers.js';
import { modBadge, isModded, modLabel } from './mods.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k, d) => { try { const v = localStorage.getItem('dbdv.duel.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('dbdv.duel.' + k, JSON.stringify(v)); } catch { /* */ } } };
const SEED0 = 1000, SHACK = { x: 16, z: 16, span: 34 };

const map = await (await fetch('../maps/duel-shack.json')).json();
const B = getBrains('param', 'param');
const grid = buildGrid(map, createMatch);
$('nSetups').textContent = grid.length;
$('setup').innerHTML = grid.map((g, i) => `<option value="${i}">${i}: ${esc(g.id)}</option>`).join('');

// ---------------------------------------------------------------- 3D + layers
const S3 = createScene($('view'), { hideSurvivor: (i) => i > 0 });   // survivors 1-3 are parked dummies
const layers = createLayers({ scene3d: S3, panel: $('layerPanel'), storeKey: 'layers.duel', defaults: {
  'h-belief': { on: true, opacity: 0.35, who: '0' }, 'h-goal': { on: true }, 'h-path': { on: true }, 'h-cone': { on: true }, 'h-terror': { on: false },
  's-plan': { on: true }, 's-route': { on: true }, 's-hbelief': { on: false }, 'w-pallets': { on: true }, 'w-loops': { on: true }, 's-scratch': { on: true, all: false },
} });
S3.buildStatic(map);
let top = true;
const setTop = (t) => { top = t; $('cam').classList.toggle('on', top); S3.setTopDown(top, SHACK); };
setTop(true);

// ---------------------------------------------------------------- params (default / a run's champions)
const runs = await fetch('/api/runs').then((r) => r.json()).catch(() => []);
$('params').innerHTML = '<option value="">default knobs</option>' + runs.map((r) => { const md = isModded(r.modifiers); return `<option value="${esc(r.name)}"${md ? ' class="modded"' : ''}>${md ? `⚠ [${esc(modLabel(r.modifiers))}] ` : ''}champions: ${esc(r.name)}</option>`; }).join('');
const runModsByName = Object.fromEntries(runs.map((r) => [r.name, r.modifiers ?? {}]));
const champCache = new Map();
async function loadChamp(name) {
  if (!name) return null;
  if (champCache.has(name)) return champCache.get(name);
  return fetch(`../runs/${encodeURIComponent(name)}/champions.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

// ---------------------------------------------------------------- duel state
let cfg = null, st = null, timeline = null;
function newState() {
  const setup = grid[cfg.setupIdx];
  const cm = isModded(cfg.mods) ? (o) => createMatch({ ...o, config: withMods(o.config, cfg.mods) }) : createMatch;
  const D = createDuel({ map, createMatch: cm, B, setup, seed: cfg.seed, P: cfg.P, hunterMode: cfg.hunterMode, assistAfter: cfg.assistAfter, jitter: cfg.jitter });
  return { D, m: D.m, S: D.S, H: D.H, evI: 0, wasV: [], prevV: null, prevHV: null, palletBreakT: null, hits: [], tDown: null, cause: null, done: false,
    winV: 0, palV: 0, hV: 0, dropT: null, stun: null, breakT: null, chases: 0 };
}
// one tick, with the same harness bookkeeping as scripts/duel-shack.js (push fix on drops, stop at the first down / cap)
function stepState(s) {
  if (s.done) return false;
  const m = s.m, S = s.S, H = s.H;
  m.step();
  const t = +m.t.toFixed(2);
  for (; s.evI < m.events.length; s.evI++) {
    const e = m.events[s.evI];
    if (e.type === 'hit' && e.who === 0) {
      const c = situation(S.x, S.z, { midVault: !!S.vault || s.wasV.some(Boolean), recentBreak: s.palletBreakT !== null && t - s.palletBreakT < 8, palletUp: m.ps[0] === 0 });
      s.hits.push({ t, state: e.state, c });
      if (e.state === 'downed') { s.tDown = t; s.cause = c; }
    } else if (e.type === 'palletDrop' && e.by === 0) { s.dropT ??= t; s.stun = s.stun || !!e.stun; pushFix(m, cfg.pushFix); }
    else if (e.type === 'palletBreak') { s.palletBreakT = t; s.breakT ??= t; }
    else if (e.type === 'chaseStart' && e.who === 0) s.chases++;
  }
  if (S.vault && S.vault !== s.prevV) { const k = m.md.kind[S.vault.cell]; if (k === 2 || k === 3) s.winV++; else s.palV++; }
  s.prevV = S.vault;
  if (H.vault && H.vault !== s.prevHV) s.hV++;
  s.prevHV = H.vault;
  s.wasV.push(!!S.vault); if (s.wasV.length > 2) s.wasV.shift();
  if (s.tDown !== null || m.over || m.t >= cfg.cap - 1e-9) s.done = true;
  return true;
}

let restartRequest = 0;
async function restart(keepTick = 0) {
  const request = ++restartRequest;
  const form = {
    idx: $('idx').value, setup: $('setup').value, seed: $('seed').value,
    hmode: $('hmode').value, assistAfter: $('assistAfter').value, params: $('params').value,
    jitter: $('jitter').value, cap: $('cap').value, leash: $('leash').checked, pushfix: $('pushfix').checked,
  };
  const champName = form.params;
  const championFile = await loadChamp(champName);
  if (request !== restartRequest) return;
  if (champName) champCache.set(champName, championFile);

  const champ = championFile?.champ ?? null;
  const mods = champName ? championFile?.modifiers ?? runModsByName[champName] ?? {} : {};
  const P = duelParams(B, { defaults, clampParams }, { champ, hunterOverrides: form.leash ? {} : NEUTRALIZE });
  const seedInput = String(form.seed).trim();
  const parsedSeed = Number(seedInput);
  const seed = seedInput && Number.isFinite(parsedSeed) ? parsedSeed : SEED0;
  cfg = { mods, P, seed, setupIdx: +form.setup || 0, hunterMode: form.hmode, assistAfter: +form.assistAfter || 3,
    jitter: +form.jitter, cap: Math.max(5, +form.cap || 120), pushFix: form.pushfix };

  $('err').textContent = champName && !champ ? `no champions.json in runs/${champName} — using defaults` : '';
  $('modBadge').innerHTML = modBadge(mods);
  $('toolbar').classList.toggle('modded', isModded(mods));
  $('params').classList.toggle('modded', isModded(mods));
  store.set('form', form);
  // pre-run the whole duel once for the timeline (events, result), then play a fresh copy
  const pre = newState();
  while (stepState(pre));
  timeline = { ticks: pre.m.tick, events: pre.m.events.filter((e) => e.type !== 'start'), r: pre, dt: pre.m.dt };
  $('scrub').max = timeline.ticks;
  renderResult(); renderEvents(); drawMarks();
  st = newState();
  S3.buildDynamic(st.m, map);
  seek(Math.min(keepTick, timeline.ticks));
}
function seek(tick) {
  tick = Math.max(0, Math.min(timeline.ticks, Math.round(tick)));
  if (tick < st.m.tick) { st = newState(); S3.buildDynamic(st.m, map); }
  while (st.m.tick < tick && stepState(st));
  refresh(true);
}

// ---------------------------------------------------------------- UI rendering
const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
function refresh(force) {
  const m = st.m, S = st.S, H = st.H;
  S3.sync(m);
  if (layersMatch !== m) { layers.rebuild(m, map); layersMatch = m; } else layers.update(force);
  $('scrub').value = m.tick;
  $('clock').textContent = `${m.t.toFixed(1)} s / ${(timeline.ticks * timeline.dt).toFixed(1)} s`;
  const now = performance.now();
  if (!force && now - uiAt < 120) return;
  uiAt = now;
  const d = Math.hypot(H.x - S.x, H.z - S.z), hA = st.D.hAct(), sA = st.D.acts.length ? st.D.acts[st.D.acts.length - 1].act || {} : {};
  const hs = H.stunT > 0 ? 'stunned' : H.vault ? 'vaulting' : H.windT > 0 ? 'lunging' : H.cdT > 0 ? 'cooldown' : H.curAct ?? (hA.moveTo ? 'moving' : 'idle');
  const winBlocked = m.winBlockT && m.winBlockT[0] > m.t;
  $('tiles').innerHTML = [
    tile('Alive', `${(st.tDown ?? m.t).toFixed(1)} s`, st.tDown !== null ? `down: ${esc(st.cause)}` : st.done ? 'survived the cap' : 'until first down'),
    tile('Survivor', stateNames[S.st], S.vault ? 'vaulting' : sA.walk ? 'walking' : (S.vx || S.vz) ? 'running' : 'still'),
    tile('Hunter', esc(hs), hA.assisted ? 'harness override' : H.seen[0] ? 'sees survivor' : 'blind'),
    tile('Distance', `${d.toFixed(1)} m`, m.chaseTgt === 0 ? `chase · bloodlust ${m.blTier}` : 'no chase'),
    tile('Pallet', ['up', 'dropped', 'broken'][m.ps[0]], winBlocked ? 'window blocked' : 'window open'),
  ].join('');
  const dbg = S.brain?.debug?.(m.t) ?? null;
  const mv = (a) => (a.moveTo ? `→(${a.moveTo.x.toFixed(1)}, ${a.moveTo.z.toFixed(1)})` : a.moveDir ? `dir(${a.moveDir.x.toFixed(2)}, ${a.moveDir.z.toFixed(2)})` : 'stand');
  const plan = dbg ? `plan: ${dbg.mode}${dbg.circ ? ` · loop ${dbg.circ.anchors.join('→')} · next ${dbg.circ.anchors[dbg.circ.i]} (${dbg.circ.phase}${dbg.circ.holdT > 0 ? `, holding ${dbg.circ.holdT.toFixed(1)} s` : ''})` : dbg.fleePoint ? ` · flee to (${dbg.fleePoint.x.toFixed(1)}, ${dbg.fleePoint.z.toFixed(1)})` : dbg.hide ? ' · hide' : ''}` : '';
  $('trace').textContent = `t ${m.t.toFixed(1)}  S(${S.x.toFixed(1)}, ${S.z.toFixed(1)}) ${stateNames[S.st]}${S.vault ? ' VAULT' : ''}  ${mv(sA)}${sA.walk ? ' walk' : ''}${sA.act ? ' ' + sA.act : ''}\n`
    + `      H(${H.x.toFixed(1)}, ${H.z.toFixed(1)})${hA.assisted ? ' [harness]' : ''} ${mv(hA)}${hA.act ? ' ' + hA.act : ''}${H.seen[0] ? '' : ' blind'}\n      ${plan}`;
  for (const el of $('events').children) { const t = +el.dataset.t; el.classList.toggle('past', t < m.t - 0.05); el.classList.toggle('now', Math.abs(t - m.t) < 0.06); }
  hud();
  drawMarks();
}
let uiAt = 0, layersMatch = null;
function hud() {
  const m = st.m, S = st.S;
  $('hud').innerHTML = `<div class="top"><span class="clock">${m.t.toFixed(1)} s</span>${modBadge(cfg.mods)}<span>${esc(grid[cfg.setupIdx].id)} · seed ${cfg.seed} · ${cfg.hunterMode}</span>${st.tDown !== null ? `<span><b>DOWN</b> ${st.tDown.toFixed(1)} s (${esc(st.cause)})</span>` : st.done ? '<span><b>CAP</b></span>' : ''}${playing ? '' : '<span class="muted">paused</span>'}</div>
    <div class="chips"><span class="chip"><span class="dot" style="background:#d8313b"></span>Hunter${st.H.seen[0] ? '' : ' (blind)'}</span><span class="chip"><span class="dot" style="background:${survCss[0]}"></span>S0 ${stateNames[S.st]}</span></div>`;
}
function renderResult() {
  const r = timeline.r;
  $('result').innerHTML = `<div class="kv" style="grid-template-columns:auto 1fr auto 1fr">
    <span>alive</span><span>${(r.tDown ?? timeline.ticks * timeline.dt).toFixed(1)} s${r.tDown === null ? ' (cap)' : ''}</span><span>down cause</span><span>${esc(r.cause ?? '—')}</span>
    <span>first hit</span><span>${r.hits[0] ? `${r.hits[0].t.toFixed(1)} s (${esc(r.hits[0].c)})` : '—'}</span><span>chases</span><span>${r.chases}</span>
    <span>window vaults</span><span>${r.winV}</span><span>pallet vaults</span><span>${r.palV}</span>
    <span>pallet</span><span>${r.dropT !== null ? `dropped ${r.dropT.toFixed(1)} s${r.stun ? ' · STUN' : ''}` : 'not dropped'}${r.breakT !== null ? ` · broken ${r.breakT.toFixed(1)} s` : ''}</span><span>hunter vaults</span><span>${r.hV}</span>
    <span>harness</span><span>assist ${(r.D.counters.assistTicks * timeline.dt).toFixed(1)} s · break ${(r.D.counters.breakAssists * timeline.dt).toFixed(1)} s</span><span></span><span></span></div>`;
}
const evColor = (e) => (e.type === 'hit' ? '#e66767' : e.type === 'palletDrop' ? '#d95926' : e.type === 'palletBreak' ? '#8a6d50' : e.type === 'vault' ? '#3987e5' : /chase/.test(e.type) ? '#d55181' : e.type === 'windowBlocked' ? '#6fc8e8' : '#898781');
const KEEP = new Set(['hit', 'palletDrop', 'palletBreak', 'vault', 'chaseStart', 'chaseEnd', 'windowBlocked', 'bloodlust', 'miss', 'end']);
function renderEvents() {
  const evs = timeline.events.filter((e) => KEEP.has(e.type) && (e.who === undefined || e.who === 0 || e.who === 'hunter' || e.type === 'vault'));
  $('events').innerHTML = evs.map((e) => { const { t, type, ...rest } = e; return `<div class="e" data-t="${t}"><span class="muted">${t.toFixed(1)}</span> <b style="color:${evColor(e)}">${esc(type)}</b> ${esc(Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' '))}</div>`; }).join('') || '<span class="muted">no events</span>';
}
$('events').onclick = (ev) => { const el = ev.target.closest('.e'); if (el) { setPlaying(false); seek(Math.round(+el.dataset.t / timeline.dt)); } };
function drawMarks() {
  const c = $('marks'), p = prep(c); if (!p || !timeline) return;
  const { g, W, H } = p, T = timeline.ticks * timeline.dt || 1, X = (t) => 4 + (t / T) * (W - 8);
  for (const e of timeline.events) {
    if (!KEEP.has(e.type)) continue;
    const down = e.type === 'hit' && e.state === 'downed';
    g.fillStyle = evColor(e); g.fillRect(X(e.t) - (down ? 2 : 1), down ? 2 : e.type === 'vault' ? H / 2 : 6, down ? 4 : 2, down ? H - 4 : e.type === 'vault' ? H / 2 - 3 : H - 12);
  }
  if (st) { g.fillStyle = '#ffffff'; g.fillRect(X(st.m.t) - 1, 0, 2, H); }
  g.fillStyle = '#898781'; g.font = '10px system-ui'; g.textBaseline = 'top'; g.fillText('0', 3, 2); g.textAlign = 'right'; g.fillText(`${T.toFixed(0)} s`, W - 3, 2);
}
$('marks').onclick = (ev) => { const r = $('marks').getBoundingClientRect(); setPlaying(false); seek(((ev.clientX - r.left - 4) / (r.width - 8)) * timeline.ticks); };

// ---------------------------------------------------------------- playback loop
let playing = false, acc = 0, last = performance.now();
function setPlaying(on) { playing = on && !(st && st.m.tick >= timeline.ticks); $('play').textContent = playing ? 'Pause' : 'Play'; hud(); }
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (playing && st) {
    acc += dt * (+$('speed').value) / timeline.dt;
    let n = 0;
    while (acc >= 1 && n < 200) { if (!stepState(st) || st.m.tick >= timeline.ticks) { setPlaying(false); break; } acc -= 1; n++; }
    if (n) refresh(false);
  }
  S3.render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- controls
$('play').onclick = () => { if (st.m.tick >= timeline.ticks) seek(0); setPlaying(!playing); };
$('fwd').onclick = () => { setPlaying(false); seek(st.m.tick + 1); };
$('back').onclick = () => { setPlaying(false); seek(st.m.tick - 1); };
$('scrub').oninput = () => { setPlaying(false); seek(+$('scrub').value); };
$('restart').onclick = () => restart(0);
$('idx').onchange = () => { const i = Math.max(0, +$('idx').value || 0); $('setup').value = i % grid.length; $('seed').value = SEED0 + i; restart(0); };
for (const id of ['setup', 'seed', 'hmode', 'assistAfter', 'params', 'jitter', 'cap', 'leash', 'pushfix']) $(id).onchange = () => restart(0);
$('rnd').onclick = () => { $('seed').value = Math.floor(Math.random() * 1e6); restart(0); };
$('cam').onclick = () => setTop(!top);
// full screen (same model as the match viewer)
let immersive = false;
function setImmersive(on) {
  immersive = on; document.body.classList.toggle('immersive', on);
  if (!on && $('layerFloat').classList.contains('show')) { $('layerFloat').classList.remove('show'); $('dock').appendChild($('layerPanel')); }
  if (on) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && immersive) setImmersive(false); });
$('fsBtn').onclick = () => setImmersive(true);
{ // dock resizer
  const rz = $('resizer'), saved = store.get('dockW', null);
  if (saved) document.body.style.setProperty('--dock-w', saved + 'px'); else document.body.style.setProperty('--dock-w', Math.round(Math.min(620, Math.max(380, innerWidth * 0.32))) + 'px');
  rz.addEventListener('pointerdown', (ev) => {
    rz.setPointerCapture(ev.pointerId); rz.classList.add('drag');
    const move = (e) => { const r = $('main').getBoundingClientRect(), w = Math.round(Math.max(340, Math.min(r.width - 280, r.right - e.clientX))); document.body.style.setProperty('--dock-w', w + 'px'); store.set('dockW', w); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); drawMarks(); }, { once: true });
  });
  rz.addEventListener('dblclick', () => { store.set('dockW', null); document.body.style.setProperty('--dock-w', Math.round(Math.min(620, Math.max(380, innerWidth * 0.32))) + 'px'); });
}
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && immersive) { setImmersive(false); return; }
  const tag = ev.target.tagName;
  if ((tag === 'INPUT' && !['checkbox', 'range'].includes(ev.target.type)) || tag === 'SELECT' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.toLowerCase(), big = ev.shiftKey ? Math.round(1 / timeline.dt) : 1;
  if (k === ' ') $('play').click();
  else if (k === 'arrowright') { setPlaying(false); seek(st.m.tick + big); }
  else if (k === 'arrowleft') { setPlaying(false); seek(st.m.tick - big); }
  else if (k === 'home') { setPlaying(false); seek(0); }
  else if (k === 'end') { setPlaying(false); seek(timeline.ticks); }
  else if (k === 'r') restart(0);
  else if (k === 't') setTop(!top);
  else if (k === 'f') setImmersive(!immersive);
  else if (k === 'l') { if (immersive) { const fl = $('layerFloat'); fl.classList.toggle('show'); (fl.classList.contains('show') ? fl : $('dock')).appendChild($('layerPanel')); } else $('layerPanel').scrollIntoView({ behavior: 'smooth' }); }
  else return;
  ev.preventDefault();
});

// restore the form, then go
const f = store.get('form', null);
if (f) { for (const [id, v] of Object.entries({ idx: f.idx, setup: f.setup, seed: f.seed, hmode: f.hmode, assistAfter: f.assistAfter, params: f.params, jitter: f.jitter, cap: f.cap })) if (v != null && $(id)) $(id).value = v; $('leash').checked = !!f.leash; $('pushfix').checked = f.pushfix !== false; }
if (!$('params').value && f?.params) $('params').value = '';
new ResizeObserver(() => drawMarks()).observe($('marks'));
await restart(0);
requestAnimationFrame(frame);
