// 3D viewer: runs the real 2D sim live in the browser and renders it with Three.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMatch } from '../src/sim/index.js';
import { getBrains } from '../src/brains/index.js';
import { defaults } from '../src/hillclimb/params.js';

const $ = (id) => document.getElementById(id);
let map = await (await fetch('../maps/gas-heaven.json')).json();
const mapCache = new Map();
async function loadMap(path) {
  if (!mapCache.has(path)) mapCache.set(path, await (await fetch('../' + path)).json());
  return mapCache.get(path);
}
const brains = getBrains('param', 'param');

// ---------------------------------------------------------------- three setup
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
scene.fog = new THREE.Fog(0x0d0f14, 120, 260);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
const controls = new OrbitControls(camera, renderer.domElement);
const cx = map.size.w / 2, cz = map.size.h / 2;
controls.target.set(cx, 0, cz);
camera.position.set(cx, 95, cz + 85);
controls.update();

scene.add(new THREE.HemisphereLight(0x9ab0ff, 0x202020, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(cx - 40, 90, cz - 30);
sun.target.position.set(cx, 0, cz);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, far: 250 });
scene.add(sun, sun.target);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });
const box = (w, h, d, m) => { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.castShadow = g.receiveShadow = true; return g; };

// ---------------------------------------------------------------- static map (rebuilt when the map changes)
const hookMeshes = new Map();
let stat = new THREE.Group();
scene.add(stat);
function buildStatic(map) {
scene.remove(stat); stat = new THREE.Group(); scene.add(stat); hookMeshes.clear();
const shape = new THREE.Shape(map.outline.map(([x, z]) => new THREE.Vector2(x, z)));
const ground = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat(0x2c3326, { side: THREE.DoubleSide }));
ground.rotation.x = Math.PI / 2; // shape's y -> world z
ground.receiveShadow = true;
stat.add(ground);
// recentre camera target + sun on this map (shaped variants differ in size), keeping the current view offset
{
  const mx = map.size.w / 2, mz = map.size.h / 2, off = camera.position.clone().sub(controls.target);
  controls.target.set(mx, 0, mz); camera.position.copy(controls.target).add(off); controls.update();
  sun.position.set(mx - 40, 90, mz - 30); sun.target.position.set(mx, 0, mz);
}
// 8 m tile grid, only where a tile is inside the outline (maps need not be rectangular)
{
  const C = 8, gw = Math.ceil(map.size.w / C), gh = Math.ceil(map.size.h / C), ol = map.outline;
  const inPoly = (px, pz) => { let r = false; for (let i = 0, j = ol.length - 1; i < ol.length; j = i++) { const [xi, zi] = ol[i], [xj, zj] = ol[j]; if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) r = !r; } return r; };
  const tin = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && inPoly(i * C + C / 2, j * C + C / 2);
  const pts = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i <= gw; i++) if (tin(i, j) && tin(i - 1, j)) pts.push(i * C, 0.02, j * C, i * C, 0.02, j * C + C);
  for (let j = 0; j <= gh; j++) for (let i = 0; i < gw; i++) if (tin(i, j) && tin(i, j - 1)) pts.push(i * C, 0.02, j * C, i * C + C, 0.02, j * C);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  stat.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x445044 })));
}
// outline wall
for (let i = 0; i < map.outline.length; i++) {
  const [x0, z0] = map.outline[i], [x1, z1] = map.outline[(i + 1) % map.outline.length];
  const len = Math.hypot(x1 - x0, z1 - z0);
  const w = box(x0 === x1 ? 0.4 : len, 4, x0 === x1 ? len : 0.4, mat(0x1b1d22));
  w.position.set((x0 + x1) / 2, 2, (z0 + z1) / 2);
  stat.add(w);
}
const kindColor = { wall: 0x5a5f6a, building: 0x6b5d50, rock: 0x6a6a60, car: 0x7a4a3a, tree: 0x3f5a35, crate: 0x8a6d3e, fence: 0x77736a };
for (const o of map.obstacles) {
  const tall = o.height >= (map.eyeHeight ?? 1.6);
  const m = box(o.w, o.height, o.d, mat(kindColor[o.kind] ?? (tall ? 0x5a5f6a : 0x8a8a7a), tall ? {} : { transparent: true, opacity: 0.85 }));
  m.position.set(o.x + o.w / 2, o.height / 2, o.z + o.d / 2);
  stat.add(m);
}
for (const w of map.windows) {
  const frame = box(w.axis === 'x' ? 0.3 : 1, 0.15, w.axis === 'x' ? 1 : 0.3, mat(0x6fc8e8, { emissive: 0x13404f }));
  frame.position.set(w.x + 0.5, 0.9, w.z + 0.5);
  stat.add(frame);
}
for (const h of map.hooks) {
  const g = new THREE.Group();
  const pole = box(0.15, 2.6, 0.15, mat(0x99232f));
  pole.position.y = 1.3;
  const arm = box(0.7, 0.12, 0.12, mat(0x99232f));
  arm.position.set(0.3, 2.5, 0);
  g.add(pole, arm);
  g.position.set(h.x, 0, h.z);
  stat.add(g);
  hookMeshes.set(h.id, pole);
}
for (const g of map.exitGates) {
  const lever = box(0.5, 1.4, 0.5, mat(0x8866cc));
  lever.position.set(g.lever.x, 0.7, g.lever.z);
  const exit = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.0, 24), new THREE.MeshBasicMaterial({ color: 0x8866cc, side: THREE.DoubleSide }));
  exit.rotation.x = -Math.PI / 2; exit.position.set(g.exit.x, 0.05, g.exit.z);
  exit.name = 'exit-' + g.id;
  stat.add(lever, exit);
}
for (const l of map.labels ?? []) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff55'; g.font = 'bold 72px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(l.text, 128, 64);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false }));
  s.scale.set(8, 4, 1); s.position.set(l.x, 6, l.z);
  stat.add(s);
}

}

// ---------------------------------------------------------------- dynamic objects (rebuilt per match)
let dyn = new THREE.Group();
scene.add(dyn);
const survColors = [0x4fa3ff, 0x5be37a, 0xf5d142, 0xd77cff];
const stateNames = ['healthy', 'injured', 'downed', 'carried', 'hooked', 'dead', 'escaped'];

function makeActor(color, height) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, height - 0.8, 4, 12), mat(color));
  body.position.y = height / 2; body.castShadow = true;
  const nose = box(0.2, 0.2, 0.5, mat(0xffffff));
  nose.position.set(0, height * 0.8, 0.45);
  g.add(body, nose);
  g.userData.body = body;
  return g;
}

let match, view3d;
function buildDynamic(m) {
  scene.remove(dyn); dyn = new THREE.Group(); scene.add(dyn);
  const v = { gens: [], pallets: [], survivors: [], hunter: null };
  const used = new Set(m.gens.map((g) => g.id));
  for (const g of map.generators) if (!used.has(g.id)) {   // inert wrecks
    const w = box(1, 1.1, 1, mat(0x333333)); w.position.set(Math.floor(g.x) + 0.5, 0.55, Math.floor(g.z) + 0.5); dyn.add(w);
  }
  for (const g of m.gens) {
    const mesh = box(1, 1.2, 1, mat(0x555555, { emissive: 0x000000 }));
    mesh.position.set(Math.floor(g.x) + 0.5, 0.6, Math.floor(g.z) + 0.5);
    const light = new THREE.PointLight(0xffd070, 0, 10);
    light.position.set(mesh.position.x, 2.5, mesh.position.z);
    dyn.add(mesh, light);
    v.gens.push({ mesh, light });
  }
  for (const p of m.md.pallets) {
    const w = p.x1 - p.x0, d = p.z1 - p.z0;
    const cx = p.x0 + w / 2, cz = p.z0 + d / 2;
    // UPRIGHT: tall pale-yellow board leaning at the side of the gap, plus a yellow floor marker across the gap
    const up = new THREE.Group();
    const board = box(p.axis === 'x' ? 0.2 : w, 2.0, p.axis === 'x' ? d : 0.2, mat(0xf2d24b, { emissive: 0x3a3000 }));
    board.position.set(cx + (p.axis === 'x' ? 0.4 : 0), 1.0, cz + (p.axis === 'z' ? 0.4 : 0));
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xf2d24b, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    mark.rotation.x = -Math.PI / 2; mark.position.set(cx, 0.04, cz);
    up.add(board, mark);
    // DROPPED: thick red-orange slab filling the gap (blocks the hunter) with a glowing top
    const down = box(w, 0.55, d, mat(0xff5a1f, { emissive: 0x5a1400 }));
    down.position.set(cx, 0.28, cz);
    // BROKEN: a few dark splinters on the floor
    const broken = new THREE.Group();
    const splMat = mat(0x5a4632);
    for (let k = 0; k < 5; k++) {
      const sp = box(0.5, 0.08, 0.12, splMat);
      sp.position.set(cx + (k - 2) * 0.22 * (p.axis === 'x' ? 0.3 : 1), 0.05, cz + (k - 2) * 0.22 * (p.axis === 'z' ? 0.3 : 1) + ((k % 2) - 0.5) * 0.3);
      sp.rotation.y = k * 1.1;
      broken.add(sp);
    }
    dyn.add(up, down, broken);
    v.pallets.push({ up, down, broken });
  }
  for (let i = 0; i < 4; i++) { const a = makeActor(survColors[i], 1.7); dyn.add(a); v.survivors.push(a); }
  const h = makeActor(0xd8313b, 2.2);
  const cone = new THREE.Mesh(new THREE.CircleGeometry(14, 32, -50 * Math.PI / 180, 100 * Math.PI / 180),
    new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  cone.rotation.x = -Math.PI / 2; cone.position.y = 0.06;
  const coneWrap = new THREE.Group(); coneWrap.add(cone);
  const terror = new THREE.Mesh(new THREE.RingGeometry(31.7, 32, 96), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  terror.rotation.x = -Math.PI / 2; terror.position.y = 0.05;
  dyn.add(h, coneWrap, terror);
  v.hunter = h; v.cone = coneWrap; v.terror = terror;
  // hunter belief heat map overlay (what the hunter thinks: where survivors could be)
  const b = m.hunter.brain && m.hunter.brain.belief;
  if (b) {
    const data = new Uint8Array(b.W * b.H * 4);
    const tex = new THREE.DataTexture(data, b.W, b.H, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(b.W * b.cs, b.H * b.cs),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    plane.rotation.x = -Math.PI / 2;                // plane's +y (texture rows) -> world -z; flip below
    plane.scale.y = -1;
    plane.position.set((b.W * b.cs) / 2, 0.08, (b.H * b.cs) / 2);
    dyn.add(plane);
    v.heat = { b, data, tex, plane };
  }
  view3d = v;
}

function syncHeat() {
  const hv = view3d.heat;
  if (!hv) return;
  hv.plane.visible = $('heat').checked;
  if (!hv.plane.visible) return;
  const h = hv.b.heat();
  let max = 1e-6; for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
  for (let i = 0; i < h.length; i++) {
    const v = Math.min(1, Math.sqrt(h[i] / max));
    hv.data[i * 4] = 255; hv.data[i * 4 + 1] = Math.round(200 * (1 - v)); hv.data[i * 4 + 2] = 40;
    hv.data[i * 4 + 3] = Math.round(170 * v);
  }
  hv.tex.needsUpdate = true;
}

function sync() {
  syncHeat();
  const m = match, v = view3d;
  m.gens.forEach((g, i) => {
    const p = Math.min(1, g.done ? 1 : g.p / m.need);
    const o = v.gens[i];
    o.mesh.material.color.setHSL(0.12, 0.2 + 0.6 * p, 0.3 + 0.25 * p);
    o.mesh.material.emissive.setHex(g.done ? 0x886622 : 0x000000);
    o.light.intensity = g.done ? 25 : p * 6;
  });
  m.ps.forEach((s, i) => { const q = v.pallets[i]; q.up.visible = s === 0; q.down.visible = s === 1; q.broken.visible = s === 2; });
  // survivors face: sim facing angle a means direction (cos a, sin a) in x/z
  const place = (obj, x, z, face) => { obj.position.set(x, 0, z); obj.rotation.y = Math.PI / 2 - face; };
  m.survivors.forEach((s, i) => {
    const a = v.survivors[i];
    a.visible = s.st < 5;
    place(a, s.x, s.z, s.face);
    const body = a.userData.body;
    body.rotation.x = s.st === 2 || s.st === 3 ? Math.PI / 2 : 0;
    body.position.y = s.st === 2 ? 0.4 : s.st === 3 ? 2.3 : s.st === 4 ? 1.4 : 0.85;
    body.material.emissive.setHex(s.st === 1 ? 0x661111 : s.st === 4 ? 0x660000 : 0x000000);
  });
  const H = m.hunter;
  place(v.hunter, H.x, H.z, H.face);
  // stunned = yellow glow, lunging = red glow, attack cooldown (post-hit/miss slowdown) = blue-grey glow
  v.hunter.userData.body.material.emissive.setHex(H.stunT > 0 ? 0x666600 : H.windT > 0 ? 0x660000 : H.cdT > 0 ? 0x2a3a66 : 0x000000);
  v.cone.position.set(H.x, 0, H.z); v.cone.rotation.y = -H.face;
  v.terror.position.set(H.x, 0.05, H.z);
  for (const hk of m.hooks) hookMeshes.get(hk.id).material.color.setHex(hk.occ >= 0 ? 0xff3344 : 0x99232f);
}

// ---------------------------------------------------------------- HUD / log
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function hud() {
  const m = match;
  const rows = m.survivors.map((s, i) => {
    const c = '#' + survColors[i].toString(16).padStart(6, '0');
    let extra = s.st === 4 ? ` (hook ${s.hookCount}, stage ${s.hookStage})` : s.hookCount ? ` · hooks ${s.hookCount}` : '';
    return `<div class="row"><span class="dot" style="background:${c}"></span>S${i} ${stateNames[s.st]}${extra}${s.curAct ? ' · ' + s.curAct : ''}</div>`;
  }).join('');
  const H = m.hunter;
  const hs = H.vault ? 'vaulting' : H.stunT > 0 ? 'stunned' : H.windT > 0 ? 'lunging' : H.cdT > 0 ? 'cooldown' : H.curAct ?? (H.carrying >= 0 ? `carrying S${H.carrying}` : 'hunting');
  $('hud').innerHTML = `<div style="color:#9ab">${(map.id || map._path || '').replace('gas-heaven-', 'variant ')}</div><b>${fmtT(m.t)}</b> · gens ${m.gensDone}/${m.gensNeeded}${m.gatesPowered ? ` · <b>GATES</b> ${m.endgameT > 0 ? fmtT(m.endgameT) : ''}` : ''}
    ${m.over ? ` · <b>OVER</b> (${m.result().kills}K / ${m.result().escapes}E)` : ''}
    <div class="row" style="margin-top:4px"><span class="dot" style="background:#d8313b"></span>Hunter ${hs}</div>${rows}`;
}
let logged = 0;
function log() {
  const ev = match.events;
  if (ev.length === logged) return;
  const el = $('log');
  for (; logged < ev.length; logged++) {
    const e = ev[logged];
    const { t, type, ...rest } = e;
    el.textContent += `${fmtT(t)} ${type} ${Object.entries(rest).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ')}\n`;
  }
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- meta runs
let meta = [];
let runKinds = {};
let variantPool = [];
let champ = { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
async function loadRuns() {
  const runs = await (await fetch('/api/runs')).json().catch(() => []);
  runKinds = Object.fromEntries(runs.map((r) => [r.name, r.kind]));
  $('run').innerHTML = runs.length ? runs.map((r) => `<option value="${r.name}">${r.name}${r.kind === 'evolve' ? ' (population)' : ''}</option>`).join('') : '<option value="">(no runs — defaults)</option>';
  await loadMeta();
}
async function loadMeta() {
  const name = $('run').value;
  meta = [];
  if (name && runKinds[name] === 'evolve') {
    // population run: one record per generation; "champion" = the top-ranked individual of each population
    const txt = await (await fetch(`../runs/${name}/evo.jsonl`)).text();
    meta = txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => ({
      gen: e.gen, side: 'population', accepted: false, evo: e,
      after: { kills: e.outcome.kills, escapes: e.outcome.escapes, gensDone: e.outcome.gensDone, hookStages: e.outcome.hookStages },
      champ: { hunter: e.hunters.ranking[0].params, survivor: e.survivors.ranking[0].params },
    }));
  } else if (name) {
    const txt = await (await fetch(`../runs/${name}/meta.jsonl`)).text();
    meta = txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  // knob picker for population runs
  const evo = meta.length && meta[0].evo;
  $('knobBox').style.display = evo ? '' : 'none';
  if (evo) {
    const cur = $('knob').value;
    const opts = [...Object.keys(evo.hunters.knobs).map((k) => 'hunter:' + k), ...Object.keys(evo.survivors.knobs).map((k) => 'survivor:' + k)];
    $('knob').innerHTML = opts.map((o) => `<option>${o}</option>`).join('');
    $('knob').value = opts.includes(cur) ? cur : 'hunter:tunnel';
  }
  $('gen').max = meta.length;
  $('gen').value = meta.length;
  drawChart(); pickGen();
}
function pickGen() {
  const g = +$('gen').value;
  if (g === 0 || !meta.length) {
    champ = { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
    $('genInfo').textContent = 'generation 0 (default params)';
  } else {
    const r = meta[g - 1];
    champ = r.champ;
    $('genInfo').textContent = r.evo ? `gen ${r.gen} · population · best hunter ${r.evo.hunters.ranking[0].id} (${r.evo.hunters.ranking[0].bp} BP) vs best team ${r.evo.survivors.ranking[0].id} (${r.evo.survivors.ranking[0].bp} BP) · avg kills ${r.after.kills.toFixed(2)} · escapes ${r.after.escapes.toFixed(2)} · gens ${r.after.gensDone.toFixed(2)}` : `gen ${r.gen} · ${r.side} ${r.accepted ? 'ACCEPTED' : 'kept'} · kills ${r.after.kills.toFixed(2)} · escapes ${r.after.escapes.toFixed(2)} · gens ${r.after.gensDone.toFixed(2)}`;
  }
  const d = { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
  const fmt = (side) => Object.entries(champ[side]).map(([k, v]) => {
    const delta = v - d[side][k];
    return `${k.padEnd(14)} ${(+v).toFixed(2).padStart(7)} ${Math.abs(delta) > 1e-6 ? (delta > 0 ? '▲' : '▼') : ' '}`;
  }).join('\n');
  $('params').textContent = `HUNTER\n${fmt('hunter')}\n\nSURVIVORS\n${fmt('survivor')}`;
  drawChart();
}
function drawChart() {
  const c = $('chart'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!meta.length) return;
  const n = meta.length, W = c.width, H = c.height, pad = 20;
  const X = (i) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad);
  const Y = (v, max) => H - pad - (v / max) * (H - 2 * pad);
  g.strokeStyle = '#333'; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { g.beginPath(); g.moveTo(pad, Y(k, 4)); g.lineTo(W - pad, Y(k, 4)); g.stroke(); }
  const line = (key, max, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    meta.forEach((r, i) => (i ? g.lineTo(X(i), Y(r.after[key], max)) : g.moveTo(X(i), Y(r.after[key], max))));
    g.stroke();
  };
  // hunter line: average hook stages (0..12) for population runs; kills (0..4) for old climb runs
  const stages = meta[0].after.hookStages !== undefined;
  line(stages ? 'hookStages' : 'kills', stages ? 12 : 4, '#e55');
  line('gensDone', 5, '#5be');
  meta.forEach((r, i) => {
    if (!r.accepted) return;
    g.fillStyle = r.side === 'hunter' ? '#e55' : '#5be';
    g.beginPath(); g.moveTo(X(i), H - 4); g.lineTo(X(i) - 4, H - 12); g.lineTo(X(i) + 4, H - 12); g.fill();
  });
  const sel = +$('gen').value;
  if (sel > 0) { g.strokeStyle = '#fff8'; g.beginPath(); g.moveTo(X(sel - 1), pad); g.lineTo(X(sel - 1), H - pad); g.stroke(); }
  g.fillStyle = '#888'; g.font = '18px system-ui'; g.fillText(stages ? '12' : '4', 2, Y(4, 4) + 5); g.fillText('0', 2, Y(0, 4) + 5);
  $('hunterLegend').textContent = stages ? '■ hunter: avg hook stages (0–12)' : '■ avg kills (0–4)';
  drawKnobChart();
}

// population runs: how one knob is distributed across the population, generation by generation
function drawKnobChart() {
  const c = $('knobChart'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!meta.length || !meta[0].evo) return;
  const [side, key] = $('knob').value.split(':');
  const space = (side === 'hunter' ? brains.hunter.space : brains.survivor.space)[key];
  if (!space) return;
  const [lo, hi] = space;
  const n = meta.length, W = c.width, H = c.height, pad = 22;
  const X = (i) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad);
  const Y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const st = (r) => r.evo[side === 'hunter' ? 'hunters' : 'survivors'].knobs[key];
  // individual values as faint dots
  g.fillStyle = '#7aa7ff33';
  meta.forEach((r, i) => { for (const v of st(r).values) { g.fillRect(X(i) - 1, Y(v) - 1, 2.5, 2.5); } });
  // quartile band + median
  g.fillStyle = '#7aa7ff40'; g.beginPath();
  meta.forEach((r, i) => (i ? g.lineTo(X(i), Y(st(r).q75)) : g.moveTo(X(i), Y(st(r).q75))));
  for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(st(meta[i]).q25));
  g.closePath(); g.fill();
  g.strokeStyle = '#9cf'; g.lineWidth = 2; g.beginPath();
  meta.forEach((r, i) => (i ? g.lineTo(X(i), Y(st(r).med)) : g.moveTo(X(i), Y(st(r).med))));
  g.stroke();
  // best individual's value
  g.fillStyle = '#ffd24a';
  meta.forEach((r, i) => { const v = r.evo[side === 'hunter' ? 'hunters' : 'survivors'].ranking[0].params[key]; g.fillRect(X(i) - 1.5, Y(v) - 1.5, 3, 3); });
  const sel = +$('gen').value;
  if (sel > 0) { g.strokeStyle = '#fff8'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(sel - 1), pad); g.lineTo(X(sel - 1), H - pad); g.stroke(); }
  g.fillStyle = '#888'; g.font = '16px system-ui';
  g.fillText(String(hi), 2, Y(hi) + 5); g.fillText(String(lo), 2, Y(lo) + 5);
  g.fillText(`${side} ${key}: dots = individuals, band = middle 50%, line = median, yellow = best`, pad, 16);
}

// ---------------------------------------------------------------- loop
let paused = false, acc = 0, last = performance.now();
async function newMatch() {
  // "auto": the variant the evolution workers would use for this seed (pool sorted like loadMapPool: v000..v031; seed % n)
  let want = $("map").value;
  if (want === "auto") want = variantPool.length ? variantPool[(+$("seed").value || 1) % variantPool.length] : "maps/gas-heaven.json";
  if (want && want !== map._path) { map = await loadMap(want); map._path = want; buildStatic(map); }
  const seed = +$('seed').value || 1;
  const use = $('useChamp').checked ? champ : { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
  const live = { ...map }; delete live._path;
  match = createMatch({ map: live, seed, hunter: brains.hunter.make(use.hunter), survivors: brains.survivor.make(use.survivor) });
  buildDynamic(match);
  logged = 0; $('log').textContent = '';
  sync(); hud();
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!paused && match && !match.over) {
    acc += dt * +$('speed').value * 10;
    let n = 0;
    while (acc >= 1 && n < 400 && !match.over) { match.step(); acc -= 1; n++; }
    if (n >= 400) acc = 0;
    sync(); hud(); log();
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

$('play').onclick = () => { paused = !paused; $('play').textContent = paused ? 'Play' : 'Pause'; };
$('restart').onclick = newMatch;
$('seed').onchange = newMatch;
$('random').onclick = () => { $('seed').value = Math.floor(Math.random() * 1e6); newMatch(); };
$('run').onchange = loadMeta;
$('knob').onchange = drawKnobChart;
$('gen').oninput = () => { pickGen(); };
$('gen').onchange = newMatch;
$('useChamp').onchange = newMatch;
let top = false;
$('cam').onclick = () => {
  top = !top; $('cam').classList.toggle('on', top);
  controls.target.set(cx, 0, cz);
  camera.position.set(cx, top ? 140 : 95, top ? cz + 0.01 : cz + 85);
};

buildStatic(map);
map._path = "maps/gas-heaven.json";
const mapList = await (await fetch("/api/maps")).json().catch(() => ["maps/gas-heaven.json"]);
variantPool = mapList.filter((m) => m.startsWith('maps/gas-heaven/v') && m.endsWith('.json')).sort();
$("map").innerHTML = `<option value="auto">auto: variant by seed (what the bots train on)</option>` + mapList.map((m) => `<option>${m}</option>`).join("");
$("map").value = variantPool.length ? "auto" : "maps/gas-heaven.json";
$("map").onchange = newMatch;
await loadRuns();
newMatch();
requestAnimationFrame(frame);
