// Shared Three.js scene for the viewer pages (index.html = matches / evolution runs, duel.html = 1v1 shack duels).
// createScene(container) builds renderer + camera + lights; buildStatic(map) the level; buildDynamic(match, map) the
// actors / gens / pallets / belief heat; sync(match) moves everything to the match's current state.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export { THREE };
export const survColors = [0x4fa3ff, 0x5be37a, 0xf5d142, 0xd77cff];
export const survCss = survColors.map((c) => '#' + c.toString(16).padStart(6, '0'));
export const stateNames = ['healthy', 'injured', 'downed', 'carried', 'hooked', 'dead', 'escaped'];

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });
const box = (w, h, d, m) => { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.castShadow = g.receiveShadow = true; return g; };

/**
 * opts: { heatOn: () => boolean, actors: number of survivors to draw (default 4) }
 */
export function createScene(container, opts = {}) {
  const heatOn = opts.heatOn ?? (() => true);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f14);
  scene.fog = new THREE.Fog(0x0d0f14, 120, 260);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
  const controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0x9ab0ff, 0x202020, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, far: 250 });
  scene.add(sun, sun.target);
  let center = { x: 48, z: 48 }, span = 96;
  controls.target.set(center.x, 0, center.z);
  camera.position.set(center.x, 95, center.z + 85);
  controls.update();

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container); resize();

  // ------------------------------------------------------------------ static map
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
      center = { x: mx, z: mz }; span = Math.max(map.size.w, map.size.h);
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

  // ------------------------------------------------------------------ dynamic objects (rebuilt per match)
  let dyn = new THREE.Group();
  scene.add(dyn);
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
  let v = null;
  function buildDynamic(m, map) {
    scene.remove(dyn); dyn = new THREE.Group(); scene.add(dyn);
    v = { gens: [], pallets: [], survivors: [], hunter: null };
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
  }

  function syncHeat() {
    const hv = v.heat;
    if (!hv) return;
    hv.plane.visible = heatOn();
    if (!hv.plane.visible) return;
    const h = hv.b.heat();
    let max = 1e-6; for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    for (let i = 0; i < h.length; i++) {
      const q = Math.min(1, Math.sqrt(h[i] / max));
      hv.data[i * 4] = 255; hv.data[i * 4 + 1] = Math.round(200 * (1 - q)); hv.data[i * 4 + 2] = 40;
      hv.data[i * 4 + 3] = Math.round(170 * q);
    }
    hv.tex.needsUpdate = true;
  }

  function sync(m) {
    if (!v) return;
    syncHeat();
    m.gens.forEach((g, i) => {
      const p = Math.min(1, g.done ? 1 : g.p / m.need);
      const o = v.gens[i];
      o.mesh.material.color.setHSL(0.12, 0.2 + 0.6 * p, 0.3 + 0.25 * p);
      o.mesh.material.emissive.setHex(g.done ? 0x886622 : 0x000000);
      o.light.intensity = g.done ? 25 : p * 6;
    });
    m.ps.forEach((s, i) => { const q = v.pallets[i]; q.up.visible = s === 0; q.down.visible = s === 1; q.broken.visible = s === 2; });
    // sim facing angle a means direction (cos a, sin a) in x/z
    const place = (obj, x, z, face) => { obj.position.set(x, 0, z); obj.rotation.y = Math.PI / 2 - face; };
    m.survivors.forEach((s, i) => {
      const a = v.survivors[i];
      a.visible = s.st < 5 && (!opts.hideSurvivor || !opts.hideSurvivor(i));
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
    for (const hk of m.hooks) hookMeshes.get(hk.id)?.material.color.setHex(hk.occ >= 0 ? 0xff3344 : 0x99232f);
  }

  function setTopDown(top) {
    controls.target.set(center.x, 0, center.z);
    const hgt = Math.max(30, span * 1.45);
    camera.position.set(center.x, top ? hgt : hgt * 0.68, top ? center.z + 0.01 : center.z + hgt * 0.6);
    controls.update();
  }
  function render() { controls.update(); renderer.render(scene, camera); }

  return { THREE, renderer, scene, camera, controls, buildStatic, buildDynamic, sync, render, resize, setTopDown, get terror() { return v && v.terror; } };
}
