import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionManager } from '../lib/sessions.js';
import { createWorkerRegistry } from '../lib/registry.js';

function createFakeDsh() {
  const calls = [];
  const records = new Map();
  const listRows = [];
  let nextId = 1;
  const dsh = {
    calls, records, listRows,
    profileContext: { dir: join(tmpdir(), `dsh-profile-${randomUUID()}`) },
    workspaceRegistry: {
      async create(path) { return { id: 'workspace-1', path }; },
      get(id) { return { id, path: undefined }; },
      async resolveByPath(path) { return { id: 'workspace-1', path }; }
    },
    sessionController: {
      async create(options) {
        calls.push(['create', options]);
        const sessionId = `session-${nextId++}`;
        const record = { events: [], status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
        record.snapshotEvents = (from = 0) => record.events.filter((event) => event.seq >= from);
        records.set(sessionId, record);
        return { sessionId };
      },
      async selectModel(options) { calls.push(['selectModel', options]); },
      async prompt(options, signal) {
        signal.throwIfAborted();
        assert.ok(Array.isArray(options.content));
        calls.push(['prompt', options]);
        records.get(options.sessionId).status = 'running';
      },
      async inspect(sessionId) { return { meta: { id: sessionId }, events: records.get(sessionId)?.events ?? [] }; },
      async list() { return { items: listRows }; },
      async cancel(options) { calls.push(['cancel', options]); },
      async resume(sessionId) { calls.push(['resume', sessionId]); }
    },
    sessions: { get(sessionId) { return records.get(sessionId); } },
    agents: { get(sessionId) { return records.get(sessionId); } }
  };
  return dsh;
}

test('creates a visible DSH session, selects its model, and starts the first task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'frontend', role: 'frontend', task: 'Implement the UI' });
    assert.equal(worker.sessionId, 'session-1');
    assert.deepEqual(dsh.calls.map(([name]) => name), ['create', 'selectModel', 'prompt']);
    assert.deepEqual(dsh.calls[0][1], { workspaceId: 'workspace-1' });
    assert.equal(dsh.calls[1][1].provider, 'deepseek-official');
    assert.equal(dsh.calls[1][1].model, 'deepseek-flash');
    assert.equal(dsh.calls[2][1].mode, 'steer');
    const firstPrompt = dsh.calls[2][1].content.map(b => b.text).join('\n');
    assert.match(firstPrompt, /Implement the UI/);
    assert.ok(firstPrompt.startsWith('本会话标题须以 "[GPT] - " 开头。\n\n请用中文分析和汇报。\n\n'));
    assert.ok(firstPrompt.endsWith('Implement the UI'));
    assert.doesNotMatch(firstPrompt, /本次分工|任务原文|本次补充/);
    assert.ok(dsh.calls[2][1].requestId);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not duplicate the title instruction when the task already carries it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-title-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const task = '本会话标题须以 "[GPT] - " 开头。\n\n实现模块';
    await manager.startWorker({ workerId: 'titled', task });
    const prompt = dsh.calls.filter(([name]) => name === 'prompt')[0][1].content.map(b => b.text).join('\n');
    assert.equal(prompt.match(/本会话标题须以/g).length, 1);
    assert.ok(prompt.startsWith('请用中文分析和汇报。\n\n'));
    assert.ok(prompt.endsWith(task));
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses the worker session and briefs workspace changes before the next task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    await writeFile(join(root, 'start.txt'), 'initial');
    const first = await manager.startWorker({ workerId: 'reviewer', role: 'reviewer', task: 'Inspect the project' });
    await writeFile(join(root, 'change.txt'), 'new work');
    const reused = await manager.assignTask({ workerId: 'reviewer', task: 'Review the new changes' });

    assert.equal(reused.sessionId, first.sessionId);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
    const secondPrompt = dsh.calls.filter(([name]) => name === 'prompt')[1][1];
    const secondText = secondPrompt.content.map(b => b.text).join('\n');
    assert.equal(secondPrompt.mode, 'queue');
    assert.match(secondText, /change\.txt/);
    assert.match(secondText, /Review the new changes/);
    assert.ok(secondText.startsWith('自本 worker 上次派工以来'));
    assert.ok(secondText.includes('+ change.txt'));
    assert.ok(secondText.endsWith('Review the new changes'));
    assert.doesNotMatch(secondText, /本次补充|本次分工|任务原文/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('restores an archived worker before reuse without replacing its session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archived-reuse-'));
  const dsh = createFakeDsh();
  const archived = new Set();
  dsh.workspaceRegistry.unarchiveSession = async (sessionId) => {
    dsh.calls.push(['unarchiveSession', sessionId]);
    archived.delete(sessionId);
  };
  const prompt = dsh.sessionController.prompt;
  dsh.sessionController.prompt = async (options, signal) => {
    assert.equal(archived.has(options.sessionId), false, 'archived sessions cannot enter a model step');
    return prompt(options, signal);
  };
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const first = await manager.startWorker({ workerId: 'archived', task: 'First task' });
    for (const dispatch of [
      () => manager.assignTask({ workerId: 'archived', task: 'Continue with the same context', mode: 'steer' }),
      () => manager.startWorker({ workerId: 'archived', task: 'Continue through start' })
    ]) {
      archived.add(first.sessionId);
      const before = dsh.calls.length;
      const reused = await dispatch();
      assert.equal(reused.sessionId, first.sessionId);
      assert.equal(reused.reused, true);
      assert.equal(reused.accepted, true);
      assert.deepEqual(dsh.calls.slice(before).map(([name]) => name), ['unarchiveSession', 'selectModel', 'prompt']);
      assert.equal(dsh.calls[before][1], first.sessionId);
      const reusedText = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1].content.map(b => b.text).join('\n');
      assert.ok(reusedText.endsWith(reused.lastTask));
      assert.doesNotMatch(reusedText, /本次补充|本次分工|任务原文/);
    }
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not admit a reused task when restoring its archived session fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-failure-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const first = await manager.startWorker({ workerId: 'archive-failure', task: 'First task' });
    dsh.records.get(first.sessionId).status = 'idle';
    const failure = new Error('archive storage unavailable');
    dsh.workspaceRegistry.unarchiveSession = async () => { throw failure; };
    const before = dsh.calls.length;
    await assert.rejects(
      manager.assignTask({ workerId: 'archive-failure', task: 'Must not be admitted' }),
      (error) => error.cause === failure && /could not accept the task: archive storage unavailable/.test(error.message)
    );
    assert.equal(dsh.calls.length, before, 'restoration failure must prevent model selection and prompt');
    const [worker] = await manager.listWorkers();
    assert.equal(worker.sessionId, first.sessionId);
    assert.equal(worker.status, 'failed');
    assert.equal(worker.taskCount, 1);
    assert.equal(worker.lastTask, 'First task');
    assert.match(worker.error, /archive storage unavailable/);
    dsh.workspaceRegistry.unarchiveSession = async () => {};
    const retry = await manager.assignTask({ workerId: 'archive-failure', task: 'Retry restoration' });
    const retryPrompt = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1].content.map(b => b.text).join('\n');
    assert.equal(retryPrompt, 'Retry restoration');
    assert.equal(retry.sessionId, first.sessionId);
    assert.equal(retry.taskCount, 2);
    assert.equal(retry.error, undefined);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps first-turn wording when the initial dispatch fails and the same worker retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-first-retry-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const prompt = dsh.sessionController.prompt;
    let attempts = 0;
    dsh.sessionController.prompt = async (options, signal) => {
      attempts += 1;
      if (attempts === 1) throw new Error('admission unavailable');
      return prompt(options, signal);
    };
    await assert.rejects(
      manager.startWorker({ workerId: 'first-retry', task: 'First attempt' }),
      /admission unavailable/
    );
    const retry = await manager.startWorker({ workerId: 'first-retry', task: 'First attempt retried' });
    assert.equal(retry.taskCount, 1);
    const retryPrompt = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1].content.map(b => b.text).join('\n');
    assert.ok(retryPrompt.startsWith('本会话标题须以 "[GPT] - " 开头。\n\n请用中文分析和汇报。\n\n'));
    assert.ok(retryPrompt.endsWith('First attempt retried'));
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes simultaneous starts with the same worker key into one desktop session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-race-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const [first, second] = await Promise.all([
      manager.startWorker({ workerId: 'backend', task: 'First' }),
      manager.startWorker({ workerId: 'backend', task: 'Second' })
    ]);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
    assert.equal((await manager.listWorkers())[0].taskCount, 2);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('pages all zero-based events without gaps or shared-client cursor interference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-progress-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'review', task: 'Review' });
    const record = dsh.records.get(worker.sessionId);
    record.events.push(...Array.from({ length: 5 }, (_, seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `event ${seq}` }] } } })));
    const first = await manager.getProgress({ workerId: 'review', limit: 2 });
    assert.deepEqual(first.events.map(e => e.seq), [0, 1]);
    assert.equal(first.lastSeq, 1);
    assert.equal(first.hasMore, true);
    const next = await manager.getProgress({ workerId: 'review', sinceSeq: first.lastSeq, limit: 2 });
    assert.deepEqual(next.events.map(e => e.seq), [2, 3]);
    const anotherReader = await manager.getProgress({ workerId: 'review', limit: 1 });
    assert.equal(anotherReader.lastSeq, 0);
    record.status = 'idle';
    const waited = await manager.waitForWorker({ workerId: 'review', sinceSeq: 3, timeoutMs: 0 });
    assert.equal(waited.completed, true);
    assert.equal(waited.succeeded, true);
    assert.equal(waited.events[0].seq, 4);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('progress inspection does not swallow workspace changes before reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-changes-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'api', task: 'First' });
    dsh.records.get(worker.sessionId).status = 'idle';
    await writeFile(join(root, 'external-change.txt'), 'new');
    await manager.getProgress({ workerId: 'api' });
    const reused = await manager.assignTask({ workerId: 'api', task: 'Next' });
    assert.match(reused.workspaceChanges, /external-change.txt/);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('wait cancellation ends the observer promptly and leaves the worker running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wait-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    await manager.startWorker({ workerId: 'long', task: 'Work' });
    const controller = new AbortController();
    const waiting = manager.waitForWorker({ workerId: 'long', timeoutMs: 60000 }, { signal: controller.signal });
    controller.abort(new Error('observer disconnected'));
    await assert.rejects(waiting, /observer disconnected/);
    assert.equal(dsh.calls.filter(([name]) => name === 'cancel').length, 0);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('reports agent errors as failures after idle and clears them on the next task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-failure-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'api', task: 'First' });
    manager.onAgentError({ agent: { id: worker.sessionId }, error: new Error('model unavailable') });
    dsh.records.get(worker.sessionId).status = 'idle';
    const result = await manager.waitForWorker({ workerId: 'api', timeoutMs: 0 });
    assert.equal(result.completed, true);
    assert.equal(result.succeeded, false);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /model unavailable/);
    await manager.assignTask({ workerId: 'api', task: 'Retry' });
    assert.equal((await manager.getProgress({ workerId: 'api' })).error, undefined);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('streams bounded transient progress without advancing durable event cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stream-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'live',