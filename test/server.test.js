import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../lib/server.js';

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });

function request(url, { method = 'POST', headers: customHeaders, body = method === 'POST' ? initialize : undefined } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { ...headers, ...customHeaders } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function connect(bridge) {
  const address = await bridge.start();
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, url };
}

test('serves tools over isolated stateful MCP sessions and checks bearer auth', async () => {
  const bridge = createMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    token: 'integration-secret',
    serverName: 'codex-dsh-desktop',
    tools: [{
      name: 'echo',
      description: 'Echo an input value.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      handler: async ({ value }) => ({ value })
    }]
  });

  let firstClient;
  let secondClient;
  let firstTransport;
  try {
    const address = await bridge.start();
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const transportFor = () => new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer integration-secret' } }
    });
    firstClient = new Client({ name: 'test-client-one', version: '1.0.0' });
    secondClient = new Client({ name: 'test-client-two', version: '1.0.0' });
    firstTransport = transportFor();
    await firstClient.connect(firstTransport);
    await secondClient.connect(transportFor());

    const tools = await firstClient.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['echo']);
    const [firstResult, secondResult] = await Promise.all([
      firstClient.callTool({ name: 'echo', arguments: { value: 'first' } }),
      secondClient.callTool({ name: 'echo', arguments: { value: 'second' } })
    ]);
    assert.deepEqual(firstResult.structuredContent, { value: 'first' });
    assert.deepEqual(secondResult.structuredContent, { value: 'second' });
    assert.equal(bridge.sessionCount, 2);

    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bad', version: '1' } } })
    });
    assert.equal(denied.status, 401);
    await firstTransport.terminateSession();
    assert.equal(bridge.sessionCount, 1);
    assert.deepEqual((await secondClient.callTool({ name: 'echo', arguments: { value: 'still alive' } })).structuredContent, { value: 'still alive' });
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await bridge.close();
  }
});

test('only binds to loopback interfaces, including when authentication is disabled', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.2', 'example.com']) {
    assert.throws(() => createMcpHttpServer({ host, port: 0 }), /loopback/i);
  }
});

test('rejects rebinding Host and cross-origin requests before allocating a session', async () => {
  const bridge = createMcpHttpServer({ port: 0 });
  try {
    const address = await bridge.start();
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    for (const customHeaders of [
      { Host: `attacker.example:${address.port}` },
      { Host: '127.0.0.1:1' },
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { Origin: 'http://127.0.0.1:1' }
    ]) {
      assert.equal((await request(url, { headers: customHeaders })).status, 403);
      assert.equal(bridge.sessionCount, 0);
    }
    const accepted = await request(url, { headers: { Origin: url.origin } });
    assert.equal(accepted.status, 200);
    assert.equal(bridge.sessionCount, 1);
  } finally { await bridge.close(); }
});

test('concurrent starts share one listen operation and can close during startup', async () => {
  const bridge = createMcpHttpServer({ port: 0 });
  try {
    const [first, second] = await Promise.all([bridge.start(), bridge.start()]);
    assert.ok(first?.port > 0);
    assert.deepEqual(second, first);
  } finally { await bridge.close(); }

  const closing = createMcpHttpServer({ port: 0 });
  const starting = closing.start();
  await closing.close();
  const oldAddress = await starting;
  await assert.rejects(fetch(`http://127.0.0.1:${oldAddress.port}/mcp`));
  const newAddress = await closing.start();
  assert.ok(newAddress.port > 0);
  await closing.close();
});

test('a failed listen is retryable after the conflicting listener closes', async () => {
  const occupied = createMcpHttpServer({ port: 0 });
  const address = await occupied.start();
  const bridge = createMcpHttpServer({ port: address.port });
  try {
    await assert.rejects(bridge.start(), { code: 'EADDRINUSE' });
    await occupied.close();
    assert.equal((await bridge.start()).port, address.port);
    const shuttingDown = bridge.close();
    const { start } = bridge;
    const restarting = start();
    await shuttingDown;
    assert.equal((await restarting).port, address.port);
  } finally {
    await bridge.close();
    await occupied.close();
  }
});

test('returns actionable protocol errors and limits bodies without leaking sessions', async () => {
  const bridge = createMcpHttpServer({ port: 0, maxRequestBodySize: 512 });
  try {
    const address = await bridge.start();
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    assert.equal((await request(url, { body: '{broken' })).status, 400);
    assert.equal((await request(url, { body: 'x'.repeat(513) })).status, 413);
    assert.equal((await request(url, { headers: { 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(513) })).status, 413);
    assert.equal((await request(url, { method: 'PUT' })).status, 405);
    assert.equal((await request(url, { method: 'GET', body: undefined })).status, 400);
    assert.equal((await request(url, { headers: { 'mcp-session-id': 'missing-session' } })).status, 404);
    assert.equal(bridge.sessionCount, 0);
    assert.equal((await request(url)).status, 200);
    assert.equal(bridge.sessionCount, 1);
  } finally { await bridge.close(); }
});

test('failed initialization releases its session instead of consuming client capacity', async () => {
  const bridge = createMcpHttpServer({ port: 0, maxSessions: 1 });
  try {
    const address = await bridge.start();
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const failed = await request(url, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    assert.match(failed.text, /error/);
    assert.equal(bridge.sessionCount, 0);
    assert.equal((await request(url)).status, 200);
  } finally { await bridge.close(); }
});

test('caps client sessions and releases capacity after explicit termination', async () => {
  const bridge = createMcpHttpServer({ port: 0, maxSessions: 1 });
  let first;
  try {
    first = await connect(bridge);
    assert.equal((await request(first.url)).status, 429);
    await first.transport.terminateSession();
    assert.equal(bridge.sessionCount, 0);
    assert.equal((await request(first.url)).status, 200);
  } finally {
    await first?.client.close();
    await bridge.close();
  }
});

test('reclaims an idle protocol session after an ordinary client disconnect', async () => {
  const bridge = createMcpHttpServer({ port: 0, maxSessions: 1, sessionIdleMs: 0 });
  let first;
  let second;
  try {
    first = await connect(bridge);
    await first.client.close();
    second = await connect(bridge);
    assert.equal(bridge.sessionCount, 1);
  } finally {
    await first?.client.close();
    await second?.client.close();
    await bridge.close();
  }
});

test('reclaims an ordinary disconnected session without waiting for a new connection', async () => {
  const bridge = createMcpHttpServer({ port: 0, maxSessions: 1, sessionIdleMs: 20 });
  let first;
  try {
    first = await connect(bridge);
    await first.client.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(bridge.sessionCount, 0);
  } finally {
    await first?.client.close();
    await bridge.close();
  }
});

test('passes cancellation to tool handlers while preserving resident MCP sessions', async () => {
  let started;
  let cancelled;
  const begun = new Promise((resolve) => { started = resolve; });
  const aborted = new Promise((resolve) => { cancelled = resolve; });
  const bridge = createMcpHttpServer({
    port: 0,
    tools: [{
      name: 'wait',
      inputSchema: { type: 'object' },
      handler: async (_args, context) => {
        started(context);
        await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        cancelled();
        return { done: true };
      }
    }]
  });
  let connection;
  try {
    connection = await connect(bridge);
    const controller = new AbortController();
    const result = connection.client.callTool({ name: 'wait' }, undefined, { signal: controller.signal });
    const rejection = assert.rejects(result);
    const context = await begun;
    assert.ok(context?.signal instanceof AbortSignal);
    controller.abort();
    await rejection;
    await aborted;
    assert.equal(bridge.sessionCount, 1);
    assert.equal((await connection.client.listTools()).tools.length, 1);
  } finally {
    await connection?.client.close();
    await bridge.close();
  }
});

test('close aborts in-flight tool waits and destroys requests still uploading initialization', async () => {
  let started;
  let wasAborted;
  const begun = new Promise((resolve) => { started = resolve; });
  const aborted = new Promise((resolve) => { wasAborted = resolve; });
  const bridge = createMcpHttpServer({
    port: 0,
    maxSessions: 2,
    tools: [{ name: 'wait', inputSchema: { type: 'object' }, handler: async (_args, { signal }) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      wasAborted();
      return {};
    } }]
  });
  let connection;
  let upload;
  try {
    connection = await connect(bridge);
    const result = connection.client.callTool({ name: 'wait' });
    const rejection = assert.rejects(result);
    await begun;
    upload = httpRequest(connection.url, { method: 'POST', headers });
    upload.on('error', () => {});
    upload.write('{');
    const [socket] = await once(upload, 'socket');
    if (socket.connecting) await once(socket, 'connect');
    assert.equal((await request(connection.url)).status, 429);
    await bridge.close();
    await aborted;
    await connection.client.close();
    await rejection;
    assert.equal(bridge.sessionCount, 0);
  } finally {
    upload?.destroy();
    await connection?.client.close();
    await bridge.close();
  }
});
