import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isAuthorized } from './token.js';
import { validateToolArguments } from './tools.js';

function sendError(response, statusCode, message, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

function isLoopback(host) {
  if (typeof host !== 'string') return false;
  if (host.startsWith('::ffff:')) host = host.slice(7);
  return host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function toolResult(value) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent
  };
}

export function createMcpHttpServer({
  host = '127.0.0.1',
  port = 59873,
  path = '/mcp',
  token,
  serverName = 'codex-dsh-desktop',
  version = '1.0.0',
  instructions,
  tools = [],
  maxRequestBodySize = 1024 * 1024,
  maxSessions = 64,
  sessionIdleMs = 5 * 60 * 1000,
  logger = console
}) {
  if (host !== 'localhost' && !isLoopback(host)) throw new Error('The MCP bridge must bind to a loopback address.');
  if (!Number.isInteger(maxRequestBodySize) || maxRequestBodySize < 1) throw new RangeError('maxRequestBodySize must be a positive integer.');
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError('maxSessions must be a positive integer.');
  if (!Number.isInteger(sessionIdleMs) || sessionIdleMs < 0) throw new RangeError('sessionIdleMs must be a non-negative integer.');
  if (token !== undefined && token !== null && typeof token !== 'string') throw new TypeError('token must be a string.');
  const sessions = new Map();
  // Track transports before initialize completes so close() also owns slow uploads.
  const entries = new Set();
  let httpServer;
  let startPromise;
  let closePromise;
  let closing = false;
  let reaperTimer;

  function validateLocalRequest(request) {
    if (!isLoopback(request.socket.remoteAddress)) return false;
    const address = httpServer?.address();
    if (!address || typeof address === 'string') return false;
    const names = new Set(['127.0.0.1', 'localhost', '[::1]', host, address.address]);
    const validAuthority = (url) => names.has(url.hostname) && Number(url.port || 80) === address.port;
    try {
      const hostHeader = request.headers.host;
      if (typeof hostHeader !== 'string') return false;
      const hostUrl = new URL(`http://${hostHeader}`);
      if (hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash || !validAuthority(hostUrl)) return false;
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== 'string') return false;
        const originUrl = new URL(origin);
        if (originUrl.protocol !== 'http:' || originUrl.origin !== origin || !validAuthority(originUrl)) return false;
      }
      return true;
    } catch { return false; }
  }

  async function closeEntry(entry) {
    try { await entry.server.close(); }
    finally {
      entries.delete(entry);
      if (entry.sessionId) sessions.delete(entry.sessionId);
    }
  }

  function createProtocolSession() {
    const server = new Server({ name: serverName, version }, { capabilities: { tools: {} }, instructions });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ handler, ...definition }) => definition)
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
      const tool = byName.get(request.params.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${request.params.name}".` }] };
      try {
        const args = request.params.arguments ?? {};
        validateToolArguments(tool, args);
        context.signal.throwIfAborted();
        return toolResult(await tool.handler(args, context));
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    });

    const entry = { server, transport: null, sessionId: null, activeRequests: 0, lastActivity: Date.now() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize,
      onsessioninitialized: (sessionId) => {
        entry.sessionId = sessionId;
        sessions.set(sessionId, entry);
      },
      onsessionclosed: (sessionId) => sessions.delete(sessionId)
    });
    entry.transport = transport;
    transport.onclose = () => {
      entries.delete(entry);
      if (entry.sessionId) sessions.delete(entry.sessionId);
    };
    entries.add(entry);
    return entry;
  }

  async function reclaimIdleSession() {
    const cutoff = Date.now() - sessionIdleMs;
    const idle = [...entries]
      .filter((entry) => entry.sessionId && entry.activeRequests === 0 && entry.lastActivity <= cutoff)
      .sort((left, right) => left.lastActivity - right.lastActivity)[0];
    if (idle) await closeEntry(idle).catch(() => undefined);
  }

  function startIdleReaper() {
    // A zero idle window is used by callers that want reclamation on the next
    // admission check; a timer would race the initialize notification itself.
    if (reaperTimer || sessionIdleMs <= 0) return;
    const interval = Math.min(Math.max(sessionIdleMs, 10), 60_000);
    reaperTimer = setInterval(() => {
      if (!closing) void reclaimIdleSession();
    }, interval);
    reaperTimer.unref?.();
  }

  function stopIdleReaper() {
    if (!reaperTimer) return;
    clearInterval(reaperTimer);
    reaperTimer = undefined;
  }

  async function handleRequest(request, response) {
    if (closing) return sendError(response, 503, 'The MCP bridge is shutting down. Reconnect after it restarts.');
    if (!validateLocalRequest(request)) return sendError(response, 403, 'Only requests using this bridge loopback Host and Origin are allowed.');
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { return sendError(response, 400, 'Invalid request URL.'); }
    if (pathname !== path) return sendError(response, 404, 'Not found.');
    if (!isAuthorized(request.headers.authorization, token)) return sendError(response, 401, 'Invalid or missing bearer token.');
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      return sendError(response, 405, 'Method not allowed.', { Allow: 'GET, POST, DELETE' });
    }

    const rawSessionId = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    let entry;
    if (sessionId) {
      entry = sessions.get(sessionId);
      if (!entry) return sendError(response, 404, 'MCP session not found. Reconnect to initialize a new session.');
    } else if (request.method === 'POST') {
      if (entries.size >= maxSessions) await reclaimIdleSession();
      if (entries.size >= maxSessions) return sendError(response, 429, 'Too many MCP sessions. Terminate an unused session before reconnecting.', { 'Retry-After': '1' });
      entry = createProtocolSession();
      try { await entry.server.connect(entry.transport); }
      catch (error) {
        await closeEntry(entry).catch(() => undefined);
        logger.error?.('Unable to initialize MCP transport', error);
        return sendError(response, 500, 'Unable to initialize MCP transport. Check the DSH plugin log for details.');
      }
    } else {
      return sendError(response, 400, 'This request requires an MCP session ID.');
    }

    entry.activeRequests += 1;
    entry.lastActivity = Date.now();
    try {
      await entry.transport.handleRequest(request, response);
      if (!entry.sessionId) await closeEntry(entry);
    } catch (error) {
      logger.error?.('MCP request failed', error);
      await closeEntry(entry).catch(() => undefined);
      sendError(response, 500, 'MCP request failed. Check the DSH plugin log for details.');
    } finally {
      entry.activeRequests = Math.max(0, entry.activeRequests - 1);
      entry.lastActivity = Date.now();
    }
  }

  const bridge = {
    get sessionCount() { return sessions.size; },
    start() {
      if (closePromise) return closePromise.then(() => bridge.start());
      if (startPromise) return startPromise;
      if (httpServer?.listening) return Promise.resolve(httpServer.address());
      closing = false;
      const listener = createHttpServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          logger.error?.('Unexpected MCP request failure', error);
          sendError(response, 500, 'MCP request failed. Check the DSH plugin log for details.');
        });
      });
      httpServer = listener;
      listener.requestTimeout = 30_000;
      listener.headersTimeout = 10_000;
      startPromise = new Promise((resolve, reject) => {
        const onError = (error) => {
          if (httpServer === listener) httpServer = undefined;
          reject(error);
        };
        listener.once('error', onError);
        listener.listen(port, host, () => {
          listener.removeListener('error', onError);
          listener.on('error', (error) => logger.error?.('MCP HTTP server failed', error));
          startIdleReaper();
          resolve(listener.address());
        });
      }).finally(() => { startPromise = undefined; });
      return startPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      stopIdleReaper();
      closePromise = (async () => {
        await startPromise?.catch(() => undefined);
        const listener = httpServer;
        await Promise.all([...entries].map((entry) => closeEntry(entry).catch(() => undefined)));
        sessions.clear();
        if (listener?.listening) {
          await new Promise((resolve, reject) => {
            listener.close((error) => error ? reject(error) : resolve());
            // Transports have ended their streams; release slow uploads and idle sockets.
            listener.closeAllConnections();
          });
        }
        if (httpServer === listener) httpServer = undefined;
      })().finally(() => { closePromise = undefined; });
      return closePromise;
    }
  };
  return bridge;
}
