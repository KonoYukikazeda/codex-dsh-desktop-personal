import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkspaceSnapshot, describeWorkspaceChanges } from '../lib/briefing.js';

test('summarizes added, changed, and removed workspace files without reading ignored trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-briefing-'));
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'kept.txt'), 'before');
    await writeFile(join(root, 'removed.txt'), 'gone');
    await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored');
    const before = await captureWorkspaceSnapshot(root);

    await writeFile(join(root, 'kept.txt'), 'after and longer');
    await writeFile(join(root, 'added.txt'), 'new');
    await rm(join(root, 'removed.txt'));
    await writeFile(join(root, 'node_modules', 'ignored.txt'), 'still ignored');

    const changes = await describeWorkspaceChanges(root, before);
    assert.match(changes.summary, /added\.txt/);
    assert.match(changes.summary, /kept\.txt/);
    assert.match(changes.summary, /removed\.txt/);
    assert.doesNotMatch(changes.summary, /node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('labels the baseline as the last dispatch and ignores DSH state trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-briefing-'));
  try {
    await mkdir(join(root, '.dsh'));
    await writeFile(join(root, '.dsh', 'large-state.json'), 'state');
    const before = await captureWorkspaceSnapshot(root);
    await writeFile(join(root, 'task.txt'), 'new');
    const changes = await describeWorkspaceChanges(root, before);
    assert.equal(before.has('.dsh/large-state.json'), false);
    assert.match(changes.summary, /上次派工/);
    assert.match(changes.summary, /不是上次完成/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a capped scan reports incomplete coverage and cannot report unseen files as removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-briefing-'));
  try {
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'z.txt'), 'z');
    const before = await captureWorkspaceSnapshot(root);
    const changes = await describeWorkspaceChanges(root, before, { maxEntries: 1 });
    assert.ok(changes.snapshot instanceof Map);
    assert.equal(changes.snapshot.scan.complete, false);
    assert.deepEqual(changes.removed, []);
    assert.match(changes.summary, /扫描不完整/);
    assert.match(changes.summary, /不推断删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing workspace is reported as a scan failure rather than wholesale deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-briefing-'));
  await writeFile(join(root, 'keep.txt'), 'keep');
  const before = await captureWorkspaceSnapshot(root);
  await rm(root, { recursive: true, force: true });
  const changes = await describeWorkspaceChanges(root, before);
  assert.deepEqual(changes.removed, []);
  assert.equal(changes.snapshot.scan.complete, false);
  assert.match(changes.summary, /ENOENT/);
});

test('an incomplete baseline cannot establish that previously unobserved files are new', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-briefing-'));
  try {
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'z.txt'), 'z');
    const before = await captureWorkspaceSnapshot(root, { maxEntries: 1 });
    const changes = await describeWorkspaceChanges(root, before);
    assert.deepEqual(changes.added, []);
    assert.match(changes.summary, /基线扫描不完整/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
