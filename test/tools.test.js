import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools, validateToolArguments } from '../lib/tools.js';

function tool(name, manager = {}) {
  return createTools(manager).find((current) => current.name === name);
}

test('bind exposes workerId/sessionId/role and forwards without a task', async () => {
  const calls = [];
  const bind = tool('dsh_bind_worker', { bindWorker: (args, extra) => { calls.push([args, extra]); return { bound: true }; } });
  const args = { workerId: 'quote_demo', sessionId: 'session-demo-legacy', role: 'legacy' };
  validateToolArguments(bind, args);
  await bind.handler(args);
  assert.deepEqual(calls[0][0], args);
  assert.equal(calls[0][1], undefined);
  assert.equal(bind.annotations.idempotentHint, true);
  assert.throws(() => validateToolArguments(bind, { workerId: 'legacy' }), /Missing required argument "sessionId"/);
  assert.throws(() => validateToolArguments(bind, { workerId: 'legacy', sessionId: '   ' }), /non-whitespace/i);
  assert.throws(() => validateToolArguments(bind, { workerId: 'legacy', sessionId: 's', task: 'x' }), /Unknown argument/);
});

test('metadata update, forget, and archived listing schemas are exposed and validated', () => {
  const update = tool('dsh_update_worker_metadata');
  validateToolArguments(update, { workerId: 'legacy', customer: '085', purpose: '迁移', lifecycle: 'archived' });
  assert.throws(() => validateToolArguments(update, { workerId: 'legacy', customer: 'x'.repeat(81) }), /80/);
  assert.throws(() => validateToolArguments(update, { workerId: 'legacy', lifecycle: 'paused' }), /one of/i);
  assert.throws(() => validateToolArguments(update, { workerId: 'legacy', customer: '😀'.repeat(81) }), /80/);
  validateToolArguments(update, { workerId: 'legacy', customer: '😀'.repeat(80) });

  const forget = tool('dsh_forget_worker');
  validateToolArguments(forget, { workerId: 'legacy' });
  assert.throws(() => validateToolArguments(forget, {}), /Missing required argument "workerId"/);

  const list = tool('dsh_list_workers');
  validateToolArguments(list, {});
  validateToolArguments(list, { includeArchived: true });
  assert.throws(() => validateToolArguments(list, { includeArchived: 'yes' }), /boolean/);

  const start = tool('dsh_start_worker');
  validateToolArguments(start, { workerId: 'x', task: 't', customer: '085', purpose: '开发', lifecycle: 'active' });
  validateToolArguments(start, { workerId: 'x', task: 't', lifecycle: 'archived' });
});

test('start exposes alternative workspace selectors and rejects selecting both', () => {
  const start = tool('dsh_start_worker');
  validateToolArguments(start, { workerId: 'backend', task: 'implement', cwd: 'D:/repo' });
  validateToolArguments(start, { workerId: 'backend', task: 'implement', workspaceId: 'workspace-1' });
  assert.throws(() => validateToolArguments(start, { workerId: 'backend', task: 'implement', cwd: 'D:/repo', workspaceId: 'workspace-1' }), /mutually exclusive/i);
  assert.ok(start.inputSchema.not);
});

test('rejects blank, oversized, unknown and inherited arguments', () => {
  const start = tool('dsh_start_worker');
  assert.throws(() => validateToolArguments(start, { workerId: '   ', task: 'implement' }), /non-whitespace/i);
  assert.throws(() => validateToolArguments(start, { workerId: 'backend', task: '\n\t' }), /non-whitespace/i);
  assert.throws(() => validateToolArguments(start, { workerId: 'x'.repeat(129), task: 'implement' }), /128/);
  assert.throws(() => validateToolArguments(start, { workerId: 'backend', task: 'x'.repeat(200001) }), /200000/);
  assert.throws(() => validateToolArguments(start, { workerId: 'backend', task: 'implement', mystery: true }), /Unknown argument/);
  assert.throws(() => validateToolArguments(start, JSON.parse('{"workerId":"backend","task":"implement","__proto__":{}}')), /Unknown argument/);
  assert.throws(() => validateToolArguments(start, Object.create({ workerId: 'backend', task: 'implement' })), /Missing required argument/);
});

test('wait is bounded to one minute and forwards pagination plus request cancellation', async () => {
  const calls = [];
  const wait = tool('dsh_wait_worker', { waitForWorker: (...args) => { calls.push(args); return { status: 'running' }; } });
  const args = { workerId: 'backend', waitFor: 'completion', timeoutMs: 60000, sinceSeq: 8, limit: 20 };
  const extra = { signal: new AbortController().signal };
  validateToolArguments(wait, args);
  await wait.handler(args, extra);
  assert.deepEqual(calls, [[args, extra]]);
  assert.throws(() => validateToolArguments(wait, { workerId: 'backend', timeoutMs: 60001 }), /60000/);
  assert.throws(() => validateToolArguments(wait, { workerId: 'backend', waitFor: 'invalid' }), /one of/i);
  validateToolArguments(wait, { workerId: 'backend', sinceSeq: -1 });
  assert.throws(() => validateToolArguments(wait, { workerId: 'backend', sinceSeq: -2 }), /integer/);
});

test('progress forwards request cancellation to the session manager', async () => {
  const calls = [];
  const progress = tool('dsh_get_progress', { getProgress: (...args) => { calls.push(args); return { status: 'released' }; } });
  const args = { workerId: 'backend', sinceSeq: 3, limit: 4 };
  const extra = { signal: new AbortController().signal };
  await progress.handler(args, extra);
  assert.deepEqual(calls, [[args, extra]]);
});

test('task dispatch preserves complete instructions including whitespace verbatim', async () => {
  const calls = [];
  const start = tool('dsh_start_worker', { startWorker: (args) => calls.push(args) });
  const args = { workerId: 'backend', task: '  Read AGENTS.md.\n\nImplement X, test Y, report Z.\n' };
  validateToolArguments(start, args);
  await start.handler(args);
  assert.equal(calls[0].task, args.task);
  assert.match(start.inputSchema.properties.task.description, /verbatim/i);
});
