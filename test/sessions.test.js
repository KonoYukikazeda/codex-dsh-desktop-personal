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
    assert.doesNotMatch(firstPrompt, /^\[GPT\]:/);
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

test('reuses the worker session and prefixes follow-up task text with [GPT]', async () => {
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
    assert.equal(secondText, '[GPT]:\nReview the new changes');
    assert.equal(secondText.slice('[GPT]:\n'.length), 'Review the new changes');
    assert.doesNotMatch(secondText, /change\.txt|自本 worker|本次补充|本次分工|任务原文/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not duplicate the [GPT] source marker when the task already starts with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prefix-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    await manager.startWorker({ workerId: 'prefix', task: 'First' });
    const task = '[GPT]:\nKeep this body verbatim';
    await manager.assignTask({ workerId: 'prefix', task });
    const prompt = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1];
    const text = prompt.content.map((block) => block.text).join('\n');
    assert.equal(text, task);
    assert.equal(text.match(/\[GPT\]:/g).length, 1);
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
      assert.ok(reusedText.startsWith('[GPT]:\n'));
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
    assert.equal(retryPrompt, '[GPT]:\nRetry restoration');
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

test('progress inspection does not alter the next task text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-changes-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'api', task: 'First' });
    dsh.records.get(worker.sessionId).status = 'idle';
    await writeFile(join(root, 'external-change.txt'), 'new');
    await manager.getProgress({ workerId: 'api' });
    const reused = await manager.assignTask({ workerId: 'api', task: 'Next' });
    assert.equal(reused.sessionId, worker.sessionId);
    const prompt = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1];
    const text = prompt.content.map((block) => block.text).join('\n');
    assert.equal(text, '[GPT]:\nNext');
    assert.doesNotMatch(text, /external-change|自本 worker/);
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
    const worker = await manager.startWorker({ workerId: 'live', task: 'Work' });
    let revision = 0;
    const emit = (frame) => manager.onAssistantStream({ agent: { id: worker.sessionId }, frame: { attemptId: 'attempt', revision: ++revision, ...frame } });
    emit({ type: 'start' });
    emit({ type: 'chunk', index: 0, chunk: { type: 'reasoning-delta', text: 'Inspecting workspace' } });
    let progress = await manager.getProgress({ workerId: 'live' });
    assert.match(progress.transientProgress.text, /Inspecting workspace/);
    assert.equal(progress.lastSeq, -1);
    const waiting = manager.waitForWorker({ workerId: 'live', timeoutMs: 1000 });
    for (let index = 1; index < 5; index++) emit({ type: 'chunk', index, chunk: { type: 'text-delta', text: 'x'.repeat(5000) } });
    progress = await waiting;
    assert.equal(progress.completed, false);
    assert.equal(progress.transientProgress.truncated, true);
    assert.ok(progress.transientProgress.text.length <= 12000);
    emit({ type: 'end', outcome: { kind: 'committed', seq: 0 } });
    assert.equal((await manager.getProgress({ workerId: 'live' })).transientProgress, undefined);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('reads cold session history and reuses through prompt without a public resume call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'cold', task: 'First' });
    dsh.records.get(worker.sessionId).events.push({ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'history' }] } });
    dsh.sessions.get = () => undefined;
    dsh.agents.get = () => undefined;
    const progress = await manager.getProgress({ workerId: 'cold' });
    assert.equal(progress.status, 'released');
    assert.match(progress.events[0].text, /history/);
    assert.equal((await manager.assignTask({ workerId: 'cold', task: 'Continue' })).sessionId, worker.sessionId);
    assert.equal(dsh.calls.filter(([name]) => name === 'resume').length, 0);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('forwards request cancellation to cold-session inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inspect-abort-'));
  const dsh = createFakeDsh();
  let seenSignal;
  dsh.sessions.get = () => undefined;
  dsh.agents.get = () => undefined;
  dsh.sessionController.inspect = async (_sessionId, signal) => {
    seenSignal = signal;
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    await manager.startWorker({ workerId: 'cold-abort', task: 'First' });
    const controller = new AbortController();
    const pending = manager.getProgress({ workerId: 'cold-abort' }, { signal: controller.signal });
    controller.abort(new Error('request disconnected'));
    await assert.rejects(pending, /request disconnected/);
    assert.ok(seenSignal instanceof AbortSignal);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('queued work prevents idle completion and cancellation preserves the inbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-queue-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'q', task: 'First' });
    const record = dsh.records.get(worker.sessionId);
    record.status = 'idle';
    record.inbox.nextTurn.push('pending');
    assert.equal((await manager.waitForWorker({ workerId: 'q', timeoutMs: 0 })).completed, false);
    assert.equal((await manager.cancelWorker({ workerId: 'q' })).queuedTasksPreserved, true);
    assert.deepEqual(record.inbox.nextTurn, ['pending']);
    record.inbox.nextTurn.length = 0;
    const result = await manager.waitForWorker({ workerId: 'q', timeoutMs: 0 });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.succeeded, false);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('durable turn endings distinguish desktop stop, blocked and failed work from success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-outcome-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'outcome', task: 'Read the project' });
    const record = dsh.records.get(worker.sessionId);
    const cases = [
      [{ kind: 'aborted', reason: { kind: 'user' } }, 'cancelled'],
      [{ kind: 'blocked' }, 'blocked'],
      [{ kind: 'error', error: { code: 'UNKNOWN', message: 'provider failed' } }, 'failed'],
      [{ kind: 'max-tokens' }, 'failed'],
      [{ kind: 'interrupted' }, 'failed'],
      [{ kind: 'plugin-defined-stop' }, 'failed'],
      [{ kind: 'completed' }, 'idle']
    ];
    for (const [reason, expected] of cases) {
      record.events.push({ seq: record.events.length, type: 'turn/start', data: { turn: 1 } });
      record.events.push({ seq: record.events.length, type: 'turn/end', data: { turn: 1, reason } });
      record.status = 'idle';
      const progress = await manager.waitForWorker({ workerId: 'outcome', timeoutMs: 0 });
      assert.equal(progress.status, expected, reason.kind);
      assert.equal(progress.completed, true, reason.kind);
      assert.equal(progress.succeeded, expected === 'idle', reason.kind);
      assert.deepEqual(progress.turnEndReason, reason);
      assert.equal((await manager.listWorkers())[0].status, expected);
      const laterPage = await manager.waitForWorker({ workerId: 'outcome', sinceSeq: record.events.length + 100, timeoutMs: 0 });
      assert.equal(laterPage.events.length, 0);
      assert.equal(laterPage.status, expected);
      assert.equal(laterPage.succeeded, expected === 'idle');
    }
    record.events.push({ seq: record.events.length, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
    record.inbox.nextTurn.push('retained pending task');
    const stoppedWithQueue = await manager.waitForWorker({ workerId: 'outcome', timeoutMs: 0 });
    assert.equal(stoppedWithQueue.status, 'cancelled');
    assert.equal(stoppedWithQueue.completed, true);
    assert.equal(stoppedWithQueue.queuedTaskCount, 1);
    record.inbox.nextTurn.length = 0;
    record.events.push({ seq: record.events.length, type: 'turn/start', data: { turn: 2 } });
    record.status = 'running';
    const running = await manager.getProgress({ workerId: 'outcome' });
    assert.equal(running.status, 'running');
    assert.equal(running.turnEndReason, undefined);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('completion wait hands the resident session back for Codex review and reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'handoff', task: 'Implement the module' });
    const record = dsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';

    const completed = await manager.waitForWorker({ workerId: 'handoff', timeoutMs: 0 });
    assert.equal(completed.completed, true);
    assert.equal(completed.succeeded, true);
    assert.equal(completed.waitFor, 'completion');
    assert.deepEqual(completed.handoff, {
      phase: 'deepseek-complete',
      awaitingReview: true,
      reusable: true,
      workerId: 'handoff',
      sessionId: worker.sessionId,
      nextAction: 'DS 本轮已结束；请复核其主验结果与关键证据，做业务裁决和最终验收。如需修改，用同一 workerId 调用 dsh_assign_task。'
    });

    const followUp = await manager.assignTask({ workerId: 'handoff', task: 'Fix the review findings' });
    assert.equal(followUp.sessionId, worker.sessionId);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
    assert.equal(followUp.handoff.phase, 'deepseek-running');
    assert.equal(followUp.handoff.reusable, true);
    const followUpText = dsh.calls.filter(([name]) => name === 'prompt').at(-1)[1].content.map(b => b.text).join('\n');
    assert.equal(followUpText, '[GPT]:\nFix the review findings');
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('completion wait returns a reusable handoff for failed work too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-failed-handoff-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'failed-handoff', task: 'Run the risky task' });
    const record = dsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', message: 'provider failed' } } });
    record.status = 'idle';
    const result = await manager.waitForWorker({ workerId: 'failed-handoff', waitFor: 'completion', timeoutMs: 0 });
    assert.equal(result.status, 'failed');
    assert.equal(result.handoff.phase, 'deepseek-failed');
    assert.equal(result.handoff.awaitingReview, true);
    assert.equal(result.handoff.reusable, true);
    assert.match(result.handoff.nextAction, /同一 workerId/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('completion wait does not report a reused turn before its new lifecycle event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-race-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'handoff-race', task: 'First task' });
    const record = dsh.records.get(worker.sessionId);
    record.status = 'idle';
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await manager.getProgress({ workerId: 'handoff-race' });
    await manager.assignTask({ workerId: 'handoff-race', task: 'Follow-up task' });
    record.status = 'idle';

    const beforeStart = await manager.waitForWorker({ workerId: 'handoff-race', timeoutMs: 0 });
    assert.equal(beforeStart.completed, false);
    assert.equal(beforeStart.status, 'queued');
    assert.equal(beforeStart.handoff.phase, 'deepseek-running');

    record.events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } });
    record.events.push({ seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    record.status = 'idle';
    const afterEnd = await manager.waitForWorker({ workerId: 'handoff-race', timeoutMs: 0 });
    assert.equal(afterEnd.completed, true);
    assert.equal(afterEnd.handoff.phase, 'deepseek-complete');
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('completion wait keeps a cold reused session pending until DSH starts its turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-handoff-race-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root } });
  try {
    const worker = await manager.startWorker({ workerId: 'cold-race', task: 'First task' });
    const record = dsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';
    await manager.getProgress({ workerId: 'cold-race' });
    dsh.sessions.get = () => undefined;
    dsh.agents.get = () => undefined;
    await manager.assignTask({ workerId: 'cold-race', task: 'Continue after review' });
    const pending = await manager.waitForWorker({ workerId: 'cold-race', timeoutMs: 0 });
    assert.equal(pending.completed, false);
    assert.equal(pending.status, 'queued');
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function recordFor(sessionId) {
  const record = { events: [], status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  record.snapshotEvents = (from = 0) => record.events.filter((event) => event.seq >= from);
  return record;
}

test('rebuilds the manager from the profile registry with the same session and no extra create or prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
  const stateFile = join(root, 'registry', 'workers.json');
  const firstDsh = createFakeDsh();
  const first = createSessionManager({ ...firstDsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    await first.ready();
    worker = await first.startWorker({ workerId: 'api', role: 'backend', task: 'First task' });
  } finally {
    await first.dispose();
  }
  assert.equal(firstDsh.calls.filter(([name]) => name === 'create').length, 1);

  const secondDsh = createFakeDsh();
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  secondDsh.records.set(worker.sessionId, recordFor(worker.sessionId));
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    assert.deepEqual(secondDsh.calls, [], 'startup validates but never creates, prompts, selects a model or cancels');
    const [restored] = await second.listWorkers();
    assert.equal(restored.sessionId, worker.sessionId);
    assert.equal(restored.restored, true);
    assert.equal(restored.taskCount, 1);
    assert.equal(restored.lastTask, 'First task');
    const reused = await second.assignTask({ workerId: 'api', task: 'Continue after restart' });
    assert.equal(reused.sessionId, worker.sessionId);
    assert.equal(reused.reused, true);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'prompt').length, 1);
    assert.equal(
      secondDsh.calls.find(([name]) => name === 'prompt')[1].content.map((block) => block.text).join('\n'),
      '[GPT]:\nContinue after restart'
    );
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('reports a deleted DSH session explicitly and never creates a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missing-session-'));
  const stateFile = join(root, 'workers.json');
  const firstDsh = createFakeDsh();
  const first = createSessionManager({ ...firstDsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    worker = await first.startWorker({ workerId: 'gone', task: 'First task' });
  } finally {
    await first.dispose();
  }

  const secondDsh = createFakeDsh();
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    const [missing] = await second.listWorkers();
    assert.equal(missing.sessionId, worker.sessionId);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.missingSession, true);
    assert.equal(missing.reusable, false);
    assert.match(missing.sessionError, /was not found/);
    await assert.rejects(
      second.assignTask({ workerId: 'gone', task: 'Must not run' }),
      /no longer exists.*Refusing to replace it with a new session/s
    );
    await assert.rejects(second.getProgress({ workerId: 'gone' }), /no longer exists/);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'prompt').length, 0);
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('binds an existing session idempotently without dispatching or selecting a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bind-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push(
    { sessionId: 'old-session', cwd: root, agentAvailable: false, running: false },
    { sessionId: 'other-session', cwd: root, agentAvailable: false, running: false }
  );
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    const bound = await manager.bindWorker({
      workerId: 'quote_demo', sessionId: 'old-session', role: 'legacy',
      customer: '085', purpose: '旧会话迁移'
    });
    assert.equal(bound.sessionId, 'old-session');
    assert.equal(bound.workerId, 'quote_demo');
    assert.equal(bound.customer, '085');
    assert.equal(bound.purpose, '旧会话迁移');
    assert.equal(bound.lifecycle, 'active');
    assert.equal(bound.sessionId, 'old-session');
    assert.equal(bound.workerId, 'quote_demo');
    assert.equal(bound.bound, true);
    assert.equal(bound.alreadyBound, false);
    assert.equal(bound.workspace, root);
    assert.equal(bound.status, 'released');
    assert.deepEqual(dsh.calls.filter(([name]) => ['create', 'prompt', 'selectModel', 'cancel'].includes(name)), []);
    const again = await manager.bindWorker({ workerId: 'quote_demo', sessionId: 'old-session' });
    assert.equal(again.alreadyBound, true);
    assert.equal((await manager.listWorkers()).length, 1);
    await assert.rejects(
      manager.bindWorker({ workerId: 'other-worker', sessionId: 'old-session' }),
      /already bound to worker "quote_demo"/
    );
    await assert.rejects(
      manager.bindWorker({ workerId: 'quote_demo', sessionId: 'other-session' }),
      /already bound to DSH session "old-session"/
    );
    await assert.rejects(
      manager.bindWorker({ workerId: 'absent', sessionId: 'missing-session' }),
      /was not found/
    );
    assert.equal((await manager.listWorkers()).length, 1);
    const reloaded = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
    try {
      const [restored] = await reloaded.listWorkers();
      assert.equal(restored.sessionId, 'old-session');
      assert.equal(restored.role, 'legacy');
      assert.equal(restored.taskCount, 0);
      assert.equal(restored.customer, '085');
      assert.equal(restored.purpose, '旧会话迁移');
      assert.equal(restored.lifecycle, 'active');
    } finally {
      await reloaded.dispose();
    }
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent binds of one session to different workers keep exactly one loadable binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bind-race-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'shared-session', cwd: root, agentAvailable: false, running: false });
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    const results = await Promise.allSettled([
      manager.bindWorker({ workerId: 'first', sessionId: 'shared-session' }),
      manager.bindWorker({ workerId: 'second', sessionId: 'shared-session' })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const workers = await manager.listWorkers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].sessionId, 'shared-session');
    const loaded = await createWorkerRegistry({ stateFile }).load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sessionId, 'shared-session');
    assert.ok(['first', 'second'].includes(loaded[0].workerId));
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed registry write rolls a new binding back instead of leaving a half-binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bind-write-fail-'));
  const stateFile = join(root, 'state', 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'old-session', cwd: root, agentAvailable: false, running: false });
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.ready();
    await writeFile(join(root, 'state'), 'blocks the registry directory', 'utf8');
    await assert.rejects(
      manager.bindWorker({ workerId: 'legacy', sessionId: 'old-session' }),
      /registry write failed.*No half-binding/s
    );
    assert.deepEqual(await manager.listWorkers(), []);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed registry write before first dispatch leaves no binding and sends no prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-start-write-fail-'));
  const stateFile = join(root, 'state', 'workers.json');
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.ready();
    await writeFile(join(root, 'state'), 'blocks the registry directory', 'utf8');
    await assert.rejects(
      manager.startWorker({ workerId: 'api', task: 'First task' }),
      /worker registry write failed.*No task was dispatched/s
    );
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
    assert.equal(dsh.calls.filter(([name]) => name === 'prompt').length, 0);
    assert.deepEqual(await manager.listWorkers(), []);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt registry is reported and preserved, blocking mutations instead of silently starting empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-corrupt-'));
  const stateFile = join(root, 'workers.json');
  const corrupt = '{"version":1,"workers":[{"workerId":"api"';
  await writeFile(stateFile, corrupt, 'utf8');
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.ready();
    await assert.rejects(manager.listWorkers(), /could not be loaded.*left unchanged/s);
    await assert.rejects(manager.startWorker({ workerId: 'api', task: 'First task' }), /could not be loaded/);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(await readFile(stateFile, 'utf8'), corrupt);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent saves keep every worker record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-concurrent-save-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await Promise.all([
      manager.startWorker({ workerId: 'one', task: 'First worker' }),
      manager.startWorker({ workerId: 'two', task: 'Second worker' })
    ]);
    const reloaded = createFakeDsh();
    reloaded.listRows.push(
      { sessionId: 'session-1', cwd: root, agentAvailable: false, running: false },
      { sessionId: 'session-2', cwd: root, agentAvailable: false, running: false }
    );
    const second = createSessionManager({ ...reloaded, config: { workspace: root }, stateFile });
    try {
      const workers = await second.listWorkers();
      assert.deepEqual(workers.map((worker) => worker.workerId).sort(), ['one', 'two']);
      assert.equal(workers.every((worker) => worker.taskCount === 1), true);
    } finally {
      await second.dispose();
    }
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('cold sessions use passive state and native readSession history without prompting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-adapter-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'cold-session', cwd: root, agentAvailable: false, running: false });
  delete dsh.sessionController.inspect;
  dsh.sessionController.state = async () => ({ cursor: 0, active: false, running: false, queue: [], pendingInput: [] });
  dsh.sessionQuery = {
    async readSession() {
      return {
        session: { id: 'cold-session', cwd: root },
        events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'cold history' }] } } }]
      };
    }
  };
  dsh.sessionController.prompt = async (options) => { dsh.calls.push(['prompt', options]); };
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.bindWorker({ workerId: 'cold', sessionId: 'cold-session' });
    const progress = await manager.getProgress({ workerId: 'cold' });
    assert.equal(progress.status, 'released');
    assert.match(progress.events[0].text, /cold history/);
    const reused = await manager.assignTask({ workerId: 'cold', task: 'Continue cold' });
    assert.equal(reused.sessionId, 'cold-session');
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(dsh.calls.filter(([name]) => name === 'prompt').length, 1);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a restored worker does not report success from old history before its new turn starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restored-barrier-'));
  const stateFile = join(root, 'workers.json');
  const firstDsh = createFakeDsh();
  const first = createSessionManager({ ...firstDsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    worker = await first.startWorker({ workerId: 'restored', task: 'First task' });
    const record = firstDsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';
  } finally {
    await first.dispose();
  }

  const secondDsh = createFakeDsh();
  const record = recordFor(worker.sessionId);
  record.events.push(
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  );
  secondDsh.records.set(worker.sessionId, record);
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    const accepted = await second.assignTask({ workerId: 'restored', task: 'Continue after restart' });
    assert.equal(accepted.sessionId, worker.sessionId);
    record.status = 'idle';
    const beforeTurn = await second.waitForWorker({ workerId: 'restored', timeoutMs: 0 });
    assert.equal(beforeTurn.completed, false, 'old turn/end must not complete the new dispatch');
    assert.equal(beforeTurn.status, 'queued');
    assert.equal(beforeTurn.succeeded, null);

    record.events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } });
    record.status = 'idle';
    const running = await second.waitForWorker({ workerId: 'restored', timeoutMs: 0 });
    assert.equal(running.completed, false);
    assert.equal(running.status, 'running');

    record.events.push({ seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    record.status = 'idle';
    const completed = await second.waitForWorker({ workerId: 'restored', timeoutMs: 0 });
    assert.equal(completed.completed, true);
    assert.equal(completed.succeeded, true);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'prompt').length, 1);
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cold restored worker completes only after its new turn events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-barrier-'));
  const stateFile = join(root, 'workers.json');
  const firstDsh = createFakeDsh();
  const first = createSessionManager({ ...firstDsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    worker = await first.startWorker({ workerId: 'cold-restored', task: 'First task' });
    const record = firstDsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';
  } finally {
    await first.dispose();
  }

  const secondDsh = createFakeDsh();
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  delete secondDsh.sessionController.inspect;
  secondDsh.sessions.get = () => undefined;
  secondDsh.agents.get = () => undefined;
  let cursor = 1;
  let active = false;
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  secondDsh.sessionController.state = async () => ({ cursor, active, running: false, queue: [], pendingInput: [] });
  secondDsh.sessionController.prompt = async (options) => { secondDsh.calls.push(['prompt', options]); };
  secondDsh.sessionQuery = {
    async readSession() { return { session: { id: worker.sessionId, cwd: root }, events: [...events] }; }
  };
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    await second.assignTask({ workerId: 'cold-restored', task: 'Continue after restart' });
    const beforeTurn = await second.waitForWorker({ workerId: 'cold-restored', timeoutMs: 0 });
    assert.equal(beforeTurn.completed, false);
    assert.equal(beforeTurn.status, 'queued');

    cursor = 3;
    active = true;
    events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } });
    events.push({ seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    const completed = await second.waitForWorker({ workerId: 'cold-restored', timeoutMs: 0 });
    assert.equal(completed.completed, true);
    assert.equal(completed.succeeded, true);
    assert.equal(completed.status, 'idle');
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('ready then assign completes on first wait when the cold turn already finished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-first-wait-'));
  const stateFile = join(root, 'workers.json');
  const firstDsh = createFakeDsh();
  const first = createSessionManager({ ...firstDsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    worker = await first.startWorker({ workerId: 'cold-first-wait', task: 'First task' });
    const record = firstDsh.records.get(worker.sessionId);
    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';
  } finally {
    await first.dispose();
  }

  const secondDsh = createFakeDsh();
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  delete secondDsh.sessionController.inspect;
  secondDsh.sessions.get = () => undefined;
  secondDsh.agents.get = () => undefined;
  let cursor = 1;
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  secondDsh.sessionController.state = async () => ({ cursor, active: false, running: false, queue: [], pendingInput: [] });
  secondDsh.sessionController.prompt = async () => {
    // The new turn is admitted and finishes before the first inspect/wait.
    cursor = 3;
    events.push({ seq: 2, type: 'turn/start', data: { turn: 2 } });
    events.push({ seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    secondDsh.calls.push(['prompt']);
  };
  secondDsh.sessionQuery = {
    async readSession() { return { session: { id: worker.sessionId, cwd: root }, events: [...events] }; }
  };
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    await second.assignTask({ workerId: 'cold-first-wait', task: 'Continue immediately' });
    const completed = await second.waitForWorker({ workerId: 'cold-first-wait', timeoutMs: 0 });
    assert.equal(completed.completed, true);
    assert.equal(completed.succeeded, true);
    assert.equal(completed.status, 'idle');
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a manually bound worker also waits for a new turn before reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bound-barrier-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'legacy-session', cwd: root, agentAvailable: false, running: false });
  const record = recordFor('legacy-session');
  dsh.records.set('legacy-session', record);
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    const bound = await manager.bindWorker({ workerId: 'legacy', sessionId: 'legacy-session' });
    assert.equal(bound.taskCount, 0);
    const accepted = await manager.assignTask({ workerId: 'legacy', task: 'Continue legacy' });
    assert.equal(accepted.reused, true, 'a bound existing session is not a first-turn conversation');
    record.status = 'idle';
    const beforeTurn = await manager.waitForWorker({ workerId: 'legacy', timeoutMs: 0 });
    assert.equal(beforeTurn.completed, false);
    assert.equal(beforeTurn.status, 'queued');

    record.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    record.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    record.status = 'idle';
    const completed = await manager.waitForWorker({ workerId: 'legacy', timeoutMs: 0 });
    assert.equal(completed.completed, true);
    assert.equal(completed.succeeded, true);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cold history read failure is explicit and never reported as complete empty history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-failure-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'cold-session', cwd: root, agentAvailable: false, running: false });
  delete dsh.sessionController.inspect;
  dsh.sessionController.state = async () => ({ cursor: 0, active: false, running: false, queue: [], pendingInput: [] });
  dsh.sessionQuery = { async readSession() { throw new Error('history store unavailable'); } };
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.bindWorker({ workerId: 'cold', sessionId: 'cold-session' });
    await assert.rejects(
      manager.getProgress({ workerId: 'cold' }),
      /Could not read DSH session history.*history store unavailable/s
    );
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata persists across restart and archived lifecycle is separate from runtime status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-metadata-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    await manager.ready();
    worker = await manager.startWorker({
      workerId: 'meta', customer: '085', purpose: '插件开发', task: 'First task'
    });
    assert.equal(worker.customer, '085');
    assert.equal(worker.purpose, '插件开发');
    assert.equal(worker.lifecycle, 'active');
    assert.equal(worker.reusable, true);

    const archived = await manager.updateWorkerMetadata({ workerId: 'meta', lifecycle: 'archived' });
    assert.equal(archived.lifecycle, 'archived');
    assert.equal(archived.reusable, false);
    assert.equal((await manager.listWorkers()).length, 0, 'default list excludes archived');
    const archivedRows = await manager.listWorkers({ includeArchived: true });
    assert.equal(archivedRows.length, 1);
    assert.equal(archivedRows[0].customer, '085');

    const promptsBefore = dsh.calls.filter(([name]) => name === 'prompt').length;
    await assert.rejects(
      manager.startWorker({ workerId: 'meta', task: 'Must not start' }),
      /lifecycle="archived".*Restore it first/s
    );
    await assert.rejects(
      manager.assignTask({ workerId: 'meta', task: 'Must not run' }),
      /lifecycle="archived".*Restore it first/s
    );
    assert.equal(dsh.calls.filter(([name]) => name === 'prompt').length, promptsBefore);
  } finally {
    await manager.dispose();
  }

  const secondDsh = createFakeDsh();
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  secondDsh.records.set(worker.sessionId, recordFor(worker.sessionId));
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    assert.equal((await second.listWorkers()).length, 0);
    const [restored] = await second.listWorkers({ includeArchived: true });
    assert.equal(restored.sessionId, worker.sessionId);
    assert.equal(restored.customer, '085');
    assert.equal(restored.purpose, '插件开发');
    assert.equal(restored.lifecycle, 'archived');

    const active = await second.updateWorkerMetadata({ workerId: 'meta', lifecycle: 'active' });
    assert.equal(active.lifecycle, 'active');
    assert.equal((await second.listWorkers()).length, 1);
    const reused = await second.assignTask({ workerId: 'meta', task: 'Continue after restore' });
    assert.equal(reused.sessionId, worker.sessionId);
    assert.equal(secondDsh.calls.filter(([name]) => name === 'prompt').length, 1);
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('lastTask is stored as a 500-code-point summary while the full task is dispatched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-last-task-'));
  const stateFile = join(root, 'workers.json');
  const dsh = createFakeDsh();
  const longTask = '😀'.repeat(501);
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  let worker;
  try {
    worker = await manager.startWorker({ workerId: 'summary', task: longTask });
    assert.equal([...worker.lastTask].length, 500);
    assert.equal(worker.lastTaskTruncated, true);
    assert.ok(dsh.calls.find(([name]) => name === 'prompt')[1].content[0].text.includes(longTask));
    const raw = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(raw.version, 2);
    assert.equal([...raw.workers[0].lastTask].length, 500);
    assert.equal(raw.workers[0].lastTaskTruncated, true);
  } finally {
    await manager.dispose();
  }

  const secondDsh = createFakeDsh();
  secondDsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
  secondDsh.records.set(worker.sessionId, recordFor(worker.sessionId));
  const second = createSessionManager({ ...secondDsh, config: { workspace: root }, stateFile });
  try {
    await second.ready();
    const [restored] = await second.listWorkers();
    assert.equal([...restored.lastTask].length, 500);
    assert.equal(restored.lastTaskTruncated, true);
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid metadata and identity bounds are rejected before creating a DSH session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-metadata-bounds-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile: join(root, 'workers.json') });
  try {
    await manager.ready();
    await assert.rejects(manager.startWorker({ workerId: 'x'.repeat(129), task: 't' }), /workerId must be at most 128/);
    await assert.rejects(manager.startWorker({ workerId: 'bad-role', role: 'r'.repeat(1025), task: 't' }), /role must be at most 1024/);
    await assert.rejects(manager.startWorker({ workerId: 'bad-customer', customer: 'c'.repeat(81), task: 't' }), /customer.*80 Unicode/);
    await assert.rejects(manager.startWorker({ workerId: 'bad-purpose', purpose: 'p'.repeat(201), task: 't' }), /purpose.*200 Unicode/);
    await assert.rejects(manager.startWorker({ workerId: 'bad-control', customer: 'bad\nvalue', task: 't' }), /control characters/);
    await assert.rejects(manager.startWorker({ workerId: 'bad-lifecycle', lifecycle: 'paused', task: 't' }), /lifecycle must be one of/);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 0);
    assert.equal(dsh.calls.filter(([name]) => name === 'prompt').length, 0);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('the record limit counts archived entries, rejects additions, and forget frees one slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-limit-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root, maxWorkers: 2 }, stateFile: join(root, 'workers.json') });
  try {
    await manager.startWorker({ workerId: 'first', task: 'First' });
    const second = await manager.startWorker({ workerId: 'second', task: 'Second' });
    dsh.records.get(second.sessionId).status = 'idle';
    await manager.updateWorkerMetadata({ workerId: 'first', lifecycle: 'archived' });
    await assert.rejects(
      manager.startWorker({ workerId: 'third', task: 'Third' }),
      /limit reached \(2\/2.*hard maximum 200/s
    );
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 2);

    const forgotten = await manager.forgetWorker({ workerId: 'second' });
    assert.equal(forgotten.forgotten, true);
    assert.equal(forgotten.sessionPreserved, true);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 2, 'forget does not create or delete DSH sessions');

    const third = await manager.startWorker({ workerId: 'third', task: 'Third' });
    assert.equal(third.workerId, 'third');
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 3);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('forget rejects running and queued workers, preserves the session, and allows rebinding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-forget-'));
  const dsh = createFakeDsh();
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile: join(root, 'workers.json') });
  try {
    const worker = await manager.startWorker({ workerId: 'busy', task: 'First' });
    const record = dsh.records.get(worker.sessionId);

    record.status = 'running';
    await assert.rejects(manager.forgetWorker({ workerId: 'busy' }), /running.*refusing dsh_forget_worker/s);

    record.status = 'idle';
    record.inbox.nextTurn.push('queued task');
    await assert.rejects(manager.forgetWorker({ workerId: 'busy' }), /queued.*refusing dsh_forget_worker/s);
    record.inbox.nextTurn.length = 0;

    const forgotten = await manager.forgetWorker({ workerId: 'busy' });
    assert.equal(forgotten.forgotten, true);
    assert.equal(forgotten.sessionPreserved, true);
    assert.equal((await manager.listWorkers()).length, 0);
    assert.equal(dsh.calls.filter(([name]) => name === 'cancel').length, 0);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);

    dsh.listRows.push({ sessionId: worker.sessionId, cwd: root, agentAvailable: false, running: false });
    const rebound = await manager.bindWorker({ workerId: 'busy', sessionId: worker.sessionId });
    assert.equal(rebound.sessionId, worker.sessionId);
    assert.equal(dsh.calls.filter(([name]) => name === 'create').length, 1);
    assert.equal(dsh.calls.filter(([name]) => name === 'prompt').length, 1);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('manager rewrites a version 1 registry as version 2 with metadata defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v1-manager-'));
  const stateFile = join(root, 'workers.json');
  const v1 = {
    version: 1,
    workers: [{
      workerId: 'legacy', sessionId: 'session-legacy', role: 'legacy',
      workspaceId: null, cwd: root,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      taskCount: 1, lastTask: 'x'.repeat(501)
    }]
  };
  await writeFile(stateFile, JSON.stringify(v1), 'utf8');
  const dsh = createFakeDsh();
  dsh.listRows.push({ sessionId: 'session-legacy', cwd: root, agentAvailable: false, running: false });
  const manager = createSessionManager({ ...dsh, config: { workspace: root }, stateFile });
  try {
    await manager.ready();
    const raw = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(raw.version, 2);
    assert.equal(raw.workers[0].lifecycle, 'active');
    assert.equal(raw.workers[0].customer, null);
    assert.equal(raw.workers[0].purpose, null);
    assert.equal(raw.workers[0].lastTaskTruncated, true);
    const [listed] = await manager.listWorkers();
    assert.equal(listed.workerId, 'legacy');
    assert.equal(listed.lifecycle, 'active');
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
