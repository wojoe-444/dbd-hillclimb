// Zero-dependency static server for the viewer: node scripts/serve.js [port]
// Serves viewer assets, browser modules, maps, selected run artifacts and research charts.
import { createServer } from 'node:http';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const port = +(process.argv[2] ?? process.env.PORT ?? 8137);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };
const viewerTypes = new Set(['.html', '.js', '.css', '.svg', '.png']);
const runFiles = new Set(['meta.jsonl', 'evo.jsonl', 'config.json', 'champions.json']);
const publicFiles = new Set([
  'src/duel/shack.js',
  'src/hillclimb/bloodpoints.js',
  'src/hillclimb/hunterscore.js',
  'src/hillclimb/params.js',
  'docs/research/gen-placement-comparison.html',
  'docs/research/infinite-loop-causes.html',
]);

function isPathComponent(name) {
  return name !== '' && !name.startsWith('.') && !/[/\\:\0]/.test(name) && !/[. ]$/.test(name);
}

function isStaticPath(parts) {
  const [area, group, file] = parts;
  const extension = extname(parts.at(-1));
  if (area === 'viewer') return parts.length >= 2 && viewerTypes.has(extension);
  if (area === 'maps') return parts.length >= 2 && extension === '.json';
  if (area === 'runs') return parts.length === 3 && runFiles.has(file);
  if (area === 'src' && (group === 'sim' || group === 'brains')) return parts.length === 3 && extension === '.js';
  return publicFiles.has(parts.join('/'));
}

async function confinedEntry(parts) {
  if (!parts.every(isPathComponent)) return null;
  const path = join(root, ...parts);
  try {
    // The root is already canonical. Reject aliases at every level, including linked public directories.
    if (await realpath(path) !== path) return null;
    return { path, info: await lstat(path) };
  } catch {
    return null;
  }
}

async function confinedFile(parts) {
  const entry = await confinedEntry(parts);
  return entry?.info.isFile() ? entry : null;
}

async function readDirectory(parts) {
  const entry = await confinedEntry(parts);
  if (!entry?.info.isDirectory()) return [];
  return readdir(entry.path, { withFileTypes: true }).catch(() => []);
}

async function listRuns() {
  const runs = [];
  for (const d of await readDirectory(['runs'])) {
    if (!d.isDirectory() || !isPathComponent(d.name)) continue;
    const dir = ['runs', d.name];
    const climb = await confinedFile([...dir, 'meta.jsonl']);
    const log = climb ?? await confinedFile([...dir, 'evo.jsonl']);
    if (!log) continue;
    const config = await confinedFile([...dir, 'config.json']);
    const cfg = config ? await readFile(config.path, 'utf8').then(JSON.parse).catch(() => null) : null;
    const mods = cfg?.modifiers && Object.keys(cfg.modifiers).length ? { modifiers: cfg.modifiers } : {};
    runs.push({ name: d.name, mtime: log.info.mtimeMs, kind: climb ? 'climb' : 'evolve', ...mods });
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

async function listMaps() {
  const maps = [];
  const walk = async (dir) => {
    for (const d of await readDirectory(dir)) {
      if (!isPathComponent(d.name)) continue;
      const parts = [...dir, d.name];
      if (d.isDirectory()) await walk(parts);
      else if (d.isFile() && d.name.endsWith('.json') && d.name !== 'index.json') maps.push(parts.join('/'));
    }
  };
  await walk(['maps']);
  return maps.sort();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/runs' || url.pathname === '/api/maps') {
      const data = url.pathname === '/api/runs' ? await listRuns() : await listMaps();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/viewer/' });
      return res.end();
    }
    const pathname = url.pathname === '/viewer' || url.pathname === '/viewer/' ? '/viewer/index.html' : url.pathname;
    const parts = pathname.slice(1).split('/').map(decodeURIComponent);
    if (isStaticPath(parts)) {
      const file = await confinedFile(parts);
      if (file) {
        const body = await readFile(file.path);
        res.writeHead(200, { 'content-type': types[extname(file.path)], 'cache-control': 'no-store' });
        return res.end(body);
      }
    }
  } catch {
    // Malformed URLs and files disappearing during a request use the same response as missing files.
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, () => console.log(`viewer: http://localhost:${server.address().port}/viewer/`));
