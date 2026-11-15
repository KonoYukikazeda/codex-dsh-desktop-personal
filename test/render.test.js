import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvent, renderEvents } from '../lib/render.js';
import * as render from '../lib/render.js';

const event = (seq, text) => ({ seq, type: 'message', data: { message: { content: [{ type: 'text', text }] } } });

test('progress returns the earliest chronological page without skipping middle events', () => {
  const events = [event(4, 'four'), event(2, 'two'), event(1, 'one'), event(3, 'three')];
  const first = renderEvents(events, { limit: 2 });
  assert.deepEqual(first.map(({ seq }) => seq), [1, 2]);
  const second = renderEvents(events.filter(({ seq }) => seq > first.at(-1).seq), { limit: 2 });
  assert.deepEqual(second.map(({ seq }) => seq), [3, 4]);
  assert.deepEqual(events.map(({ seq }) => seq), [4, 2, 1, 3]);
});

test('renders actual DSH user messages and standalone tool calls and results', () => {
  assert.equal(renderEvent({ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'read the workspace' }] } }).text, 'read the workspace');
  const call = renderEvent({ seq: 1, type: 'tool/call', data: { callId: 'call-1', name: 'readFile', arguments: '{"path":"main.js"}' } });
  assert.match(call.text, /readFile/);
  assert.match(call.text, /call-1/);
  assert.match(call.text, /main\.js/);
  const result = renderEvent({ seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }], isError: true }] } } });
  assert.match(result.text, /call-1/);
  assert.match(result.text, /file contents/);
  assert.match(result.text, /error/i);
});

test('renders actual DSH stream deltas without repeating assembled block text', () => {
  assert.equal(typeof render.renderStreamChunk, 'function');
  assert.equal(render.renderStreamChunk({ type: 'text-delta', index: 0, text: 'working' }), 'working');
  assert.match(render.renderStreamChunk({ type: 'reasoning-delta', index: 1, text: 'checking' }), /checking/);
  assert.match(render.renderStreamChunk({ type: 'tool-call-delta', index: 2, id: 'call-1', name: 'readFile', argumentsDelta: '{"path":' }), /readFile.*\{"path":/);
  assert.equal(render.renderStreamChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'working' } }), '');
  assert.match(render.renderStreamChunk({ type: 'finish', reason: { kind: 'error', failure: { code: 'bad-model', message: 'model unavailable' } } }), /model unavailable/);
});

test('event and page truncation is explicit and bounded while retaining each event', () => {
  const single = renderEvent(event(1, 'x'.repeat(20000)));
  assert.equal(single.truncated, true);
  assert.ok(single.text.length <= 6000);
  assert.match(single.text, /truncated/i);
  const page = renderEvents(Array.from({ length: 500 }, (_, index) => event(index + 1, 'x'.repeat(20000))), { limit: 500 });
  assert.equal(page.length, 500);
  assert.ok(page.reduce((length, current) => length + current.text.length, 0) <= 60000);
  assert.ok(page.every((current) => current.truncated));
});

test('renders reasoning and tool calls without losing tool arguments or results', () => {
  const rendered = renderEvent({ seq: 7, type: 'message', data: { message: { content: [
    { type: 'reasoning', text: 'inspect first' },
    { type: 'tool-call', toolName: 'readFile', input: { path: 'main.js' } },
    { type: 'tool-result', toolName: 'readFile', output: 'contents' }
  ] } } });
  assert.match(rendered.text, /inspect first/);
  assert.match(rendered.text, /readFile/);
  assert.match(rendered.text, /main\.js/);
  assert.match(rendered.text, /contents/);
});
