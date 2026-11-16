// Overlay layer system for the 3D viewers (index.html match view, duel.html shack duels).
// Every layer reads a live match + the brains' read-only debug() snapshots (src/brains/hunter.js / survivor.js) and
// never writes to either. Settings (on, opacity, agent, ramp, threshold, colour, extra options) persist in localStorage.
//
//   const L = createLayers({ scene3d, panel, storeKey, defaults: { 'h-belief': { on: true } } });
//   L.rebuild(match, map)  -- after a new match / map;  L.update(force)  -- each frame (throttled to ~5 Hz)
import { survCss } from './scene.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RAMPS = {
  heat: [[0, [255, 230, 80]], [0.5, [255, 120, 30]], [1, [220, 20, 30]]],
  ice: [[0, [190, 250, 255]], [0.5, [60, 160, 255]], [1, [40, 50, 200]]],
  viridis: [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]],
  magma: [[0, [20, 10, 50]], [0.4, [140, 40, 120]], [0.7, [240, 100, 70]], [1, [252, 250, 190]]],
  green: [[0, [200, 255, 200]], [1, [20, 150, 40]]],
  mono: [[0, [255, 255, 255]], [1, [255, 255, 255]]],
};
function rampColor(name, v) {
  const st = RAMPS[name] || RAMPS.heat;
  for (let k = 1; k < st.length; k++) if (v <= st[k][0]) { const [a, ca] = st[k - 1], [b, cb] = st[k], f = (v - a) / (b - a || 1); return [0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * f)); }
  return st[st.length - 1][1];
}
const RAMP_CHOICES = Object.keys(RAMPS);
const AGENTS_S = [['0', 'S0'], ['1', 'S1'], ['2', 'S2'], ['3', 'S3']];
const AGENTS_ANY = [['h', 'hunter'], ...AGENTS_S];

// ------------------------------------------------------------------------------------------------ layer catalogue
// kind: 'grid' (heat texture) or 'vec' (lines / markers / labels rebuilt per update). agent: null | 'S' | 'any'.
// opts: extra controls [{ k, label, type: 'select'|'range'|'check'|'color', choices, min, max, step }]
const LAYERS = [
  // ---- hunter
  { id: 'h-belief', group: 'Hunter', name: 'Belief: where survivors are', kind: 'grid', d: { on: true, opacity: 0.65, ramp: 'heat', threshold: 0.02, who: 'all', norm: 'relative' },
    opts: [{ k: 'who', label: 'survivor', type: 'select', choices: [['all', 'combined'], ...AGENTS_S] }, { k: 'ramp', type: 'select', choices: RAMP_CHOICES }, { k: 'norm', type: 'select', choices: [['relative', 'scale to max'], ['absolute', 'probability']] }, { k: 'threshold', type: 'range', min: 0, max: 0.5, step: 0.01 }] },
  { id: 'h-goal', group: 'Hunter', name: 'Target, goal & mode', kind: 'vec', d: { on: true, opacity: 0.9, color: '#ff5050', label: true }, opts: [{ k: 'color', type: 'color' }, { k: 'label', label: 'mode label', type: 'check' }] },
  { id: 'h-path', group: 'Hunter', name: 'Planned path', kind: 'vec', d: { on: true, opacity: 0.85, color: '#ff8a5c' }, opts: [{ k: 'color', type: 'color' }] },
  { id: 'h-cone', group: 'Hunter', name: 'Vision cone', kind: 'vec', d: { on: true, opacity: 0.12, color: '#ff4040', len: 'short' }, opts: [{ k: 'len', label: 'length', type: 'select', choices: [['short', '14 m'], ['real', 'real range']] }, { k: 'color', type: 'color' }] },
  { id: 'h-terror', group: 'Hunter', name: 'Terror radius rings', kind: 'vec', d: { on: true, opacity: 0.3, color: '#ff3030', layers: true }, opts: [{ k: 'layers', label: 'all 3 layers', type: 'check' }, { k: 'color', type: 'color' }] },
  // ---- survivor (agent selector)
  { id: 's-plan', group: 'Survivor', name: 'Flee plan: loop circuit, next crossing, flee point', agent: 'S', kind: 'vec', d: { on: false, opacity: 0.95, agent: '0', label: true }, opts: [{ k: 'label', label: 'mode label', type: 'check' }] },
  { id: 's-route', group: 'Survivor', name: 'Route as it understands it', agent: 'S', kind: 'vec', d: { on: false, opacity: 0.9, agent: '0', color: '#5be3ff', nav: true }, opts: [{ k: 'nav', label: 'engine nav route too', type: 'check' }, { k: 'color', type: 'color' }] },
  { id: 's-know', group: 'Survivor', name: 'Map knowledge (explored, known gens / windows / pallets)', agent: 'S', kind: 'grid', d: { on: false, opacity: 0.45, agent: '0', ramp: 'green', unseen: true }, opts: [{ k: 'unseen', label: 'shade unexplored', type: 'check' }, { k: 'ramp', type: 'select', choices: RAMP_CHOICES }] },
  { id: 's-hbelief', group: 'Survivor', name: 'Belief: where the hunter is', agent: 'S', kind: 'grid', d: { on: false, opacity: 0.6, agent: '0', ramp: 'ice', threshold: 0.02, norm: 'relative' },
    opts: [{ k: 'ramp', type: 'select', choices: RAMP_CHOICES }, { k: 'norm', type: 'select', choices: [['relative', 'scale to max'], ['absolute', 'probability']] }, { k: 'threshold', type: 'range', min: 0, max: 0.5, step: 0.01 }] },
  { id: 's-fields', group: 'Survivor', name: 'Route distance field (its own / hunter estimate)', agent: 'S', kind: 'grid', d: { on: false, opacity: 0.5, agent: '0', ramp: 'viridis', which: 'fS', maxM: 40 },
    opts: [{ k: 'which', type: 'select', choices: [['fS', 'my distance'], ['fH', "hunter's distance"], ['gap', 'gap (hunter - me)']] }, { k: 'ramp', type: 'select', choices: RAMP_CHOICES }, { k: 'maxM', label: 'max m', type: 'range', min: 5, max: 80, step: 1 }] },
  { id: 's-cover', group: 'Survivor', name: 'Cover map', agent: 'S', kind: 'grid', d: { on: false, opacity: 0.5, agent: '0', ramp: 'magma', threshold: 0 }, opts: [{ k: 'ramp', type: 'select', choices: RAMP_CHOICES }, { k: 'threshold', type: 'range', min: 0, max: 1, step: 0.02 }] },
  { id: 's-cam', group: 'Survivor', name: 'Camera view cone', agent: 'S', kind: 'vec', d: { on: false, opacity: 0.12, agent: '0', all: false }, opts: [{ k: 'all', label: 'all survivors', type: 'check' }] },
  { id: 's-mates', group: 'Survivor', name: 'Teammate estimates + heard intents', agent: 'S', kind: 'vec', d: { on: false, opacity: 0.7, agent: '0' } },
  { id: 's-scratch', group: 'Survivor', name: 'Scratch marks left', agent: 'S', kind: 'vec', d: { on: false, opacity: 0.9, agent: '0', all: true, age: 10 }, opts: [{ k: 'all', label: 'all survivors', type: 'check' }, { k: 'age', label: 'max age s', type: 'range', min: 2, max: 30, step: 1 }] },
  { id: 's-intents', group: 'Survivor', name: 'Intents sent (speech labels)', kind: 'vec', d: { on: false, opacity: 1, hold: 4 }, opts: [{ k: 'hold', label: 'show s', type: 'range', min: 1, max: 15, step: 1 }] },
  // ---- world
  { id: 'w-los', group: 'World', name: 'Visibility (line of sight)', agent: 'any', kind: 'vec', d: { on: false, opacity: 0.22, agent: 'h', color: '#fff3a0', cone: false }, opts: [{ k: 'cone', label: 'view cone only', type: 'check' }, { k: 'color', type: 'color' }] },
  { id: 'w-nav', group: 'World', name: 'Nav grid (solid / window / pallet cells)', kind: 'grid', static: true, d: { on: false, opacity: 0.5 } },
  { id: 'w-tiles', group: 'World', name: 'Tile footprints + names, dead zones', kind: 'vec', static: true, d: { on: false, opacity: 0.8, names: true, dead: true }, opts: [{ k: 'names', type: 'check' }, { k: 'dead', label: 'dead zones', type: 'check' }] },
  { id: 'w-loops', group: 'World', name: 'Loop strength (distance held per window / pallet)', kind: 'vec', static: true, d: { on: false, opacity: 0.95, min: 0 }, opts: [{ k: 'min', label: 'hide below m', type: 'range', min: 0, max: 30, step: 1 }] },
  { id: 'w-gens', group: 'World', name: 'Generators: progress / regression', kind: 'vec', d: { on: false, opacity: 0.95 } },
  { id: 'w-hooks', group: 'World', name: 'Hooks + coverage', kind: 'vec', d: { on: false, opacity: 0.35, r: 12 }, opts: [{ k: 'r', label: 'radius m', type: 'range', min: 4, max: 40, step: 1 }] },
  { id: 'w-pallets', group: 'World', name: 'Pallet / window state labels', kind: 'vec', d: { on: false, opacity: 0.95 } },
];

export function createLayers({ scene3d, panel, storeKey = 'layers', defaults = {} }) {
  const { THREE, scene } = scene3d;
  const root = new THREE.Group(); root.name = 'layers'; scene.add(root);
  // ---- settings
  const K = 'dbdv.' + storeKey;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(K) || '{}') || {}; } catch { saved = {}; }
  const S = {};
  for (const L of LAYERS) S[L.id] = { ...L.d, ...(defaults[L.id] || {}), ...(saved[L.id] || {}) };
  const save = () => { try { localStorage.setItem(K, JSON.stringify(S)); } catch { /* private mode */ } };
  let match = null, map = null, lastUp = 0;
  const built = new Set(), cost = new Map();
  const groups = new Map(), grids = new Map(), info = new Map();
  LAYERS.forEach((L, k) => { const g = new THREE.Group(); g.renderOrder = 10 + k; root.add(g); groups.set(L.id, g); });

  // ---- three helpers
  const disposeGroup = (g) => { for (const c of [...g.children]) { g.remove(c); c.traverse?.((o) => { o.geometry?.dispose(); if (o.material) { if (o.material.map && !o.material.map.userData.cached) o.material.map.dispose(); o.material.dispose(); } }); } };
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false });
  const fillMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  function segs(g, pts, color, opacity, y = 0.15) {   // pts: [[x0,z0,x1,z1], ...]
    if (!pts.length) return;
    const a = []; for (const [x0, z0, x1, z1] of pts) a.push(x0, y, z0, x1, y, z1);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    const l = new THREE.LineSegments(geo, lineMat(color, opacity)); l.renderOrder = 20; g.add(l);
  }
  function poly(g, pts, color, opacity, y = 0.15, closed = false) {   // pts: [{x,z}] or [[x,z]]
    if (pts.length < 2) return;
    const a = []; for (const p of pts) { const x = p.x ?? p[0], z = p.z ?? p[1]; a.push(x, y, z); }
    if (closed) a.push(a[0], a[1], a[2]);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    const l = new THREE.Line(geo, lineMat(color, opacity)); l.renderOrder = 20; g.add(l);
  }
  function ring(g, x, z, r, color, opacity, y = 0.12, seg = 48) { const p = []; for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI * 2; p.push([x + r * Math.cos(a), z + r * Math.sin(a)]); } poly(g, p, color, opacity, y); }
  function disc(g, x, z, r, color, opacity, y = 0.1) { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), fillMat(color, opacity)); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); g.add(m); }
  function fan(g, x, z, face, half, r, color, opacity, y = 0.07) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40, -half, 2 * half), fillMat(color, opacity));
    m.rotation.x = -Math.PI / 2; const w = new THREE.Group(); w.add(m); w.position.set(x, y, z); w.rotation.y = -face; g.add(w);
  }
  function quad(g, x0, z0, x1, z1, color, opacity, y = 0.09) { const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0)), fillMat(color, opacity)); m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); g.add(m); }
  const texCache = new Map();
  function label(g, text, x, z, { color = '#ffffff', bg = '#000000b0', y = 3, size = 1 } = {}) {
    const key = text + '|' + color + '|' + bg;
    let tc = texCache.get(key);
    if (!tc) {
    if (texCache.size > 1500) { for (const v of texCache.values()) v.tex.dispose(); texCache.clear(); }
    const c = document.createElement('canvas'), fs = 30, ctx2 = c.getContext('2d');
    ctx2.font = `600 ${fs}px system-ui`; const w = Math.ceil(ctx2.measureText(text).width) + 16;
    c.width = w; c.height = fs + 14; ctx2.font = `600 ${fs}px system-ui`;
    ctx2.fillStyle = bg; ctx2.beginPath(); ctx2.roundRect?.(0, 0, w, c.height, 8); ctx2.fill();
    ctx2.fillStyle = color; ctx2.textBaseline = 'middle'; ctx2.fillText(text, 8, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.userData.cached = true;
    tc = { tex, w, h: c.height }; texCache.set(key, tc);
    }
    const { tex, w } = tc, c = { height: tc.h };
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }));   // constant screen size
    const h = 0.032 * size; sp.scale.set((h * w) / c.height, h, 1); sp.position.set(x, y, z); sp.renderOrder = 30; g.add(sp);
    return sp;
  }
  function gridOf(id, W, H, cs) {
    let gr = grids.get(id);
    if (gr && gr.W === W && gr.H === H && gr.cs === cs) return gr;
    if (gr) { groups.get(id).remove(gr.mesh); gr.mesh.geometry.dispose(); gr.mesh.material.dispose(); gr.tex.dispose(); }
    const data = new Uint8Array(W * H * 4), tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W * cs, H * cs), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.scale.y = -1;          // texture rows = +z
    mesh.position.set((W * cs) / 2, 0.06 + 0.004 * LAYERS.findIndex((l) => l.id === id), (H * cs) / 2);
    groups.get(id).add(mesh);
    gr = { W, H, cs, data, tex, mesh }; grids.set(id, gr);
    return gr;
  }
  // fill a grid from values (NaN / negative = transparent); v01 maps a value to 0..1 (null = transparent)
  function paint(gr, n, v01, ramp, smooth = true, alphaOf = (q) => 0.25 + 0.75 * q) {
    const d = gr.data;
    for (let i = 0; i < n; i++) {
      const q = v01(i);
      if (q == null || Number.isNaN(q)) { d[i * 4 + 3] = 0; continue; }
      const [r, g, b] = rampColor(ramp, Math.max(0, Math.min(1, q)));
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = Math.round(255 * alphaOf(Math.max(0, Math.min(1, q))));
    }
    gr.tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter; gr.tex.needsUpdate = true;
  }

  // ---- snapshots (once per update; only the opt-in heavy parts that an enabled layer needs)
  let snap = null;
  function hunterDbg() { if (!snap.h) snap.h = match.hunter.brain?.debug?.() ?? null; return snap.h; }
  function survDbg(i) {
    i = +i;
    if (!(i in snap.s)) {
      const need = { fields: S['s-fields'].on && +S['s-fields'].agent === i, cover: S['s-cover'].on && +S['s-cover'].agent === i, loops: false };
      snap.s[i] = match.survivors[i]?.brain?.debug?.(match.t, need) ?? null;
    }
    return snap.s[i];
  }
  let loopsCache = null;   // static per map: from S0's LoopModel (lazy fields = deterministic memo)
  const agentPos = (a) => (a === 'h' ? match.hunter : match.survivors[+a]);
  const col = (s, fb) => s.color || fb;

  // static per-map scans
  function navRoute(actor) {
    const rt = actor.nav && actor.nav.rt, to = (actor.lastAction || {}).moveTo;
    if (!rt || !rt.nodes || !to) return null;
    const W = match.W, out = [];
    if (rt.tc !== Math.floor(to.z) * W + Math.floor(to.x) || rt.ver !== match.palVersion) return null;   // stale: planned for an older goal
    for (let k = Math.max(0, rt.i); k < rt.nodes.length; k++) { const c = rt.nodes[k]; out.push([(c % W) + 0.5, Math.floor(c / W) + 0.5]); }
    return out.length > 1 ? out : null;
  }
  function visPoly(ax, az, face, half, range) {
    const md = match.md, W = match.W, Hh = match.Hh ?? Math.ceil(map.size.h), sight = md.sight, semi = match.cfg.sight.semiTransparency ?? 0.6, thr = match.cfg.sight.visThreshold ?? 0.5;
    const pts = [[ax, az]], n = half >= Math.PI ? 240 : Math.round(120 * half / Math.PI) + 8, step = 0.25;
    for (let k = 0; k <= n; k++) {
      const a = face - half + (2 * half * k) / n, dx = Math.cos(a), dz = Math.sin(a);
      let vis = 1, last = -2, d = 0; const own = sight[Math.floor(az) * W + Math.floor(ax)];
      for (d = step; d < range; d += step) {
        const x = ax + dx * d, z = az + dz * d, i = Math.floor(x), j = Math.floor(z);
        if (i < 0 || j < 0 || i >= W || j >= Hh) break;
        const s = sight[j * W + i];
        if (s === -1) break;
        if (s > 0 && s !== last && s !== own) { vis *= semi; last = s; if (vis < thr) break; }
      }
      pts.push([ax + dx * d, az + dz * d]);
    }
    return pts;
  }

  // ---- per-layer renderers (vec layers rebuild their group; grid layers repaint their texture)
  const R = {
    'h-belief'(g, s) {
      const d = hunterDbg(); if (!d) return 'hunter brain exposes no belief';
      const b = d.belief, gr = gridOf('h-belief', b.W, b.H, b.cs), n = b.W * b.H;
      const vals = new Float32Array(n);
      const ks = s.who === 'all' ? [0, 1, 2, 3].filter((k) => b.state[k] === 'alive') : [+s.who];
      for (const k of ks) { const p = b.p[k]; for (let i = 0; i < n; i++) vals[i] += p[i]; }
      let mx = 1e-9; for (let i = 0; i < n; i++) if (vals[i] > mx) mx = vals[i];
      const den = s.norm === 'absolute' ? Math.max(1, ks.length) * 0.15 : mx;
      paint(gr, n, (i) => { const q = Math.sqrt(vals[i] / den); return q < s.threshold ? null : q; }, s.ramp);
      gr.mesh.material.opacity = s.opacity;
      return `${s.who === 'all' ? 'combined free survivors' : 'S' + s.who} · states ${b.state.join('/')}`;
    },
    'h-goal'(g, s) {
      const H = match.hunter, A = H.lastAction || {}, d = hunterDbg(), c = col(s, '#ff5050');
      if (A.moveTo) { segs(g, [[H.x, H.z, A.moveTo.x, A.moveTo.z]], c, s.opacity); ring(g, A.moveTo.x, A.moveTo.z, 0.6, c, s.opacity); }
      if (A.face && !A.moveTo) segs(g, [[H.x, H.z, A.face.x, A.face.z]], c, s.opacity * 0.6);
      const tgt = match.chaseTgt >= 0 ? match.chaseTgt : d?.target;
      if (tgt != null && tgt >= 0 && match.survivors[tgt]) { const t = match.survivors[tgt]; ring(g, t.x, t.z, 1.1, c, s.opacity); ring(g, t.x, t.z, 1.4, c, s.opacity * 0.6); }
      if (d?.camp) { ring(g, d.camp.x, d.camp.z, 2.5, '#ffaa33', s.opacity); }
      if (d?.goto) ring(g, d.goto.x, d.goto.z, 1.2, '#ffaa33', s.opacity);
      if (d?.patrolGen >= 0 && map.generators) { const gn = (match.hunter.ctx?.map?.generators || [])[d.patrolGen]; if (gn) ring(g, gn.x, gn.z, 1.8, '#ffd24a', s.opacity); }
      const mode = hunterModeText(d);
      if (s.label) label(g, mode, H.x, H.z - 1.2, { y: 3.4, color: '#ffd0d0' });
      return `mode ${mode}${A.assisted ? ' (harness override)' : ''}${d?.mind ? ` · mind ${d.mind.kind}` : ''}`;
    },
    'h-path'(g, s) {
      const H = match.hunter, r = navRoute(H), A = H.lastAction || {};
      if (r) { poly(g, [[H.x, H.z], ...r], col(s, '#ff8a5c'), s.opacity, 0.18); return `nav route ${r.length} cells`; }
      if (A.moveTo) { poly(g, [[H.x, H.z], [A.moveTo.x, A.moveTo.z]], col(s, '#ff8a5c'), s.opacity * 0.5, 0.18); return 'direct (field descent; no cached A* route)'; }
      return 'no movement goal';
    },
    'h-cone'(g, s) { const H = match.hunter, sc = match.cfg.sight; fan(g, H.x, H.z, H.face, ((sc.hunterFovDeg ?? 100) / 2) * Math.PI / 180, s.len === 'real' ? sc.range ?? 75 : 14, col(s, '#ff4040'), s.opacity); },
    'h-terror'(g, s) {
      const H = match.hunter, TR = match.cfg.senses.terrorRadius ?? 32, TL = match.cfg.senses.terrorLayers ?? 3;
      for (let k = TL; k >= 1; k--) { if (!s.layers && k !== TL) continue; ring(g, H.x, H.z, (TR * k) / TL, col(s, '#ff3030'), s.opacity * (k === TL ? 1 : 0.6), 0.05, 96); }
    },
    's-plan'(g, s) {
      const i = +s.agent, d = survDbg(i), me = match.survivors[i]; if (!d || !me) return 'no survivor brain';
      if (me.st >= 5) return 'out of the trial';
      const c = survCss[i], o = s.opacity;
      if (d.circ) {
        d.circ.pts.forEach(([P, Q], k) => {
          const cur = k === d.circ.i;
          segs(g, [[P.x, P.z, Q.x, Q.z]], cur ? '#ffffff' : c, o, 0.22);
          ring(g, P.x, P.z, cur ? 0.7 : 0.45, cur ? '#ffffff' : c, o, 0.22);
          const nx = d.circ.pts[(k + 1) % d.circ.pts.length][0]; if (k + 1 < d.circ.pts.length || d.circ.pts.length > 1) segs(g, [[Q.x, Q.z, nx.x, nx.z]], c, o * 0.45, 0.2);
        });
        const [P] = d.circ.pts[d.circ.i];
        segs(g, [[me.x, me.z, P.x, P.z]], '#ffffff', o * 0.7, 0.24);
        label(g, `next: ${d.circ.anchors[d.circ.i]} (${d.circ.phase}${d.circ.holdT > 0 ? ` hold ${d.circ.holdT.toFixed(1)}s` : ''})`, P.x, P.z, { y: 2.2, color: '#ffffff', size: 0.8 });
      }
      if (d.fleePoint) { segs(g, [[me.x, me.z, d.fleePoint.x, d.fleePoint.z]], '#7dff9a', o, 0.24); ring(g, d.fleePoint.x, d.fleePoint.z, 0.8, '#7dff9a', o, 0.24); }
      if (d.hide?.spot) ring(g, d.hide.spot.x, d.hide.spot.z, 0.9, '#b48cff', o, 0.24);
      if (d.exploreTo) ring(g, d.exploreTo.x, d.exploreTo.z, 0.8, '#9ab', o * 0.8);
      const A = me.lastAction || {};
      if (A.moveTo && !d.circ && !d.fleePoint) segs(g, [[me.x, me.z, A.moveTo.x, A.moveTo.z]], c, o * 0.7, 0.24);
      if (A.moveDir && (A.moveDir.x || A.moveDir.z)) { const l = Math.hypot(A.moveDir.x, A.moveDir.z); segs(g, [[me.x, me.z, me.x + (A.moveDir.x / l) * 3, me.z + (A.moveDir.z / l) * 3]], '#ffffff', o, 0.26); }
      const txt = `S${i} ${d.mode}${d.circ ? ' · loop' : d.fleePoint ? ' · flee' : d.hide ? ' · hide' : d.genTarget >= 0 ? ` · gen ${d.genTarget}` : d.genTarget === -2 ? ' · explore' : ''}${A.walk ? ' · walk' : ''}${A.act ? ' · ' + A.act : ''}`;
      if (s.label) label(g, txt, me.x, me.z + 1.2, { y: 2.9, color: c });
      return `${txt}${d.circ ? ` · circuit ${d.circ.anchors.join(' → ')} · crossing ${d.circ.i + 1}/${d.circ.seq.length} · crossed ${d.circ.crossed ?? 0} · lap ${fmt(d.circ.lap)}` : ''}${d.myVault ? ' · vaulting' : ''}`;
    },
    's-route'(g, s) {
      const i = +s.agent, d = survDbg(i), me = match.survivors[i]; if (!d || !me) return '';
      let out = '';
      if (d.route?.cells?.length) { const W = d.route.W; poly(g, d.route.cells.map((c) => [(c % W) + 0.5, Math.floor(c / W) + 0.5]), col(s, '#5be3ff'), s.opacity, 0.2); out = `planned (its route field) → goal, ${d.route.cells.length} m`; }
      else out = d.goal ? 'goal outside its last route field' : 'no flee goal';
      if (s.nav) { const r = navRoute(me); if (r) { poly(g, [[me.x, me.z], ...r], '#ffffff', s.opacity * 0.45, 0.19); out += ` · engine nav ${r.length} cells`; } }
      return out;
    },
    's-know'(g, s) {
      const i = +s.agent, d = survDbg(i), me = match.survivors[i]; if (!d) return '';
      const k = d.know, gr = gridOf('s-know', k.W, k.H, k.cs), n = k.W * k.H;
      paint(gr, n, (c) => (!k.open[c] ? null : k.seen[c] ? 1 : s.unseen ? 0 : null), s.ramp, false, (q) => (q > 0.5 ? 0.55 : 0.85));
      if (s.unseen) for (let c = 0; c < n; c++) if (k.open[c] && !k.seen[c]) { gr.data[c * 4] = 20; gr.data[c * 4 + 1] = 20; gr.data[c * 4 + 2] = 30; }
      gr.tex.needsUpdate = true; gr.mesh.material.opacity = s.opacity;
      for (const a of k.anchors) { const cc = a.kind === 'w' ? '#6fc8e8' : '#f2d24b'; if (a.known) disc(g, a.x, a.z, 0.45, cc, Math.min(1, s.opacity + 0.4), 0.2); else ring(g, a.x, a.z, 0.45, cc, s.opacity, 0.2, 12); }
      let kg = 0;
      me?.mem?.gens?.forEach((m, gi) => { const gn = match.gens[gi]; if (!gn) return; if (m.known) { kg++; ring(g, gn.x, gn.z, 1.3, '#fab219', Math.min(1, s.opacity + 0.4), 0.21, 24); } });
      return `S${i} explored ${Math.round(100 * k.fraction)}% · anchors known ${k.anchors.filter((a) => a.known).length}/${k.anchors.length} · gens known ${kg}/${match.gens.length}`;
    },
    's-hbelief'(g, s) {
      const i = +s.agent, d = survDbg(i); if (!d) return '';
      const b = d.hb, gr = gridOf('s-hbelief', b.W, b.H, b.cs), n = b.W * b.H;
      let mx = 1e-9; for (let c = 0; c < n; c++) if (b.heat[c] > mx) mx = b.heat[c];
      const den = s.norm === 'absolute' ? 0.15 : mx;
      paint(gr, n, (c) => { const q = Math.sqrt(b.heat[c] / den); return q < s.threshold ? null : q; }, s.ramp);
      gr.mesh.material.opacity = s.opacity;
      if (b.lastSeen) ring(g, b.lastSeen.x, b.lastSeen.z, 1, '#9cf', 1, 0.25);
      return `S${i} ${b.seenNow ? 'sees the hunter' : b.lastSeen ? `last saw it ${fmt(match.t - b.lastSeen.t)} s ago` : 'never saw it'}`;
    },
    's-fields'(g, s) {
      const i = +s.agent, d = survDbg(i); if (!d?.fields) return 'no route field yet (computed when it plans a chase route)';
      const f = d.fields, gr = gridOf('s-fields', f.W, f.H, 1), n = f.W * f.H;
      paint(gr, n, (c) => {
        const a = f.fS[c], b = f.fH[c];
        if (s.which === 'gap') { if (a < 0 || b < 0) return null; return 0.5 + (b - a) / 10 / (2 * s.maxM); }
        const v = s.which === 'fS' ? a : b; return v < 0 ? null : 1 - Math.min(1, v / 10 / s.maxM);
      }, s.ramp, false, () => 1);
      gr.mesh.material.opacity = s.opacity;
      return s.which === 'gap' ? 'bright = the hunter is farther than me (safe), dark = it gets there first' : 'bright = near';
    },
    's-cover'(g, s) {
      const i = +s.agent, d = survDbg(i); if (!d?.cover) return 'computing…';
      const cv = d.cover, gr = gridOf('s-cover', cv.W, cv.H, cv.cs), n = cv.W * cv.H;
      let mx = 1e-9; for (let c = 0; c < n; c++) if (cv.v[c] > mx) mx = cv.v[c];
      paint(gr, n, (c) => (cv.v[c] < 0 ? null : cv.v[c] / mx < s.threshold ? null : cv.v[c] / mx), s.ramp, true, () => 0.9);
      gr.mesh.material.opacity = s.opacity;
      return 'bright = more cover (from its hunter-belief model)';
    },
    's-cam'(g, s) {
      const cam = match.cfg.survivor.camera || {}, half = ((cam.fovDeg ?? 100) / 2) * Math.PI / 180;
      for (let i = 0; i < 4; i++) { if (!s.all && i !== +s.agent) continue; const v = match.survivors[i]; if (v.st >= 5) continue; fan(g, v.camX ?? v.x, v.camZ ?? v.z, v.camYaw ?? v.face, half, 18, survCss[i], s.opacity, 0.07 + i * 0.002); }
    },
    's-mates'(g, s) {
      const i = +s.agent, d = survDbg(i); if (!d) return '';
      const parts = [];
      d.mates.forEach((e, j) => {
        if (!e) return;
        const real = match.survivors[j];
        ring(g, e.x, e.z, Math.max(0.6, Math.min(40, e.r)), survCss[j], s.opacity, 0.2);
        disc(g, e.x, e.z, 0.35, survCss[j], s.opacity, 0.21);
        if (real && real.st < 5) segs(g, [[e.x, e.z, real.x, real.z]], survCss[j], s.opacity * 0.3, 0.19);
        const it = e.intent && match.t - e.intent.t < 20 ? ` "${e.intent.intent}"` : '';
        if (it) label(g, `heard${it}`, e.x, e.z, { y: 2.2, color: survCss[j], size: 0.7 });
        parts.push(`S${j}: ${e.state}, ±${fmt(e.r)} m${it}`);
      });
      return `S${i} thinks: ` + parts.join(' · ') + ' (faint line → true position)';
    },
    's-scratch'(g, s) {
      const marks = match.marks || [];
      for (const mk of marks) {
        const age = match.t - mk.t; if (age > s.age || age < 0) continue;
        if (mk._o === undefined) { let best = -1, bd = 1e9; match.survivors.forEach((v, j) => { const dd = Math.hypot(v.x - mk.x, v.z - mk.z); if (dd < bd) { bd = dd; best = j; } }); mk._vo = best; mk._o = true; }
        if (!s.all && mk._vo !== +s.agent) continue;
        const l = Math.hypot(mk.dx || 0, mk.dz || 0) || 1, ux = (mk.dx || 1) / l, uz = (mk.dz || 0) / l, a = 0.5;
        segs(g, [[mk.x - ux * a - uz * 0.3, mk.z - uz * a + ux * 0.3, mk.x + ux * a + uz * 0.3, mk.z + uz * a - ux * 0.3], [mk.x - ux * a + uz * 0.3, mk.z - uz * a - ux * 0.3, mk.x + ux * a - uz * 0.3, mk.z + uz * a + ux * 0.3]], survCss[mk._vo] || '#c33', s.opacity * (1 - age / s.age), 0.12);
      }
      return 'owner = survivor standing on the mark when it appeared (the engine does not tag marks)';
    },
    's-intents'(g, s) {
      const ev = match.events; let shown = 0;
      for (let k = ev.length - 1; k >= 0; k--) { const e = ev[k]; if (match.t - e.t > s.hold) break; if (e.type !== 'intent') continue; const v = match.survivors[e.from]; if (!v) continue; label(g, `💬 ${e.intent}`, v.x, v.z, { y: 3.6, color: survCss[e.from], size: 0.8 }); shown++; }
      return `${shown} recent`;
    },
    'w-los'(g, s) {
      const a = agentPos(s.agent); if (!a || (s.agent !== 'h' && a.st >= 5)) return '';
      const isH = s.agent === 'h', sc = match.cfg.sight, cam = match.cfg.survivor.camera || {};
      const face = isH ? a.face : a.camYaw ?? a.face, half = s.cone ? ((isH ? sc.hunterFovDeg : cam.fovDeg ?? 100) / 2) * Math.PI / 180 : Math.PI;
      const ox = isH ? a.x : a.camX ?? a.x, oz = isH ? a.z : a.camZ ?? a.z;
      const pts = visPoly(ox, oz, face, half, sc.range ?? 75);
      const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), fillMat(col(s, '#fff3a0'), s.opacity)); m.rotation.x = Math.PI / 2; m.position.y = 0.075; g.add(m);
      return `from ${isH ? 'hunter' : 'S' + s.agent}${!isH ? ' camera' : ''} · tall walls block, 2+ low obstacles block (0.6 each, threshold 0.5)`;
    },
    'w-nav'(g, s) {
      const md = match.md, W = match.W, H = Math.round(md.kind.length / W), gr = gridOf('w-nav', W, H, 1);
      const colr = { 1: [90, 90, 100], 2: [111, 200, 232], 3: [111, 200, 232], 4: [242, 210, 75], 5: [242, 210, 75] };
      const d = gr.data;
      for (let c = 0; c < W * H; c++) { const k = md.kind[c], cc = colr[k]; if (!cc) { d[c * 4 + 3] = ((c % W) + Math.floor(c / W)) % 2 ? 0 : 28; d[c * 4] = d[c * 4 + 1] = d[c * 4 + 2] = 255; continue; } d[c * 4] = cc[0]; d[c * 4 + 1] = cc[1]; d[c * 4 + 2] = cc[2]; d[c * 4 + 3] = 200; }
      gr.tex.magFilter = THREE.NearestFilter; gr.tex.needsUpdate = true; gr.mesh.material.opacity = s.opacity;
      return 'grey = solid · blue = window · yellow = pallet · checker = walkable 1 m cells';
    },
    'w-tiles'(g, s) {
      const tiles = map.mapgen?.tiles || [];
      if (!tiles.length) return 'this map has no tile metadata (map.mapgen.tiles)';
      let dead = 0;
      for (const t of tiles) {
        const isDead = t.category === 'dead', inf = t.tile === 'infinite-loop';
        const c = inf ? '#ff2bd6' : t.rating === 'strong' ? '#5be37a' : t.rating === 'weak' ? '#f5d142' : '#8a8f99';
        poly(g, [[t.x + 0.2, t.z + 0.2], [t.x + t.size - 0.2, t.z + 0.2], [t.x + t.size - 0.2, t.z + t.size - 0.2], [t.x + 0.2, t.z + t.size - 0.2]], c, s.opacity, 0.13, true);
        if (inf) quad(g, t.x, t.z, t.x + t.size, t.z + t.size, '#ff2bd6', 0.18 * s.opacity, 0.085);
        if (s.dead && isDead) { quad(g, t.x, t.z, t.x + t.size, t.z + t.size, '#000000', 0.35 * s.opacity, 0.085); dead++; }
        if (s.names && (t.size >= 16 || t.category === 'gate' || inf)) label(g, `${t.tile}${t.rating ? ' · ' + t.rating : ''}${t.palletSafety ? ' · ' + t.palletSafety : ''}`, t.x + t.size / 2, t.z + t.size / 2, { y: 1.5, color: c, size: 0.85 });
      }
      return `${tiles.length} tiles · green strong / yellow weak / grey none · magenta = infinite-loop probe · dark = dead tiles (${dead}) · names on 16 m tiles`;
    },
    'w-loops'(g, s) {
      if (!loopsCache) { const d = match.survivors[0]?.brain?.debug?.(match.t, { loops: true }); loopsCache = d?.loops ?? []; }
      for (const a of loopsCache) {
        if (!(a.held >= s.min)) continue;
        const v = Math.min(1, a.held / 40), [r, gg, b] = rampColor('viridis', v);
        label(g, `${a.kind === 'w' ? 'W' : 'P'} ${isFinite(a.held) ? a.held.toFixed(0) : '∞'} m`, a.x, a.z + 1.6, { y: 1.6, color: `rgb(${r},${gg},${b})`, size: 0.7 });
      }
      return 'detour distance the loop around each window / pallet holds (LoopModel; ∞ = sealed)';
    },
    'w-gens'(g, s) {
      for (const gn of match.gens) {
        const p = gn.done ? 1 : gn.p / match.need, c = gn.done ? '#fab219' : gn.regress ? '#e66767' : '#c98500';
        ring(g, gn.x, gn.z, 1.6, '#444', s.opacity, 0.11, 32);
        if (p > 0) { const pts = []; const n = Math.max(2, Math.round(32 * p)); for (let k = 0; k <= n; k++) { const a = -Math.PI / 2 + (k / n) * p * Math.PI * 2; pts.push([gn.x + 1.6 * Math.cos(a), gn.z + 1.6 * Math.sin(a)]); } poly(g, pts, c, s.opacity, 0.12); }
        label(g, gn.done ? 'done' : `${Math.round(p * 100)}%${gn.regress ? ' ↓' : ''}${gn.nWork ? ` ·${gn.nWork}` : ''}${gn.kicks ? ` k${gn.kicks}` : ''}`, gn.x, gn.z, { y: 2.2, color: c, size: 0.7 });
      }
      return '↓ = regressing · ·n = survivors repairing · k = kicks';
    },
    'w-hooks'(g, s) { for (const hk of match.hooks) { const occ = hk.occ >= 0; disc(g, hk.x, hk.z, s.r, occ ? '#ff3344' : '#99232f', s.opacity * 0.35, 0.065); ring(g, hk.x, hk.z, s.r, occ ? '#ff3344' : '#99232f', s.opacity, 0.07, 40); } },
    'w-pallets'(g, s) {
      match.md.pallets.forEach((p, k) => { const st = match.ps[k]; label(g, ['up', 'dropped', 'broken'][st], p.cx, p.cz - 1.4, { y: 2.4, color: ['#f2d24b', '#ff7a40', '#b08d6a'][st], size: 0.65 }); });
      const wb = match.winBlockT, nW = match.md.windows.length;
      if (wb) for (let w = 0; w < nW; w++) { const b = [0, 1, 2, 3].filter((j) => wb[w * 4 + j] > match.t); if (b.length) { const wd = match.md.windows[w]; label(g, `blocked ${b.map((j) => 'S' + j).join(',')}`, wd.x + 0.5, wd.z + 0.5, { y: 2, color: '#6fc8e8', size: 0.65 }); } }
    },
  };
  const fmt = (v) => (v == null || !isFinite(v) ? '–' : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
  function hunterModeText(d) {
    const H = match.hunter;
    if (H.stunT > 0) return 'stunned'; if (H.vault) return 'vaulting'; if (H.windT > 0) return 'lunging';
    if (H.carrying >= 0) return `carrying S${H.carrying}`; if (H.curAct) return H.curAct;
    if (H.cdT > 0) return 'cooldown';
    if (match.chaseTgt >= 0) return `chasing S${match.chaseTgt}`;
    if (d?.camp && match.t < d.camp.until) return `camp (${d.camp.mode ?? 'proxy'})`;
    if (d?.mind) return `mind game: ${d.mind.kind}`;
    return (H.lastAction || {}).moveTo ? 'patrol / search' : 'idle';
  }

  let staticDirty = true;
  function update(force = false) {
    if (!match) return;
    const now = performance.now();
    if (!force && now - lastUp < 200) return;
    lastUp = now;
    snap = { h: undefined, s: {} };
    for (const L of LAYERS) {
      const s = S[L.id], g = groups.get(L.id);
      g.visible = !!s.on;
      if (!s.on) { if (L.kind === 'vec') disposeGroup(g); info.set(L.id, ''); continue; }
      if (L.static && !staticDirty && built.has(L.id)) continue;
      if (L.kind === 'vec') disposeGroup(g);
      if (L.static) built.add(L.id);
      let txt = '';
      const t0 = performance.now();
      try { txt = R[L.id](g, s) || ''; } catch (e) { txt = 'error: ' + e.message; }
      const ms = performance.now() - t0; cost.set(L.id, 0.7 * (cost.get(L.id) ?? ms) + 0.3 * ms);
      info.set(L.id, txt + (cost.get(L.id) > 4 ? ` · ${cost.get(L.id).toFixed(0)} ms/update` : ''));
    }
    snap = null; staticDirty = false;
    renderInfo();
  }

  // ---- panel UI
  function controlFor(L, o) {
    const s = S[L.id], v = s[o.k], lab = o.label ?? o.k;
    if (o.type === 'select') return `<label class="lyr-opt">${esc(lab)} <select data-k="${o.k}">${o.choices.map((c) => { const [val, txt] = Array.isArray(c) ? c : [c, c]; return `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(txt)}</option>`; }).join('')}</select></label>`;
    if (o.type === 'range') return `<label class="lyr-opt">${esc(lab)} <input type="range" data-k="${o.k}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}"><span class="lyr-v">${v}</span></label>`;
    if (o.type === 'check') return `<label class="lyr-opt"><input type="checkbox" data-k="${o.k}"${v ? ' checked' : ''}> ${esc(lab)}</label>`;
    if (o.type === 'color') return `<label class="lyr-opt">colour <input type="color" data-k="${o.k}" value="${esc(v)}"></label>`;
    return '';
  }
  function renderPanel() {
    if (!panel) return;
    const groupsHtml = ['Hunter', 'Survivor', 'World'].map((gname) => {
      const ls = LAYERS.filter((l) => l.group === gname);
      return `<div class="lyr-group"><div class="lyr-gh"><span>${gname}</span><button data-all="${gname}" data-v="1">all on</button><button data-all="${gname}" data-v="0">all off</button></div>` + ls.map((L) => {
        const s = S[L.id];
        const agentSel = L.agent ? `<select data-k="agent" title="whose view">${(L.agent === 'any' ? AGENTS_ANY : AGENTS_S).map(([v, t]) => `<option value="${v}"${String(s.agent) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>` : '';
        return `<div class="lyr${s.on ? ' on' : ''}" data-id="${L.id}">
          <div class="lyr-row"><label class="lyr-name"><input type="checkbox" data-k="on"${s.on ? ' checked' : ''}> ${esc(L.name)}</label>${agentSel}
            <input type="range" data-k="opacity" min="0" max="1" step="0.05" value="${s.opacity}" title="opacity" class="lyr-op">
            ${L.opts?.length ? `<button class="lyr-more" title="options">⚙</button>` : ''}</div>
          ${L.opts?.length ? `<div class="lyr-opts" hidden>${L.opts.map((o) => controlFor(L, o)).join('')}</div>` : ''}
          <div class="lyr-info"></div></div>`;
      }).join('') + '</div>';
    }).join('');
    panel.innerHTML = `<div class="lyr-top"><button data-reset>reset all layers</button><span class="muted">opacity slider on each row · ⚙ = options · settings are remembered</span></div>` + groupsHtml;
  }
  function renderInfo() {
    if (!panel) return;
    for (const el of panel.querySelectorAll('.lyr')) { const t = info.get(el.dataset.id) || ''; const ie = el.querySelector('.lyr-info'); if (ie.textContent !== t) ie.textContent = t; }
  }
  if (panel) {
    renderPanel();
    panel.addEventListener('input', (ev) => {
      const el = ev.target, row = el.closest('.lyr'); if (!row || !el.dataset.k) return;
      const s = S[row.dataset.id], k = el.dataset.k;
      s[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
      if (k === 'on') row.classList.toggle('on', el.checked);
      const vv = el.parentElement.querySelector('.lyr-v'); if (vv) vv.textContent = el.value;
      save(); staticDirty = true; update(true); onChange?.();
    });
    panel.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.classList.contains('lyr-more')) { const o = b.closest('.lyr').querySelector('.lyr-opts'); o.hidden = !o.hidden; }
      else if (b.dataset.all) { for (const L of LAYERS) if (L.group === b.dataset.all) S[L.id].on = b.dataset.v === '1'; save(); renderPanel(); staticDirty = true; update(true); onChange?.(); }
      else if ('reset' in b.dataset) { for (const L of LAYERS) S[L.id] = { ...L.d, ...(defaults[L.id] || {}) }; save(); renderPanel(); staticDirty = true; update(true); onChange?.(); }
    });
  }
  let onChange = null;

  return {
    rebuild(m, mp) { match = m; if (mp !== map) loopsCache = null; map = mp; staticDirty = true; for (const L of LAYERS) if (L.kind === 'vec') disposeGroup(groups.get(L.id)); update(true); },
    update,
    isOn: (id) => !!S[id]?.on,
    set(id, patch) { Object.assign(S[id], patch); save(); renderPanel(); staticDirty = true; update(true); },
    toggle(id) { S[id].on = !S[id].on; save(); renderPanel(); staticDirty = true; update(true); return S[id].on; },
    onChange(fn) { onChange = fn; },
    list: LAYERS,
    costs: () => Object.fromEntries([...cost].map(([k, v]) => [k, +v.toFixed(1)])),
  };
}
