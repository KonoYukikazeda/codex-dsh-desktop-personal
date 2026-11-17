const codePointLength = (value) => [...value].length;
const stringSchema = (description, maxLength) => ({ type: 'string', description, minLength: 1, maxLength, pattern: '\\S' });
const workerIdSchema = () => stringSchema('Stable worker key returned by dsh_start_worker, for example "frontend".', 128);
const sessionIdSchema = () => stringSchema('Existing DSH session ID to bind, for example the sessionId returned by a previous handoff.', 256);
const taskSchema = () => stringSchema('Complete task instructions passed verbatim: include the goal, module/file ownership, required workspace reading, constraints, acceptance checks, and expected report. Supply all requirements; workers do not inherit the planner chat.', 200000);
const customerSchema = () => stringSchema('Optional customer number or short name for this worker (at most 80 Unicode characters).', 80);
const purposeSchema = () => stringSchema('Optional short purpose of this worker (at most 200 Unicode characters).', 200);
const lifecycleSchema = () => ({
  type: 'string',
  enum: ['active', 'archived'],
  description: 'Lifecycle metadata: active (default) allows dispatching; archived keeps the binding but refuses new tasks until restored.'
});
const metadataProperties = () => ({
  customer: customerSchema(),
  purpose: purposeSchema(),
  lifecycle: lifecycleSchema()
});
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
      description: 'Create a visible DSH desktop session with the configured DeepSeek model and dispatch a complete task. An existing workerId reuses its persisted session, including after a DSH or plugin restart. Workers read the workspace and retain their own conversation for later tasks. Optional customer/purpose/lifecycle metadata can be set here; archived workers cannot be started.',
      inputSchema: {
        ...objectSchema({
          workerId: workerIdSchema(),
          role: stringSchema('The module or responsibility owned by this worker (default generalist).', 1024),
          task: taskSchema(),
          cwd: stringSchema('Workspace directory for a new worker; omit to use plugin config. Mutually exclusive with workspaceId.', 4096),
          workspaceId: stringSchema('Existing DSH workspace ID for a new worker. Mutually exclusive with cwd.', 256),
          ...metadataProperties()
        }, ['workerId', 'task']),
        not: { required: ['cwd', 'workspaceId'] }
      },
      annotations: annotations(false),
      handler: (args, extra) => manager.startWorker(args, extra)
    },
    {
      name: 'dsh_bind_worker',
      description: 'Bind an existing DSH session to a stable workerId without sending a task, changing history, selecting a model, or archiving the DSH session. Optional customer/purpose/lifecycle metadata can be set here. Use this once to migrate a session created before persistence was enabled; later restarts restore it automatically. Repeating the same workerId/sessionId pair is idempotent.',
      inputSchema: objectSchema({
        workerId: workerIdSchema(),
        sessionId: sessionIdSchema(),
        role: stringSchema('The module or responsibility owned by this worker (default generalist).', 1024),
        ...metadataProperties()
      }, ['workerId', 'sessionId']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (args, extra) => manager.bindWorker(args, extra)
    },
    {
      name: 'dsh_assign_task',
      description: 'Dispatch full requirements to an existing active worker, including one restored from this DSH profile registry. Queue mode preserves active work; steer redirects it. Archived workers refuse tasks until restored through metadata. Follow-ups get the fixed source marker "[GPT]:" plus a newline before the verbatim task body (not duplicated if already present). The worker does not inherit the planner chat and must reread relevant files and git diff itself when needed.',
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
      description: 'List workers persisted for this DSH profile, their desktop session IDs, roles, customer/purpose metadata, lifecycle, current status, and last task summary. Defaults to active workers only; set includeArchived=true to include archived entries. Archived records still count toward the 200-record limit. A deleted or missing DSH session is reported explicitly instead of being replaced.',
      inputSchema: objectSchema({
        includeArchived: { type: 'boolean', default: false, description: 'Include lifecycle="archived" records. Default false.' }
      }),
      annotations: annotations(true),
      handler: (args) => manager.listWorkers(args)
    },
    {
      name: 'dsh_update_worker_metadata',
      description: 'Update only the index metadata of an existing worker: customer, purpose, and/or lifecycle. Does not send a task, change history, select a model, archive the DSH session, or delete it. Setting lifecycle="active" restores an archived worker; setting lifecycle="archived" keeps the binding but blocks new dispatches.',
      inputSchema: objectSchema({
        workerId: workerIdSchema(),
        ...metadataProperties()
      }, ['workerId']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (args, extra) => manager.updateWorkerMetadata(args, extra)
    },
    {
      name: 'dsh_forget_worker',
      description: 'Remove one idle worker registration from this plugin index without deleting or modifying its DSH session. Refused while the worker is running, admitting, cancelling, or queued. The same session can later be recovered with dsh_bind_worker. Archived entries can be forgotten. Does not free session history.',
      inputSchema: objectSchema({ workerId: workerIdSchema() }, ['workerId']),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: (args, extra) => manager.forgetWorker(args, extra)
    },
    {
      name: 'dsh_get_progress',
      description: 'Read the earliest chronological page of DSH events after sinceSeq, including text, reasoning and tool activity. Returns nextSeq and hasMore for lossless pagination; truncated event text is marked explicitly. Archived workers are readable but cannot receive tasks.',
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
      description: 'Cancel the worker session current turn. Its resident DSH session and queued tasks remain available; inspect progress afterward to verify state. Lifecycle metadata is unchanged.',
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
      const length = typeof value === 'string' ? codePointLength(value) : -1;
      if (typeof value !== 'string' || length < field.minLength || length > field.maxLength) {
        throw new Error(`Argument "${key}" must be a string between ${field.minLength} and ${field.maxLength} character(s).`);
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) throw new Error(`Argument "${key}" must contain non-whitespace characters.`);
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`Argument "${key}" must be a boolean.`);
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
