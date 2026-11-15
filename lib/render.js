const MAX_EVENT_TEXT = 6000;
const MAX_PAGE_TEXT = 60000;

function stringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderContent(content) {
  if (Array.isArray(content)) return content.map(renderContentBlock).filter(Boolean).join('\n');
  return typeof content === 'string' ? content : stringify(content ?? '');
}

function renderContentBlock(block) {
  if (!block || typeof block !== 'object') return String(block ?? '');
  switch (block.type) {
    case 'text':
      return String(block.text ?? '');
    case 'reasoning':
      return `[思考] ${block.text ?? block.reasoning ?? ''}`;
    case 'tool-call':
    case 'tool_use':
      return `[工具调用] ${block.name ?? block.toolName ?? 'unknown'}${block.id ? ` (${block.id})` : ''} ${typeof block.arguments === 'string' ? block.arguments : stringify(block.input ?? block.arguments ?? {})}`;
    case 'tool-result':
    case 'tool_result':
      return `[工具结果${block.isError ? ' error' : ''}] ${block.name ?? block.toolName ?? block.toolCallId ?? 'unknown'} ${renderContent(block.output ?? block.content ?? '')}`;
    default:
      return stringify(block);
  }
}

function truncateText(text, maximum) {
  if (text.length <= maximum) return text;
  const suffix = `… [truncated; original ${text.length} characters]`;
  return `${text.slice(0, Math.max(0, maximum - suffix.length)).replace(/[\uD800-\uDBFF]$/, '')}${suffix}`;
}

// DSH emits provider-neutral chunks; block-end repeats the assembled delta text.
export function renderStreamChunk(chunk) {
  let text = '';
  switch (chunk?.type) {
    case 'text-delta': text = String(chunk.text ?? ''); break;
    case 'reasoning-delta': text = `[思考] ${chunk.text ?? ''}`; break;
    case 'tool-call-delta': text = `[工具调用] ${chunk.name ?? chunk.id ?? 'unknown'} ${chunk.argumentsDelta ?? ''}`; break;
    case 'finish': text = `[${chunk.reason?.kind ?? 'finish'}]${chunk.reason?.failure?.message ? ` ${chunk.reason.failure.message}` : ''}`; break;
  }
  return truncateText(text, MAX_EVENT_TEXT);
}

export function renderEvent(event, { maxTextLength = MAX_EVENT_TEXT } = {}) {
  const message = event?.data?.message ?? event?.message ?? (event?.data?.content ? event.data : undefined);
  const content = message?.content;
  let text;
  if (event?.type === 'tool/call') text = renderContentBlock({ type: 'tool-call', ...event.data, id: event.data?.callId });
  else if (content !== undefined) text = renderContent(content);
  else text = event?.type ? `[${event.type}]` : stringify(event);

  const originalTextLength = text.length;
  const truncated = text.length > maxTextLength;
  if (truncated) {
    text = truncateText(text, maxTextLength);
  }
  return {
    seq: event?.seq ?? null,
    type: event?.type ?? 'event',
    text,
    ...(truncated ? { truncated: true, originalTextLength } : {})
  };
}

export function renderEvents(events, { limit = 100 } = {}) {
  const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
  const selected = (Array.isArray(events) ? events : [])
    .slice()
    .sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0))
    .slice(0, count);
  const maxTextLength = Math.min(MAX_EVENT_TEXT, Math.floor(MAX_PAGE_TEXT / Math.max(1, selected.length)));
  return selected.map((event) => renderEvent(event, { maxTextLength }));
}
