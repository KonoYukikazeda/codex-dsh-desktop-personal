import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkerRegistry, parseRegistryDocument, REGISTRY_VERSION, RegistryError, resolveRegistryPath
} from '../lib/registry.js';

const worker = (overrides = {}) => ({
  workerId: 'frontend', sessionId: 'session-1', role: 'frontend',
  workspaceId: 'workspace-1', cwd: 'C:/projects/demo',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  taskCount: 1, lastTask: 'Implement the UI', ...overrides
});

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-registry-'));
}

test('defaults to the DSH profile directory and round-trips a versioned registry', async () => {
  const root = await tempRoot();
  const registry = createWorkerRegistry({ profileContext: { dir: root } });
  assert.equal(registry.path, join(root, 'codex-dsh-desktop', 'workers.json'));
  assert.deepEqual(await registry.load(), []);
  await registry.save([worker()]);
  const document = JSON.parse(await readFile(registry.path, 'utf8'));
  assert.equal(document.version, REGISTRY_VERSION);
  assert.equal(document.workers[0].sessionId, 'session-1');
  assert.deepEqual(await createWorkerRegistry({ profileContext: { dir: root } }).load(), [worker()]);
  const files = await readdir(join(root, 'codex-dsh-desktop'));
  assert.deepEqual(files, ['workers.json'], 'a successful atomic write leaves no temporary file');
  await rm(root, { recursive: true, force: true });
});

test('an explicit stateFile overrides the profile directory and a missing location is loud', () => {
  assert.equal(resolveRegistryPath({ stateFile: 'C:/tmp/custom.json' }), 'C:\\tmp\\custom.json');
  assert.throws(
    () => resolveRegistryPath({}),
    (error) => error instanceof RegistryError && error.code === 'NO_LOCATION' && /profileContext/.test(error.message)
  );
});

test('corrupt JSON is reported and never replaced by an empty registry', async () => {
  const root = await tempRoot();
  const path = join(root, 'workers.json');
  const corrupt = '{"version":1,"workers":[';
  await writeFile(path, corrupt, 'utf8');
  await assert.rejects(
    () => createWorkerRegistry({ stateFile: path }).load(),
    (error) => error instanceof RegistryError && error.code === 'INVALID_JSON' && /left unchanged/.test(error.message)
  );
  assert.equal(await readFile(path, 'utf8'), corrupt);
  await rm(root, { recursive: true, force: true });
});

test('unsupported versions, duplicate workers and duplicate sessions are rejected', async () => {
  assert.throws(
    () => parseRegistryDocument({ version: 99, workers: [] }, 'fixture'),
    (error) => error.code === 'UNSUPPORTED_VERSION' && /version 99/.test(error.message)
  );
  assert.throws(
    () => parseRegistryDocument({ version: 1, workers: [worker(), worker()] }, 'fixture'),
    (error) => error.code === 'CONFLICT' && /duplicate workerId/.test(error.message)
  );
  assert.throws(
    () => parseRegistryDocument({ version: 1, workers: [worker(), worker({ workerId: 'backend' })] }, 'fixture'),
    (error) => error.code === 'CONFLICT' && /more than one worker/.test(error.message)
  );
  const parsed = parseRegistryDocument({ version: 1, workers: [worker()] }, 'fixture');
  assert.deepEqual(parsed, [worker()]);
});

test('a failed write reports WRITE_FAILED and leaves no partial registry', async () => {
  const root = await tempRoot();
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'not a directory', 'utf8');
  const registry = createWorkerRegistry({ stateFile: join(blocker, 'workers.json') });
  await assert.rejects(
    () => registry.save([worker()]),
    (error) => error instanceof RegistryError && error.code === 'WRITE_FAILED'
  );
  await rm(root, { recursive: true, force: true });
});

test('concurrent saves are serialized and the last accepted snapshot wins intact', async () => {
  const root = await tempRoot();
  const registry = createWorkerRegistry({ stateFile: join(root, 'workers.json') });
  await Promise.all([
    registry.save([worker({ workerId: 'first', sessionId: 'session-first' })]),
    registry.save([worker({ workerId: 'second', sessionId: 'session-second', lastTask: 'second task' })])
  ]);
  const loaded = await createWorkerRegistry({ stateFile: join(root, 'workers.json') }).load();
  assert.deepEqual(loaded, [worker({ workerId: 'second', sessionId: 'session-second', lastTask: 'second task' })]);
  const files = await readdir(root);
  assert.deepEqual(files, ['workers.json']);
  await rm(root, { recursive: true, force: true });
});
