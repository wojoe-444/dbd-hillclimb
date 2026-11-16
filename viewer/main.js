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
const grid = new THREE.GridHelper(Math.max(map.size.w, map.size.h), Math.max(map.size.w, map.size.h) / 8, 0x445044, 0x384038);
grid.position.set(Math.max(map.size.w, map.size.h) / 2, 0.02, Math.max(map.size.w, map.size.h) / 2);
stat.add(grid);
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
    const up = box(p.axis === 'x' ? 0.25 : w, 1.4, p.axis === 'x' ? d : 0.25, mat(0xd99a3a));
    up.position.set(p.x0 + w / 2 + (p.axis === 'x' ? 0.35 : 0), 0.7, p.z0 + d / 2 + (p.axis === 'z' ? 0.35 : 0));
    const down = box(w, 0.3, d, mat(0xd99a3a));
    down.position.set(p.x0 + w / 2, 0.15, p.z0 + d / 2);
    dyn.add(up, down);
    v.pallets.push({ up, down });
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
  view3d = v;
}

function sync() {
  const m = match, v = view3d;
  m.gens.forEach((g, i) => {
    const p = Math.min(1, g.done ? 1 : g.p / m.need);
    const o = v.gens[i];
    o.mesh.material.color.setHSL(0.12, 0.2 + 0.6 * p, 0.3 + 0.25 * p);
    o.mesh.material.emissive.setHex(g.done ? 0x886622 : 0x000000);
    o.light.intensity = g.done ? 25 : p * 6;
  });
  m.ps.forEach((s, i) => { v.pallets[i].up.visible = s === 0; v.pallets[i].down.visible = s === 1; });
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
  v.hunter.userData.body.material.emissive.setHex(H.stunT > 0 ? 0x666600 : H.windT > 0 ? 0x660000 : 0x000000);
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
  $('hud').innerHTML = `<b>${fmtT(m.t)}</b> · gens ${m.gensDone}/${m.gensNeeded}${m.gatesPowered ? ` · <b>GATES</b> ${m.endgameT > 0 ? fmtT(m.endgameT) : ''}` : ''}
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
let champ = { hunter: defaults(brains.hunter.space), survivor: defaults(brains.survivor.space) };
async function loadRuns() {
  const runs = await (await fetch('/api/runs')).json().catch(() => []);
  $('run').innerHTML = runs.length ? runs.map((r) => `<option>${r.name}</option>`).join('') : '<option value="">(no runs — defaults)</option>';
  await loadMeta();
}
async function loadMeta() {
  const name = $('run').value;
  meta = [];
  if (name) {
    const txt = await (await fetch(`../runs/${name}/meta.jsonl`)).text();
    meta = txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
    $('genInfo').textContent = `gen ${r.gen} · ${r.side} ${r.accepted ? 'ACCEPTED' : 'kept'} · kills ${r.after.kills.toFixed(2)} · escapes ${r.after.escapes.toFixed(2)} · gens ${r.after.gensDone.toFixed(2)}`;
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
  line('kills', 4, '#e55');
  line('gensDone', 5, '#5be');
  meta.forEach((r, i) => {
    if (!r.accepted) return;
    g.fillStyle = r.side === 'hunter' ? '#e55' : '#5be';
    g.beginPath(); g.moveTo(X(i), H - 4); g.lineTo(X(i) - 4, H - 12); g.lineTo(X(i) + 4, H - 12); g.fill();
  });
  const sel = +$('gen').value;
  if (sel > 0) { g.strokeStyle = '#fff8'; g.beginPath(); g.moveTo(X(sel - 1), pad); g.lineTo(X(sel - 1), H - pad); g.stroke(); }
  g.fillStyle = '#888'; g.font = '18px system-ui'; g.fillText('4', 2, Y(4, 4) + 5); g.fillText('0', 2, Y(0, 4) + 5);
}

// ---------------------------------------------------------------- loop
let paused = false, acc = 0, last = performance.now();
async function newMatch() {
  const want = $("map").value;
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
$('random').onclick = () => { $('seed').value = Math.floor(Math.random() * 1e6); newMatch(); };
$('run').onchange = loadMeta;
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
$("map").innerHTML = mapList.map((m) => `<option>${m}</option>`).join("");
$("map").value = "maps/gas-heaven.json";
$("map").onchange = newMatch;
await loadRuns();
newMatch();
requestAnimationFrame(frame);
