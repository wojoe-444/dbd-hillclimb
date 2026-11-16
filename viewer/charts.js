// Tiny canvas chart helpers for the viewer (no deps). Every chart sizes itself to its canvas's CSS box at
// devicePixelRatio, draws one y-scale only (small multiples instead of dual axes), and supports a hover
// crosshair + tooltip and click-to-pick via attachHover().

export const INK = { primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19' };
// categorical slots (dark-surface steps), assigned in fixed order
export const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

/** Prepare a canvas for drawing in CSS pixels; returns { g, W, H } or null if it is not laid out. */
export function prep(c) {
  const r = c.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  const dpr = devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, W: r.width, H: r.height };
}

const fmtNum = (v) => (v == null || Number.isNaN(v) ? '–' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
export { fmtNum };

/**
 * Line chart over an index axis (generations or time samples).
 * opts: { series: [{ name, color, values: number[] }], yMin=0, yMax, xLabel(i) -> string, sel: index|null,
 *         markers: [{ i, color }], hover: index|null, yTicks: number }
 * Returns layout info used by attachHover.
 */
export function lineChart(c, opts) {
  const p = prep(c); if (!p) return null;
  const { g, W, H } = p;
  const { series, yMin = 0, xLabel = (i) => String(i + 1), sel = null, markers = [], hover = null } = opts;
  const n = Math.max(0, ...series.map((s) => s.values.length));
  let yMax = opts.yMax;
  if (yMax == null) { yMax = yMin; for (const s of series) for (const v of s.values) if (v > yMax) yMax = v; yMax = niceCeil(yMax || 1); }
  const L = 36, R = 8, T = 8, B = 18;
  const X = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const Y = (v) => H - B - ((v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
  const ticks = opts.yTicks ?? 4;
  for (let k = 0; k <= ticks; k++) {
    const v = yMin + ((yMax - yMin) * k) / ticks, y = Math.round(Y(v)) + 0.5;
    g.strokeStyle = k === 0 ? INK.axis : INK.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    g.fillStyle = INK.muted; g.textAlign = 'right'; g.fillText(fmtNum(v), L - 5, y);
  }
  if (n) {
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = INK.muted;
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 48))));
    for (let i = 0; i < n; i += step) g.fillText(xLabel(i), X(i), H - 4);
  }
  if (sel != null && sel >= 0 && sel < n) {
    g.strokeStyle = '#ffffff55'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(sel), T); g.lineTo(X(sel), H - B); g.stroke(); g.setLineDash([]);
  }
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    let started = false;
    s.values.forEach((v, i) => { if (v == null || Number.isNaN(v)) { started = false; return; } started ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); started = true; });
    g.stroke();
    if (n === 1 && s.values[0] != null) { g.fillStyle = s.color; g.beginPath(); g.arc(X(0), Y(s.values[0]), 4, 0, 7); g.fill(); }
  }
  for (const m of markers) {
    g.fillStyle = m.color; const x = X(m.i);
    g.beginPath(); g.moveTo(x, H - B - 1); g.lineTo(x - 4, H - B - 8); g.lineTo(x + 4, H - B - 8); g.fill();
  }
  if (hover != null && hover >= 0 && hover < n) {
    g.strokeStyle = '#ffffff99'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(hover) + 0.5, T); g.lineTo(X(hover) + 0.5, H - B); g.stroke();
    for (const s of series) { const v = s.values[hover]; if (v == null) continue; g.fillStyle = s.color; g.strokeStyle = INK.surface; g.lineWidth = 2; g.beginPath(); g.arc(X(hover), Y(v), 4, 0, 7); g.fill(); g.stroke(); }
  }
  return { n, X, L, R, W };
}

export function niceCeil(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/**
 * Wire hover + click on a canvas whose draw(hoverIndex) returns lineChart's layout.
 * tip(i) -> html for the tooltip; onPick(i) on click / drag.
 */
export function attachHover(c, draw, tip, onPick) {
  const tt = tooltipEl();
  let layout = null, dragging = false;
  const idxAt = (ev) => {
    if (!layout || !layout.n) return -1;
    const r = c.getBoundingClientRect(), x = ev.clientX - r.left;
    const f = (x - layout.L) / (layout.W - layout.L - layout.R);
    return Math.max(0, Math.min(layout.n - 1, Math.round(f * (layout.n - 1))));
  };
  c.addEventListener('pointermove', (ev) => {
    layout = draw(null) || layout;
    const i = idxAt(ev); if (i < 0) return;
    layout = draw(i) || layout;
    tt.innerHTML = tip(i); tt.style.display = 'block';
    const r = tt.getBoundingClientRect();
    tt.style.left = Math.min(innerWidth - r.width - 6, ev.clientX + 14) + 'px';
    tt.style.top = Math.max(4, Math.min(innerHeight - r.height - 6, ev.clientY - r.height - 10)) + 'px';
    if (dragging && onPick) onPick(i, false);
  });
  c.addEventListener('pointerleave', () => { tt.style.display = 'none'; draw(null); });
  if (onPick) {
    c.style.cursor = 'pointer';
    c.addEventListener('pointerdown', (ev) => { layout = draw(null) || layout; dragging = true; c.setPointerCapture(ev.pointerId); const i = idxAt(ev); if (i >= 0) onPick(i, false); });
    c.addEventListener('pointerup', (ev) => { if (!dragging) return; dragging = false; const i = idxAt(ev); if (i >= 0) onPick(i, true); });
  }
  return () => { layout = draw(null); };
}

let _tt;
export function tooltipEl() {
  if (!_tt) { _tt = document.createElement('div'); _tt.className = 'tooltip'; document.body.appendChild(_tt); }
  return _tt;
}

/** Simple histogram of values within [lo, hi]; marks the best value. */
export function histogram(c, values, lo, hi, best, color = CAT[0]) {
  const p = prep(c); if (!p) return;
  const { g, W, H } = p;
  const L = 8, R = 8, T = 8, B = 18, bins = 16;
  const cnt = new Array(bins).fill(0);
  for (const v of values) cnt[Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * bins)))]++;
  const max = Math.max(1, ...cnt), bw = (W - L - R) / bins;
  g.fillStyle = color;
  cnt.forEach((k, i) => { if (!k) return; const h = (k / max) * (H - T - B); roundTop(g, L + i * bw + 1, H - B - h, bw - 2, h, 3); });
  g.strokeStyle = INK.axis; g.beginPath(); g.moveTo(L, H - B + 0.5); g.lineTo(W - R, H - B + 0.5); g.stroke();
  g.font = '11px system-ui'; g.fillStyle = INK.muted; g.textBaseline = 'alphabetic';
  g.textAlign = 'left'; g.fillText(fmtNum(lo), L, H - 4); g.textAlign = 'right'; g.fillText(fmtNum(hi), W - R, H - 4);
  if (best != null) {
    const x = L + ((best - lo) / (hi - lo || 1)) * (W - L - R);
    g.strokeStyle = '#ffd24a'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke();
  }
}

function roundTop(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h); g.closePath(); g.fill();
}

/** Tiny inline sparkline (no axes). */
export function sparkline(c, values, color = CAT[0], lo = null, hi = null) {
  const p = prep(c); if (!p || !values.length) return;
  const { g, W, H } = p;
  const mn = lo ?? Math.min(...values), mx = hi ?? Math.max(...values);
  const X = (i) => 1 + (values.length <= 1 ? 0 : (i / (values.length - 1)) * (W - 2));
  const Y = (v) => H - 2 - ((v - mn) / (mx - mn || 1)) * (H - 4);
  g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
  values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.stroke();
}
