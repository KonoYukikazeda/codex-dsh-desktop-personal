import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { apply } from '../index.js';

test('plugin owns its server on the injected fiber and reuses workers across MCP clients', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-'));
  const records = new Map();
  const listeners = new Map();
  const prompts = [];
  let cleanup;
  let ready;
  let startupFailed;
  const started = new Promise((resolve, reject) => { ready = resolve; startupFailed = reject; });
  const injected = {
    logger: () => ({ info: (message) => ready(message.match(/http:\/\/\S+/)[0]), error: startupFailed }),
    workspaceRegistry: { create: async (path) => ({ id: 'workspace', path }) },
    sessions: { get: (id) => records.get(id) },
    agents: { get: (id) => records.get(id) },
    sessionController: {
      async create(options) {
        assert.deepEqual(options, { workspaceId: 'workspace' });
        const record = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, events: [] };
        record.snapshotEvents = (from = 0) => record.events.filter((event) => event.seq >= from);
        records.set('desktop-session', record);
        return { sessionId: 'desktop-session' };
      },
      async selectModel() {},
      async prompt(request, signal) {
        signal.throwIfAborted();
        prompts.push(request);
        const events = records.get(request.sessionId).events;
        events.push({ seq: events.length, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } });
      }
    },
    on: (name, listener) => listeners.set(name, listener),
    effect: (execute) => { cleanup = execute(); }
  };
  const outer = {
    inject(dependencies, callback) {
      assert.ok(dependencies.includes('workspaceRegistry'));
      callback(injected);
    },
    effect() { throw new Error('Resources must belong to the injected fiber.'); }
  };
  const clients = [];
  try {
    apply(outer, { workspace: root, port: 0, stateFile: join(root, 'workers.json') });
    const endpoint = await started;
    assert.equal(typeof cleanup, 'function');
    assert.ok(listeners.has('agent/error'));
    assert.ok(listeners.has('agent/assistant-stream'));
    async function connect() {
      const client = new Client({ name: 'integration-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
      clients.push(client);
      return client;
    }
    const firstClient = await connect();
    assert.match(firstClient.getInstructions(), /复核关键结果/);
    assert.match(firstClient.getInstructions(), /同一 workerId/);
    assert.equal((await firstClient.listTools()).tools.length, 9);
    const first = (await firstClient.callTool({ name: 'dsh_start_worker', arguments: { workerId: 'api', task: 'First task' } })).structuredContent;
    await firstClient.close();
    await writeFile(join(root, 'new.txt'), 'changed');
    const nextClient = await connect();
    const second = (await nextClient.callTool({ name: 'dsh_start_worker', arguments: { workerId: 'api', task: 'Continue' } })).structuredContent;
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.taskCount, 2);
    assert.equal(prompts[1].content.map((block) => block.text).join('\n'), '[GPT]:\nContinue');
    assert.doesNotMatch(prompts[1].content.map((block) => block.text).join('\n'), /new\.txt|自本 worker/);
    assert.equal(prompts.length, 2);
    const progress = (await nextClient.callTool({ name: 'dsh_wait_worker', arguments: { workerId: 'api', timeoutMs: 0 } })).structuredContent;
    assert.equal(progress.succeeded, true);
    assert.equal(progress.handoff.awaitingReview, true);
    assert.equal(progress.handoff.sessionId, first.sessionId);
    assert.deepEqual(progress.events.map((event) => event.seq), [0, 1]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await cleanup?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('a disposed and restarted bridge restores the same worker over the real MCP protocol', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
  const stateFile = join(root, 'state', 'workers.json');
  const clients = [];

  function host({ listRows = [], prompts = [], creates = [] }) {
    let cleanup;
    let ready;
    let failed;
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const injected = {
      profileContext: { dir: root },
      logger: () => ({ info: (message) => ready(message.match(/http:\/\/\S+/)[0]), error: failed }),
      workspaceRegistry: { create: async (path) => ({ id: 'workspace', path }), get: () => undefined, resolveByPath: async (path) => ({ id: 'workspace', path }) },
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      sessionController: {
        async create(options) { creates.push(options); return { sessionId: 'created-session' }; },
        async list() { return { items: listRows }; },
        async inspect() { return { events: [] }; },
        async selectModel() {},
        async prompt(request, signal) { signal.throwIfAborted(); prompts.push(request); },
        async cancel() {}
      },
      on() {},
      effect(execute) { cleanup = execute(); }
    };
    const outer = {
      inject(dependencies, callback) { assert.ok(dependencies.includes('profileContext')); callback(injected); },
      effect() { throw new Error('Resources must belong to the injected fiber.'); }
    };
    apply(outer, { workspace: root, port: 0, stateFile });
    return { started, clients, get cleanup() { return cleanup; }, prompts, creates };
  }

  async function connect(endpoint) {
    const client = new Client({ name: 'restart-integration', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    clients.push(client);
    return client;
  }

  let activeCleanup;
  try {
    const firstHost = host({});
    activeCleanup = firstHost.cleanup;
    const firstClient = await connect(await firstHost.started);
    const first = (await firstClient.callTool({ name: 'dsh_start_worker', arguments: { workerId: 'api', task: 'First task' } })).structuredContent;
    assert.equal(first.sessionId, 'created-session');
    await firstClient.close();
    await firstHost.cleanup();
    activeCleanup = undefined;

    const secondPrompts = [];
    const secondCreates = [];
    const secondHost = host({
      listRows: [
        { sessionId: first.sessionId, cwd: root, agentAvailable: false, running: false },
        { sessionId: 'legacy-session', cwd: root, agentAvailable: false, running: false }
      ],
      prompts: secondPrompts,
      creates: secondCreates
    });
    activeCleanup = secondHost.cleanup;
    const secondClient = await connect(await secondHost.started);
    assert.equal((await secondClient.listTools()).tools.length, 9);
    assert.match(secondClient.getInstructions(), /dsh_bind_worker/);
    const listed = (await secondClient.callTool({ name: 'dsh_list_workers', arguments: {} })).structuredContent.result;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, first.sessionId);
    assert.equal(listed[0].restored, true);
    const reused = (await secondClient.callTool({ name: 'dsh_assign_task', arguments: { workerId: 'api', task: 'Continue after restart' } })).structuredContent;
    assert.equal(reused.sessionId, first.sessionId);
    assert.equal(secondCreates.length, 0);
    assert.equal(secondPrompts.length, 1);
    assert.equal(secondPrompts[0].sessionId, first.sessionId);
    assert.equal(secondPrompts[0].content.map((block) => block.text).join('\n'), '[GPT]:\nContinue after restart');

    const bound = (await secondClient.callTool({ name: 'dsh_bind_worker', arguments: { workerId: 'quote_demo', sessionId: 'legacy-session', role: 'legacy' } })).structuredContent;
    assert.equal(bound.bound, true);
    assert.equal(bound.sessionId, 'legacy-session');
    assert.equal(secondPrompts.length, 1, 'binding never sends a task');
    const afterBind = (await secondClient.callTool({ name: 'dsh_list_workers', arguments: {} })).structuredContent.result;
    assert.deepEqual(afterBind.map((worker) => worker.workerId).sort(), ['api', 'quote_demo']);
    await secondClient.close();
    await secondHost.cleanup();
    activeCleanup = undefined;
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await activeCleanup?.().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
