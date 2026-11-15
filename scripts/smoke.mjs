import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOOL_NAMES = [
  'dsh_start_worker', 'dsh_assign_task', 'dsh_list_workers',
  'dsh_get_progress', 'dsh_wait_worker', 'dsh_cancel_worker'
];
const MAX_RUN_MS = 120000;
const PAGE_LIMIT = 100;
const token = process.env.CODEX_DSH_MCP_TOKEN;
const startedAt = performance.now();
const runController = new AbortController();
const elapsed = () => Math.round(performance.now() - startedAt);
const remaining = () => Math.max(0, MAX_RUN_MS - elapsed());

function safeText(value) {
  let text = String(value);
  if (token) text = text.split(token).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}

function emit(type, detail = {}) {
  process.stdout.write(`${JSON.stringify({ type, elapsedMs: elapsed(), ...detail }, (_key, value) => typeof value === 'string' ? safeText(value) : value)}\n`);
}

function parseEndpoint(args) {
  let endpoint = 'http://127.0.0.1:59873/mcp';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return null;
    if (argument === '--endpoint') {
      endpoint = args[++index];
      if (!endpoint) throw new Error('--endpoint requires a URL.');
    } else if (argument.startsWith('--endpoint=')) endpoint = argument.slice('--endpoint='.length);
    else throw new Error(`Unknown argument ${argument}. Use --endpoint URL.`);
  }
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The endpoint must be an HTTP(S) URL without credentials, a query, or a fragment.');
  }
  return url;
}

function requestOptions(maximumMs = 15000) {
  runController.signal.throwIfAborted();
  const timeout = Math.min(maximumMs, remaining());
  if (timeout < 1) throw new Error('The 120-second smoke-test budget has expired; the resident worker has not been cancelled.');
  return { timeout, maxTotalTimeout: timeout, signal: runController.signal };
}

function decodeToolResult(name, result) {
  if (result.isError) {
    const detail = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    throw new Error(`${name} failed: ${safeText(detail || 'tool returned isError')}`);
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  try { return JSON.parse(text); }
  catch { throw new Error(`${name} returned no usable JSON object.`); }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, requestOptions());
  const data = decodeToolResult(name, result);
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), `${name} must return a structured object.`);
  return data;
}

function extractReply(messages, marker) {
  // Only assistant events are inspected, so instructions quoted in user/message cannot satisfy the check.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index];
    const offset = text.lastIndexOf(marker);
    if (offset < 0) continue;
    const match = text.slice(offset + marker.length).match(/\{[^\r\n]*\}/);
    if (!match) continue;
    try { return JSON.parse(match[0]); }
    catch { /* A later complete assistant reply may contain the final JSON. */ }
  }
  throw new Error(`The completed worker did not return a valid one-line ${marker} JSON report. Inspect its visible DSH session.`);
}

async function observe(client, { phase, workerId, sessionId, sinceSeq = -1 }) {
  let cursor = sinceSeq;
  let drainPage = false;
  let turnsEnded = 0;
  let toolCalls = 0;
  const requiredReadPaths = phase === 'initial' ? ['package.json', 'lib/tools.js'] : ['README.md'];
  const observedReadPaths = new Set();
  const assistantMessages = [];
  while (true) {
    requestOptions();
    const name = drainPage ? 'dsh_get_progress' : 'dsh_wait_worker';
    const args = { workerId, sinceSeq: cursor, limit: PAGE_LIMIT };
    if (!drainPage) args.timeoutMs = Math.min(10000, Math.max(0, remaining() - 1000));
    const progress = await call(client, name, args);
    assert.equal(progress.sessionId, sessionId, `${phase}: the visible DSH session changed unexpectedly.`);
    assert.ok(Array.isArray(progress.events), `${phase}: progress.events must be an array.`);
    assert.ok(progress.events.length <= PAGE_LIMIT, `${phase}: event page exceeded the requested limit.`);
    let pageCursor = cursor;
    for (const event of progress.events) {
      assert.ok(Number.isSafeInteger(event.seq) && event.seq > pageCursor, `${phase}: events were duplicated or not ordered by seq.`);
      pageCursor = event.seq;
      if (event.type === 'assistant/message') assistantMessages.push(String(event.text ?? ''));
      if (event.type === 'turn/end') turnsEnded += 1;
      const text = String(event.text ?? '');
      const markerOffset = text.indexOf('[工具调用]');
      if (event.type === 'tool/call' || (event.type === 'assistant/message' && markerOffset >= 0)) {
        toolCalls += 1;
        // Inspect invocation arguments, not tool results or ordinary assistant claims of having read a file.
        const invocation = (event.type === 'tool/call' ? text : text.slice(markerOffset)).replace(/\\+/g, '/').toLowerCase();
        for (const path of requiredReadPaths) {
          if (invocation.includes(path.toLowerCase())) observedReadPaths.add(path);
        }
      }
    }
    assert.equal(progress.nextSeq, pageCursor, `${phase}: nextSeq skipped events or regressed.`);
    assert.equal(typeof progress.hasMore, 'boolean', `${phase}: hasMore must be a boolean.`);
    if (progress.hasMore) assert.ok(pageCursor > cursor, `${phase}: a page with hasMore did not advance the cursor.`);
    cursor = pageCursor;
    emit('progress', {
      phase, workerId, sessionId, status: progress.status,
      nextSeq: cursor, latestSeq: progress.latestSeq, hasMore: progress.hasMore,
      toolCallsObserved: toolCalls, readPathsObserved: [...observedReadPaths],
      events: progress.events.map((event) => ({ seq: event.seq, type: event.type, truncated: Boolean(event.truncated) })),
      ...(progress.transientProgress ? { stream: {
        attemptId: progress.transientProgress.attemptId,
        revision: progress.transientProgress.revision,
        lastChunkIndex: progress.transientProgress.lastChunkIndex,
        textLength: String(progress.transientProgress.text ?? '').length,
        truncated: Boolean(progress.transientProgress.truncated)
      } } : {})
    });
    if (progress.error || ['failed', 'error', 'cancelled', 'canceled', 'sleeping'].includes(progress.status)) {
      throw new Error(`${phase}: worker status ${progress.status}${progress.error ? `: ${safeText(progress.error)}` : ''}. The worker was left resident.`);
    }
    drainPage = progress.hasMore;
    if (drainPage) continue;
    if (progress.status === 'idle') {
      assert.ok(turnsEnded > 0, `${phase}: idle was reported without observing a completed turn.`);
      assert.ok(assistantMessages.length > 0, `${phase}: no durable assistant reply was observed.`);
      assert.ok(toolCalls > 0, `${phase}: no real tool/call event or rendered assistant tool-call block was observed; a plausible answer alone cannot pass.`);
      for (const path of requiredReadPaths) {
        assert.ok(observedReadPaths.has(path), `${phase}: no observed tool invocation referenced required file ${path}; a model claim of reading it is insufficient.`);
      }
      return { cursor, assistantMessages };
    }
    if (progress.completed === true && progress.succeeded !== true) throw new Error(`${phase}: worker completed without success.`);
  }
}

async function boundedCleanup(action, label) {
  let timer;
  try {
    await Promise.race([
      action(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 5000); })
    ]);
  } finally { clearTimeout(timer); }
}

const READ_ONLY_RULES = [
  '这是只读桌面端联调，目标是实际读取文件并准确回答，不做任何编码或修复。先阅读工作区 AGENTS.md 并遵守适用约定。',
  '禁止创建、修改、删除任何文件（包括计划、日志、笔记、测试文件），禁止安装依赖、联网和 git 写操作。',
  '不要读取或输出环境变量、密钥、凭据、用户配置或 DSH 模型设置。仅使用只读工具访问本任务指定的项目文件。',
  '不要把未执行的检查标为成功；若无法读取指定文件，明确报告阻塞。完成回复后保持当前会话待命。'
].join('\n');

async function main() {
  const endpoint = parseEndpoint(process.argv.slice(2));
  if (!endpoint) {
    process.stdout.write('Usage: node scripts/smoke.mjs [--endpoint http://127.0.0.1:59873/mcp]\nOptional bearer token: CODEX_DSH_MCP_TOKEN\n');
    return;
  }
  const client = new Client({ name: 'codex-dsh-desktop-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
  const workerId = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const interrupt = () => runController.abort(new Error('Smoke observation interrupted; the resident worker has not been cancelled.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let failure;
  try {
    emit('connecting', { endpoint: `${endpoint.origin}${endpoint.pathname}` });
    await client.connect(transport, requestOptions());
    const names = [];
    let cursor;
    do {
      const listing = await client.listTools(cursor ? { cursor } : {}, requestOptions());
      names.push(...listing.tools.map((tool) => tool.name));
      cursor = listing.nextCursor;
      assert.ok(names.length <= 500, 'Unexpectedly large or cyclic MCP tool listing.');
    } while (cursor);
    for (const name of TOOL_NAMES) assert.ok(names.includes(name), `Missing MCP tool ${name}.`);
    emit('connected', { tools: names });

    const started = await call(client, 'dsh_start_worker', {
      workerId,
      role: '只读端到端联调',
      task: [READ_ONLY_RULES,
        '请实际读取 package.json 和 lib/tools.js：从前者获取 package 的 name，从后者数出 createTools() 暴露的 MCP 工具定义数量。不要凭已有上下文猜测。',
        '最后用一行严格 JSON 回复，格式为：DSH_SMOKE_RESULT {"packageName":"从文件读取的名称","toolCount":工具数量整数}。只输出这份结果，不要复制文件正文。'
      ].join('\n\n')
    });
    assert.equal(started.workerId, workerId);
    assert.ok(typeof started.sessionId === 'string' && started.sessionId.length > 0, 'Start returned no DSH session ID.');
    assert.equal(started.accepted, true, 'The first task was not accepted.');
    const sessionId = started.sessionId;
    emit('worker-started', { workerId, sessionId, status: started.status });
    const first = await observe(client, { phase: 'initial', workerId, sessionId });
    const report = extractReply(first.assistantMessages, 'DSH_SMOKE_RESULT');
    assert.equal(report.packageName, 'codex-dsh-desktop', 'The worker reported an unexpected package name.');
    assert.equal(report.toolCount, TOOL_NAMES.length, 'The worker reported an unexpected tool count.');
    emit('initial-verified', { workerId, sessionId, report });

    const assigned = await call(client, 'dsh_assign_task', {
      workerId,
      mode: 'queue',
      task: [READ_ONLY_RULES,
        '这是同一个驻留 worker 的第二项任务。保持在当前会话，实际读取 README.md，从中查明项目包名，以及驻留复用在 DSH 应用运行期和退出或重启后的限制。',
        '最后用一行严格 JSON 回复，格式为：DSH_REUSE_RESULT {"packageName":"文档中的项目包名","reuseLimit":"用中文简述仅当前应用运行期驻留、退出或重启后不保证同一 worker 恢复"}。根据实际文档回答，不要复制文件正文。'
      ].join('\n\n')
    });
    assert.equal(assigned.sessionId, sessionId, 'Reassignment created a different DSH session.');
    assert.equal(assigned.reused, true, 'Reassignment was not marked as resident reuse.');
    assert.equal(assigned.accepted, true, 'The reuse task was not accepted.');
    assert.ok(assigned.taskCount >= 2, 'Resident task count did not advance.');
    emit('worker-reused', { workerId, sessionId, taskCount: assigned.taskCount });
    const second = await observe(client, { phase: 'reuse', workerId, sessionId, sinceSeq: first.cursor });
    const reuseReport = extractReply(second.assistantMessages, 'DSH_REUSE_RESULT');
    assert.equal(reuseReport.packageName, 'codex-dsh-desktop', 'README package name was unexpected.');
    assert.ok(typeof reuseReport.reuseLimit === 'string' && /应用|app/i.test(reuseReport.reuseLimit) && /运行|周期|重启|退出/.test(reuseReport.reuseLimit), 'The reuse report omitted the application lifetime limit.');
    emit('smoke-passed', { workerId, sessionId, sameSession: true, finalSeq: second.cursor, report: reuseReport, workerLeftResident: true });
  } catch (error) {
    failure = error;
    emit('smoke-failed', { workerId, error: safeText(error instanceof Error ? error.message : error), workerLeftResident: true });
  } finally {
    if (transport.sessionId) {
      try { await boundedCleanup(() => transport.terminateSession(), 'MCP session termination'); }
      catch (error) { emit('cleanup-failed', { operation: 'terminateSession', error: safeText(error.message) }); failure ??= error; }
    }
    try { await boundedCleanup(() => client.close(), 'MCP client close'); }
    catch (error) { emit('cleanup-failed', { operation: 'close', error: safeText(error.message) }); failure ??= error; }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    emit('disconnected', { workerId, workerCancelled: false });
  }
  if (failure) process.exitCode = 1;
}

main().catch((error) => {
  emit('smoke-failed', { error: safeText(error instanceof Error ? error.message : error) });
  process.exitCode = 1;
});
