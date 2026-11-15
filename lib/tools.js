const stringSchema = (description, maxLength) => ({ type: 'string', description, minLength: 1, maxLength, pattern: '\\S' });
const workerIdSchema = () => stringSchema('Stable worker key returned by dsh_start_worker, for example "frontend".', 128);
const sessionIdSchema = () => stringSchema('Existing DSH session ID to bind, for example the sessionId returned by a previous handoff.', 256);
const taskSchema = () => stringSchema('Complete task instructions passed verbatim: include the goal, module/file ownership, required workspace reading, constraints, acceptance checks, and expected report. Supply all requirements; workers do not inherit the planner chat.', 200000);
const progressSchema = () => ({
  sinceSeq: { type: 'integer', minimum: -1, maximum: Number.MAX_SAFE_INTEGER, default: -1, description: 'Return events strictly after this zero-based sequence number. Default -1 reads from the beginning; continue using lastSeq/nextSeq from the previous page.' },
  limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum events per page (default 100). Continue with nextSeq while hasMore is true.' }
});

function objectSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function annotations(readOnly) {
  return { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly };
}

export function createTools(manager) {
  return [
    {
      name: 'dsh_start_worker',
      description: 'Create a visible DSH desktop session with the configured DeepSeek model and dispatch a complete task. An existing workerId reuses its persisted session, including after a DSH or plugin restart. Workers read the workspace and retain their own conversation for later tasks.',
      inputSchema: {
        ...objectSchema({
          workerId: workerIdSchema(),
          role: stringSchema('The module or responsibility owned by this worker (default generalist).', 1024),
          task: taskSchema(),
          cwd: stringSchema('Workspace directory for a new worker; omit to use plugin config. Mutually exclusive with workspaceId.', 4096),
          workspaceId: stringSchema('Existing DSH workspace ID for a new worker. Mutually exclusive with cwd.', 256)
        }, ['workerId', 'task']),
        not: { required: ['cwd', 'workspaceId'] }
      },
      annotations: annotations(false),
      handler: (args, extra) => manager.startWorker(args, extra)
    },
    {
      name: 'dsh_bind_worker',
      description: 'Bind an existing DSH session to a stable workerId without sending a task, changing history, selecting a model, or archiving. Use this once to migrate a session created before persistence was enabled; later restarts restore it automatically. Repeating the same workerId/sessionId pair is idempotent.',
      inputSchema: objectSchema({
        workerId: workerIdSchema(),
        sessionId: sessionIdSchema(),
        role: stringSchema('The module or responsibility owned by this worker (default generalist).', 1024)
      }, ['workerId', 'sessionId']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (args, extra) => manager.bindWorker(args, extra)
    },
    {
      name: 'dsh_assign_task',
      description: 'Dispatch full requirements to an existing worker, including one restored from this DSH profile registry, with a workspace metadata change brief since its previous dispatch. Queue mode preserves active work; steer redirects it. Workers retain their prior conversation and must reread relevant changed files.',
      inputSchema: objectSchema({
        workerId: workerIdSchema(),
        task: taskSchema(),
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'Use queue by default; use steer to redirect active work.' }
      }, ['workerId', 'task']),
      annotations: annotations(false),
      handler: (args, extra) => manager.assignTask(args, extra)
    },
    {
      name: 'dsh_list_workers',
      description: 'List workers persisted for this DSH profile, their desktop session IDs, roles, current status, and latest dispatched tasks. A deleted or missing DSH session is reported explicitly instead of being replaced.',
      inputSchema: objectSchema(),
      annotations: annotations(true),
      handler: () => manager.listWorkers()
    },
    {
      name: 'dsh_get_progress',
      description: 'Read the earliest chronological page of DSH events after sinceSeq, including text, reasoning and tool activity. Returns nextSeq and hasMore for lossless pagination; truncated event text is marked explicitly.',
      inputSchema: objectSchema({ workerId: workerIdSchema(), ...progressSchema() }, ['workerId']),
      annotations: annotations(true),
      handler: (args, extra) => manager.getProgress(args, extra)
    },
    {
      name: 'dsh_wait_worker',
      description: 'Supervise a worker and return an event page. waitFor="completion" (default) keeps waiting until the current turn ends or times out, then returns a handoff with the resident session for Codex review; waitFor="progress" returns promptly on the next event or stream update. A completed/succeeded response is never final acceptance. Continue with nextSeq and hasMore. Request cancellation stops this wait; dsh_cancel_worker cancels actual work.',
      inputSchema: objectSchema({
        workerId: workerIdSchema(),
        waitFor: { type: 'string', enum: ['progress', 'completion'], description: 'Observation mode: completion waits for a terminal turn outcome (default); progress returns promptly on new activity.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'Maximum wait in milliseconds (default 30000, maximum 60000).' },
        ...progressSchema()
      }, ['workerId']),
      annotations: annotations(true),
      handler: (args, extra) => manager.waitForWorker(args, extra)
    },
    {
      name: 'dsh_cancel_worker',
      description: 'Cancel the worker session current turn. Its resident DSH session and queued tasks remain available; inspect progress afterward to verify state.',
      inputSchema: objectSchema({ workerId: workerIdSchema() }, ['workerId']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: (args, extra) => manager.cancelWorker(args, extra)
    }
  ];
}

export function validateToolArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  const { properties = {}, required = [], additionalProperties, not } = tool.inputSchema;
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error(`Missing required argument "${key}".`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) {
      if (additionalProperties === false) throw new Error(`Unknown argument "${key}".`);
      continue;
    }
    const field = properties[key];
    if (field.type === 'string') {
      if (typeof value !== 'string' || value.length < field.minLength || value.length > field.maxLength) {
        throw new Error(`Argument "${key}" must be a string between ${field.minLength} and ${field.maxLength} character(s).`);
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) throw new Error(`Argument "${key}" must contain non-whitespace characters.`);
    }
    if (field.type === 'integer' && (!Number.isSafeInteger(value) || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity))) {
      throw new Error(`Argument "${key}" must be an integer between ${field.minimum ?? '-infinity'} and ${field.maximum ?? 'infinity'}.`);
    }
    if (field.enum && !field.enum.includes(value)) throw new Error(`Argument "${key}" must be one of: ${field.enum.join(', ')}.`);
  }
  if (not?.required?.every((key) => Object.hasOwn(args, key))) {
    throw new Error(`Arguments ${not.required.map((key) => `"${key}"`).join(' and ')} are mutually exclusive.`);
  }
}
