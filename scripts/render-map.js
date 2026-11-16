#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeMap } from './validate-map.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const TILE_TINT = { landmark: '#f4e3c8', maze: '#e7dcf5', carpile: '#f7d9d3', loop: '#d9ecf8', filler: '#e3f2dc', dead: null, gate: '#ece4f7' };

// Returns the SVG text. Maps produced by src/mapgen carry `mapgen.tiles`; those get a tinted tile overlay.
export function renderSvg(map, result = analyzeMap(map)) {
  if (result.errors.length) throw new Error(`Map is invalid:\n${result.errors.join('\n')}`);
  const { w, h } = map.size;
  const polygon = map.outline.map(p => p.join(',')).join(' ');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(w + 12) * 10}" height="${(h + 24) * 10}" viewBox="-6 -9 ${w + 12} ${h + 24}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(map.name)} — collision layout</title>`,
    '<desc id="desc">North is up. Coordinates in meters. Dark shapes block sight and movement; gray shapes block movement only. Windows and pallets occupy gaps. Grid spacing is eight meters.</desc>',
    '<style>text{font-family:Arial,sans-serif}.label{font-size:3px;font-weight:bold;fill:#354253;paint-order:stroke;stroke:#fff;stroke-width:.65;stroke-linejoin:round}.feature{font-size:1.45px;font-weight:bold;paint-order:stroke;stroke:#fff;stroke-width:.45;fill:#111}.tick{font-size:1.8px;fill:#526170}</style>',
    `<rect x="-6" y="-9" width="${w + 12}" height="${h + 24}" fill="#e9edf1"/>`,
    `<text x="0" y="-4" font-size="3.2" font-weight="bold">${esc(map.name)} · ${w} × ${h} m · 1 tile = 8 m</text>`,
    `<defs><clipPath id="boundary"><polygon points="${polygon}"/></clipPath></defs>`,
    `<polygon points="${polygon}" fill="#fff"/>`,
  ];
  const tiles = map.mapgen?.tiles ?? [];
  for (const t of tiles) {
    const tint = TILE_TINT[t.category];
    if (tint) svg.push(`<rect x="${t.x}" y="${t.z}" width="${t.size}" height="${t.size}" fill="${tint}" opacity=".7"><title>${esc(t.id)} ${esc(t.tile)} rot${t.rot}${t.mirror ? ' mirrored' : ''} · ${t.rating}</title></rect>`);
  }
  svg.push('<g clip-path="url(#boundary)" stroke="#dbe1e7" stroke-width=".16">');
  for (let x = 0; x <= w; x += 8) svg.push(`<path d="M${x} 0V${h}"/>`);
  for (let z = 0; z <= h; z += 8) svg.push(`<path d="M0 ${z}H${w}"/>`);
  svg.push('</g>');
  for (const t of tiles) if (t.category !== 'dead') {
    svg.push(`<rect x="${t.x + .15}" y="${t.z + .15}" width="${t.size - .3}" height="${t.size - .3}" fill="none" stroke="#8a97a6" stroke-width=".15" stroke-dasharray=".8 .5"/>`);
    svg.push(`<text x="${t.x + .5}" y="${t.z + 1.5}" font-size="1.25" fill="#5b6877">${esc(t.tile)}${t.rating !== 'none' ? ` · ${t.rating}` : ''}</text>`);
  }
  for (let x = 0; x <= w; x += 16) svg.push(`<text class="tick" x="${x}" y="-1.5" text-anchor="middle">${x}</text>`);
  for (let z = 0; z <= h; z += 16) svg.push(`<text class="tick" x="-1.2" y="${z + .6}" text-anchor="end">${z}</text>`);
  const rect = (o, fill, stroke = '#26323f') => `<rect x="${o.x}" y="${o.z}" width="${o.w}" height="${o.d}" fill="${fill}" stroke="${stroke}" stroke-width=".12"><title>${esc(o.id)}${o.height ? ` · ${o.height} m high` : ''}</title></rect>`;
  for (const o of map.obstacles) svg.push(rect(o, o.height >= map.eyeHeight ? '#303b49' : '#adb7c2'));
  for (const v of map.windows) {
    svg.push(rect({ ...v, w: 1, d: 1 }, '#4ac5e8', '#007d9e'));
    svg.push(`<path d="${v.axis === 'x' ? `M${v.x - .3} ${v.z + .5}h1.6` : `M${v.x + .5} ${v.z - .3}v1.6`}" stroke="#00708b" stroke-width=".15"/>`);
    svg.push(`<text class="feature" x="${v.x + 1.2}" y="${v.z - .25}">${esc(v.id)}</text>`);
  }
  for (const p of map.pallets) {
    const rw = p.axis === 'z' ? p.length : 1, rd = p.axis === 'x' ? p.length : 1;
    svg.push(rect({ ...p, w: rw, d: rd }, '#efad4c', '#9b6000'));
    svg.push(`<text class="feature" x="${p.x + rw + .25}" y="${p.z + rd + .8}">${esc(p.id)}</text>`);
  }
  for (const g of map.generators) {
    svg.push(rect({ ...g, x: Math.floor(g.x), z: Math.floor(g.z), w: 1, d: 1 }, '#6ebc78', '#236c35'));
    svg.push(`<text class="feature" x="${g.x + 1}" y="${g.z + .6}">${esc(g.id)}</text>`);
  }
  for (const hook of map.hooks) {
    svg.push(`<g transform="translate(${hook.x} ${hook.z})"><title>${esc(hook.id)}</title><circle r=".95" fill="#fff" stroke="#ac3354" stroke-width=".2"/><path d="M-.3 -.6V.3q0 .6 .6 .3" fill="none" stroke="#ac3354" stroke-width=".25"/></g>`);
    svg.push(`<text class="feature" x="${hook.x + 1.15}" y="${hook.z + .55}">${esc(hook.id)}</text>`);
  }
  for (const gate of map.exitGates) {
    const { lever: l, exit: e } = gate;
    svg.push(`<path d="M${l.x} ${l.z}L${e.x} ${e.z}" stroke="#8062b4" stroke-width=".3" stroke-dasharray=".5 .4"/>`);
    svg.push(`<rect x="${l.x - .55}" y="${l.z - .55}" width="1.1" height="1.1" fill="#8062b4"><title>${esc(gate.id)} lever</title></rect>`);
    svg.push(`<circle cx="${e.x}" cy="${e.z}" r="1" fill="#8062b4"><title>${esc(gate.id)} exit</title></circle>`);
    svg.push(`<text class="feature" x="${e.x + 1.5}" y="${e.z + 1.5}">${esc(gate.id)}</text>`);
  }
  for (const [team, points] of Object.entries(map.spawns)) for (const [i, p] of points.entries()) {
    svg.push(`<circle cx="${p.x}" cy="${p.z}" r=".85" fill="${team === 'hunter' ? '#df3d37' : '#377ace'}" stroke="#fff" stroke-width=".15"><title>${esc(team)} spawn ${i + 1}</title></circle>`);
  }
  for (const label of map.labels) svg.push(`<text class="label" x="${label.x}" y="${label.z}" text-anchor="middle">${esc(label.text)}</text>`);
  svg.push(`<polygon points="${polygon}" fill="none" stroke="#172533" stroke-width=".45"/>`);
  const legend = [['#303b49', 'Tall / blocks sight'], ['#adb7c2', 'Low / see over'], ['#4ac5e8', 'Window'], ['#efad4c', 'Pallet'], ['#6ebc78', 'Generator'], ['#ac3354', 'Hook'], ['#8062b4', 'Gate'], ['#df3d37', 'Hunter'], ['#377ace', 'Survivor']];
  legend.forEach(([color, name], i) => {
    const x = (i % 5) * 23, y = h + 5 + Math.floor(i / 5) * 4;
    svg.push(`<rect x="${x}" y="${y - 1.3}" width="1.5" height="1.5" fill="${color}"/><text x="${x + 2.2}" y="${y}" font-size="1.8">${name}</text>`);
  });
  svg.push(`<text x="0" y="${h + 13}" font-size="1.7">${result.playableCells} m² · ${map.pallets.length} pallets · ${map.windows.length} windows · ${map.generators.length} generator candidates · ${map.hooks.length} hooks · max hook walk ${result.maxHookDistance} m</text>`, '</svg>');
  return svg.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || process.argv.length > 4) {
    console.error('Usage: node scripts/render-map.js <map.json> [out.svg]');
    process.exitCode = 1;
  } else try {
    const map = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    const out = output ?? path.join('docs', 'maps', `${map.id}.svg`);
    const svg = renderSvg(map);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, svg);
    console.log(`Rendered ${out}`);
  } catch (error) { console.error(`Cannot render map: ${error.message}`); process.exitCode = 1; }
}
