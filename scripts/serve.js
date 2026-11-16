// Zero-dependency static server for the viewer: node scripts/serve.js [port]
// Serves the repo root (viewer/, src/, maps/, runs/) and a JSON index of runs at /api/runs.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve('.');
const port = +(process.argv[2] ?? process.env.PORT ?? 8137);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css', '.md': 'text/plain' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/runs') {
      const runs = [];
      for (const d of await readdir(join(root, 'runs'), { withFileTypes: true }).catch(() => [])) {
        if (!d.isDirectory()) continue;
        const s = await stat(join(root, 'runs', d.name, 'meta.jsonl')).catch(() => null);
        const e = await stat(join(root, 'runs', d.name, 'evo.jsonl')).catch(() => null);
        if (s) runs.push({ name: d.name, mtime: s.mtimeMs, kind: 'climb' });
        else if (e) runs.push({ name: d.name, mtime: e.mtimeMs, kind: 'evolve' });
      }
      runs.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(runs));
    }
    if (url.pathname === '/api/maps') {
      const out = [];
      const walk = async (dir) => {
        for (const d of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
          const rel = dir + '/' + d.name;
          if (d.isDirectory()) await walk(rel);
          else if (d.name.endsWith('.json') && d.name !== 'index.json') out.push(rel);
        }
      };
      await walk('maps');
      out.sort();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([\\/])+/, '');
    if (p === '' || p === '.') { res.writeHead(302, { location: '/viewer/' }); return res.end(); }
    let file = resolve(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`viewer: http://localhost:${port}/viewer/`));
