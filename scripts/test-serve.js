// Run with node --test scripts/test-serve.js.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

async function writeFiles(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}

test('viewer server confines static files and API listings', { timeout: 20000 }, async (t) => {
  const temp = await realpath(tmpdir());
  const fixture = await mkdtemp(join(temp, 'dbd-viewer-'));
  const repo = join(fixture, 'repo');
  const outside = join(fixture, 'outside');
  const entry = join(repo, 'scripts', 'serve.js');
  let server, stopped;
  t.after(async () => {
    server?.kill();
    await stopped;
    assert.equal(dirname(fixture), temp);
    assert.equal(await realpath(fixture), fixture);
    await rm(fixture, { recursive: true, force: true });
  });

  const publicFiles = {
    'viewer/index.html': '<title>Fixture viewer</title>',
    'viewer/duel.html': '<title>Fixture duel</title>',
    'viewer/main.js': 'export {};',
    'viewer/viewer.css': 'body {}',
    'src/sim/index.js': 'export {};',
    'src/brains/index.js': 'export {};',
    'src/duel/shack.js': 'export {};',
    'src/hillclimb/params.js': 'export {};',
    'src/hillclimb/bloodpoints.js': 'export {};',
    'src/hillclimb/hunterscore.js': 'export {};',
    'maps/test-small.json': '{}',
    'maps/variants/index.json': '[]',
    'maps/variants/small map.json': '{}',
    'runs/climb/meta.jsonl': '{"gen":1}\n',
    'runs/climb/evo.jsonl': '{"gen":1}\n',
    'runs/evolution/evo.jsonl': '{"gen":2}\n',
    'runs/evolution/config.json': '{"modifiers":{"genSeconds":65}}',
    'runs/evolution/champions.json': '{}',
    'docs/research/gen-placement-comparison.html': '<title>Fixture chart</title>',
    'docs/research/infinite-loop-causes.html': '<title>Fixture chart</title>',
  };
  const privateFiles = [
    'local-notes.json',
    'viewer/notes.txt',
    'viewer/.draft.js',
    'src/sim/notes.json',
    'src/hillclimb/worker.js',
    'maps/variants/notes.txt',
    'runs/notes.json',
    'runs/evolution/notes.json',
    'runs/evolution/archive/config.json',
    'docs/research/local-notes.html',
  ];
  await writeFiles(repo, {
    'package.json': '{"type":"module"}',
    ...publicFiles,
    ...Object.fromEntries(privateFiles.map((name) => [name, 'private fixture'])),
  });
  await mkdir(dirname(entry));
  await copyFile(new URL('./serve.js', import.meta.url), entry);
  await writeFiles(outside, {
    'viewer/index.html': '<title>Different working directory</title>',
    'map.json': '{}',
    'meta.jsonl': '{}\n',
    'config.json': '{"modifiers":{"genSeconds":99}}',
  });
  const climbTime = new Date('2025-01-01T00:00:00Z');
  const evoTime = new Date('2025-02-01T00:00:00Z');
  await utimes(join(repo, 'runs/climb/meta.jsonl'), climbTime, climbTime);
  await utimes(join(repo, 'runs/evolution/evo.jsonl'), evoTime, evoTime);

  server = spawn(process.execPath, [entry, '0'], { cwd: outside, stdio: ['ignore', 'pipe', 'inherit'] });
  stopped = new Promise((resolve) => server.once('close', resolve));
  await once(server, 'spawn');
  const lines = createInterface({ input: server.stdout });
  const [message] = await once(lines, 'line', { signal: AbortSignal.timeout(5000) });
  lines.close();
  const port = /^viewer: http:\/\/localhost:(\d+)\/viewer\/$/.exec(message)?.[1];
  assert.ok(Number(port) > 0, message);
  const get = (path) => fetch(`http://127.0.0.1:${port}/${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  const getJson = async (path) => {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'application/json', path);
    return response.json();
  };
  const expectMissing = async (path) => {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'not found', path);
  };

  await t.test('serves the viewer and supported resources from the script location', async () => {
    const redirect = await get('');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/viewer/');
    const types = {
      '': 'text/html', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.jsonl': 'text/plain',
    };
    for (const [path, body] of Object.entries({
      viewer: publicFiles['viewer/index.html'],
      'viewer/': publicFiles['viewer/index.html'],
      ...publicFiles,
    })) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), types[extname(path)], path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.equal(await response.text(), body, path);
    }
    assert.deepEqual(await getJson('api/maps'), ['maps/test-small.json', 'maps/variants/small map.json']);
    assert.deepEqual(await getJson('api/runs'), [
      { name: 'evolution', mtime: +evoTime, kind: 'evolve', modifiers: { genSeconds: 65 } },
      { name: 'climb', mtime: +climbTime, kind: 'climb' },
    ]);
    for (const path of privateFiles) await expectMissing(path);
  });

  await t.test('excludes linked files from static serving and API metadata', async (subtest) => {
    try {
      await symlink(join(outside, 'meta.jsonl'), join(repo, 'runs/evolution/meta.jsonl'), 'file');
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      subtest.skip('Windows file symlinks require developer mode or elevated privileges');
      return;
    }
    await symlink(join(outside, 'config.json'), join(repo, 'runs/climb/config.json'), 'file');
    await symlink(join(outside, 'map.json'), join(repo, 'maps/linked.json'), 'file');
    for (const path of ['runs/evolution/meta.jsonl', 'runs/climb/config.json', 'maps/linked.json']) {
      await expectMissing(path);
    }
    assert.deepEqual(await getJson('api/maps'), ['maps/test-small.json', 'maps/variants/small map.json']);
    assert.deepEqual(await getJson('api/runs'), [
      { name: 'evolution', mtime: +evoTime, kind: 'evolve', modifiers: { genSeconds: 65 } },
      { name: 'climb', mtime: +climbTime, kind: 'climb' },
    ]);
  });

  await t.test('excludes linked directories and linked public roots', async () => {
    for (const dir of ['viewer', 'maps', 'runs']) {
      await symlink(outside, join(repo, dir, 'linked'), 'junction');
    }
    for (const path of ['viewer/linked/viewer/index.html', 'maps/linked/map.json', 'runs/linked/meta.jsonl']) {
      await expectMissing(path);
    }
    assert.deepEqual(await getJson('api/maps'), ['maps/test-small.json', 'maps/variants/small map.json']);
    assert.deepEqual((await getJson('api/runs')).map((run) => run.name), ['evolution', 'climb']);

    for (const dir of ['maps', 'runs']) {
      const moved = join(repo, `${dir}-original`);
      await rename(join(repo, dir), moved);
      await symlink(moved, join(repo, dir), 'junction');
      assert.deepEqual(await getJson(`api/${dir}`), []);
    }
    await expectMissing('maps/test-small.json');
    await expectMissing('runs/climb/meta.jsonl');
  });
});
