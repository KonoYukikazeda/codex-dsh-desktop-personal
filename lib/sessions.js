import { randomUUID } from 'node:crypto';
import { captureWorkspaceSnapshot, describeWorkspaceChanges } from './briefing.js';
import { createWorkerRegistry } from './registry.js';
import { renderEvents, renderStreamChunk } from './render.js';

const DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
const errorText = (error) => error instanceof Error ? error.message : String(error);
const TERMINAL_STATUSES = new Set(['idle', 'failed', 'cancelled', 'blocked', 'released', 'missing']);
const isNotFound = (error) => {
  const code = error?.code ?? error?.data?.code;
  return code === 'session/not-found' || code === 'subagent/not-found'
    || /session ".+" not found|session not found/i.test(errorText(error));
};

const TITLE_INSTRUCTION = '本会话标题须以 "[GPT] - " 开头。';
const LANGUAGE_INSTRUCTION = '请用中文分析和汇报。';

function taskContent(task, changes, reused) {
  // Follow-ups carry only the task text plus an optional workspace brief; the
  // task itself is always preserved verbatim.
  if (reused) return [changes, task].filter(Boolean).join('\n\n');
  // The task may already carry the title instruction (older dispatches do);
  // keep it once, then append the verbatim task.
  const header = task.includes(TITLE_INSTRUCTION)
    ? [LANGUAGE_INSTRUCTION]
    : [TITLE_INSTRUCTION, LANGUAGE_INSTRUCTION];
  return [...header, task].join('\n\n');
}

// Aborting a caller stops admission/observation, never cancels an admitted agent turn.
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createSessionManager({
  sessionController, sessions: sessionStore, agents, workspaceRegistry, sessionQuery,
  profileContext, stateFile,
  config = {}, pollIntervalMs = 400, clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (!sessionController || !workspaceRegistry) throw new Error('DSH sessionController and workspaceRegistry are required.');
  const workers = new Map();
  const bySession = new Map();
  const operations = new Map();
  const lifetime = new AbortController();
  const model = { ...DEFAULT_MODEL, ...(config.model ?? {}) };
  const now = () => new Date(clock()).toISOString();
  const signalFor = (extra) => extra?.signal ? AbortSignal.any([lifetime.signal, extra.signal]) : lifetime.signal;
  const registry = createWorkerRegistry({ profileContext, stateFile: stateFile ?? config.stateFile, clock });
  let registryError;
  let validationWarning;

  const ready = (async () => {
    try {
      const entries = await registry.load();
      for (const entry of entries) {
        const worker = {
          ...entry, status: 'released', lastSnapshot: null, streamVersion: 0,
          restored: true, validated: false, taskCount: entry.taskCount, lastTask: entry.lastTask
        };
        workers.set(worker.workerId, worker);
        bySession.set(worker.sessionId, worker);
      }
      if (entries.length > 0) await validateRestoredWorkers();
    } catch (error) {
      registryError = error;
    }
  })();

  async function ensureReady() {
    await ready;
    if (registryError) {
      throw new Error(
        `Worker registry "${registry.path}" could not be loaded: ${errorText(registryError)} `
        + 'The file was left unchanged; fix or move it before retrying. The plugin will not replace it with an empty registry.'
      );
    }
  }

  function markMissing(worker, message) {
    worker.missingSession = true;
    worker.sessionError = message;
    worker.status = 'missing';
    worker.validated = true;
    worker.updatedAt = now();
  }

  function markPresent(worker) {
    delete worker.missingSession;
    delete worker.sessionError;
    worker.validated = true;
  }

  async function listSessionSummaries(signal = lifetime.signal) {
    if (typeof sessionController.list !== 'function') return undefined;
    const value = await abortable(sessionController.list({}, signal), signal);
    return Array.isArray(value) ? value : value?.items ?? [];
  }

  async function validateRestoredWorkers() {
    let summaries;
    try {
      summaries = await listSessionSummaries();
    } catch (error) {
      if (lifetime.signal.aborted) throw error;
      validationWarning = `Could not validate restored workers against DSH sessions: ${errorText(error)}`;
      return;
    }
    if (summaries === undefined) {
      validationWarning = 'DSH sessionController.list() is unavailable; restored workers stay unvalidated until their session is read.';
      return;
    }
    const rows = new Map(summaries.map((row) => [row.sessionId, row]));
    for (const worker of workers.values()) {
      const row = rows.get(worker.sessionId);
      if (!row) {
        markMissing(worker, `DSH session "${worker.sessionId}" for worker "${worker.workerId}" was not found. It may have been deleted; the binding was kept but the plugin will not create a replacement automatically.`);
        continue;
      }
      markPresent(worker);
      if (typeof row.cwd === 'string' && row.cwd) worker.cwd = row.cwd;
      if (row.running) worker.status = 'running';
      else if (row.agentAvailable) worker.status = 'idle';
      else worker.status = 'released';
      if (worker.workspaceId && typeof workspaceRegistry.get === 'function' && !workspaceRegistry.get(worker.workspaceId)) {
        worker.workspaceId = undefined;
      }
    }
  }

  async function refreshValidation(worker, signal) {
    if (worker.validated && !worker.missingSession) return;
    const summaries = await listSessionSummaries(signal);
    if (summaries === undefined) return;
    const row = summaries.find((entry) => entry.sessionId === worker.sessionId);
    if (!row) {
      markMissing(worker, `DSH session "${worker.sessionId}" for worker "${worker.workerId}" was not found. It may have been deleted; the binding was kept but the plugin will not create a replacement automatically.`);
      return;
    }
    markPresent(worker);
    if (typeof row.cwd === 'string' && row.cwd) worker.cwd = row.cwd;
  }

  function requireUsableWorker(worker) {
    if (!worker.missingSession) return worker;
    throw new Error(
      `Worker "${worker.workerId}" is bound to DSH session "${worker.sessionId}", but that session no longer exists in DSH. `
      + 'Refusing to replace it with a new session. Use dsh_bind_worker to bind an existing DSH session, or choose a new workerId.'
    );
  }

  function persistable(worker) {
    return {
      workerId: worker.workerId, sessionId: worker.sessionId, role: worker.role,
      workspaceId: worker.workspaceId, cwd: worker.cwd,
      createdAt: worker.createdAt, updatedAt: worker.updatedAt,
      taskCount: worker.taskCount, lastTask: worker.lastTask
    };
  }

  function persist() {
    return registry.save([...workers.values()].map(persistable));
  }

  function reportPersistenceFailure(worker, result, error) {
    worker.persistenceError = errorText(error);
    return { ...result, persistenceError: worker.persistenceError };
  }

  function requireWorker(workerId) {
    lifetime.signal.throwIfAborted();
    const worker = workers.get(workerId);
    if (!worker) throw new Error(`Unknown worker "${workerId}". Start it with dsh_start_worker first.`);
    return worker;
  }

  function serialize(workerId, extra, action) {
    const signal = signalFor(extra);
    signal.throwIfAborted();
    const result = (operations.get(workerId) ?? Promise.resolve()).then(() => {
      signal.throwIfAborted();
      return action(signal);
    });
    const tail = result.catch(() => undefined);
    operations.set(workerId, tail);
    void tail.then(() => { if (operations.get(workerId) === tail) operations.delete(workerId); });
    return result;
  }

  function publicWorker(worker) {
    return {
      workerId: worker.workerId, role: worker.role, sessionId: worker.sessionId,
      workspace: worker.cwd, workspaceId: worker.workspaceId, status: worker.status,
      reusable: !worker.missingSession,
      restored: worker.restored === true,
      validated: worker.validated === true,
      queuedTaskCount: worker.queuedTaskCount ?? 0,
      taskCount: worker.taskCount, lastTask: worker.lastTask,
      createdAt: worker.createdAt, updatedAt: worker.updatedAt,
      ...(worker.turnEndReason ? { turnEndReason: worker.turnEndReason } : {}),
      ...(worker.error ? { error: worker.error } : {}),
      ...(worker.inspectError ? { inspectError: worker.inspectError } : {}),
      ...(worker.missingSession ? { missingSession: true, sessionError: worker.sessionError } : {}),
      ...(worker.historyError ? { historyError: worker.historyError } : {}),
      ...(worker.persistenceError ? { persistenceError: worker.persistenceError } : {}),
      ...(validationWarning && worker.restored ? { validationWarning } : {})
    };
  }

  function handoff(worker, status) {
    if (status === 'idle') {
      return {
        phase: 'deepseek-complete', awaitingReview: true, reusable: true,
        workerId: worker.workerId, sessionId: worker.sessionId,
        nextAction: 'DS 本轮已结束；请复核其主验结果与关键证据，做业务裁决和最终验收。如需修改，用同一 workerId 调用 dsh_assign_task。'
      };
    }
    if (status === 'failed' || status === 'cancelled' || status === 'blocked') {
      return {
        phase: `deepseek-${status}`, awaitingReview: true, reusable: true,
        workerId: worker.workerId, sessionId: worker.sessionId,
        nextAction: '查看返回的进度和工作区 diff，然后用同一 workerId 调用 dsh_assign_task 重试或纠正。'
      };
    }
    if (status === 'released') {
      return {
        phase: 'deepseek-released', awaitingReview: false, reusable: true,
        workerId: worker.workerId, sessionId: worker.sessionId,
        nextAction: '查看会话历史，然后用同一 workerId 调用 dsh_assign_task 继续驻留会话。'
      };
    }
    return {
      phase: 'deepseek-running', awaitingReview: false, reusable: true,
      workerId: worker.workerId, sessionId: worker.sessionId,
      nextAction: '调用 dsh_wait_worker 并将 waitFor 设为 "completion"，等待会话交回 Codex 审查。'
    };
  }

  async function latestEventSeq(worker, signal) {
    const session = sessionStore?.get(worker.sessionId);
    if (typeof session?.snapshotEvents === 'function') {
      try {
        const events = await abortable(session.snapshotEvents(0), signal);
        return events.reduce((max, event) => Math.max(max, Number(event.seq)), -1);
      } catch (error) {
        if (signal.aborted) throw error;
        return worker.statusSeq ?? -1;
      }
    }
    if (typeof sessionController.state === 'function') {
      try {
        const state = await abortable(sessionController.state({ sessionId: worker.sessionId }, signal), signal);
        if (Number.isSafeInteger(state?.cursor)) {
          worker.coldCursor = state.cursor;
          return state.cursor;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (isNotFound(error)) {
          markMissing(worker, `DSH session "${worker.sessionId}" for worker "${worker.workerId}" was not found.`);
          throw new Error(`DSH session "${worker.sessionId}" no longer exists; refusing to dispatch.`);
        }
      }
    }
    return worker.statusSeq ?? -1;
  }

  async function inspect(worker, signal = lifetime.signal) {
    signal.throwIfAborted();
    if (worker.missingSession) return { snapshot: {}, status: 'missing' };
    const agent = agents?.get(worker.sessionId);
    const session = sessionStore?.get(worker.sessionId);
    let snapshot = {};
    let coldStatus;
    if (!session) {
      if (typeof sessionController.inspect === 'function') {
        snapshot = await sessionController.inspect(worker.sessionId, signal);
        coldStatus = 'released';
      } else if (typeof sessionController.state === 'function') {
        try {
          const state = await abortable(sessionController.state({ sessionId: worker.sessionId }, signal), signal);
          const cursor = Number.isSafeInteger(state?.cursor) ? state.cursor : undefined;
          worker.coldCursor = cursor ?? worker.coldCursor;
          worker.coldQueue = state?.queue?.length ?? 0;
          coldStatus = state?.active ? (state.running ? 'running' : 'idle') : 'released';
          markPresent(worker);
          // A cold restored/bound worker has no in-memory lifecycle state. Start
          // its cursor at the observed log end so old turns cannot complete a
          // new dispatch; then read only events admitted after that cursor.
          if (worker.statusSeq === undefined && cursor !== undefined) {
            // A ready-then-assign path has no prior inspect. Start from this
            // dispatch's baseline so a turn that already finished before the
            // first observation is still processed instead of skipped.
            worker.statusSeq = worker.dispatchBaselineSeq ?? cursor;
          }
          if (state?.running) worker.awaitingTurnStart = false;
          let coldLifecycle = [];
          if (typeof sessionQuery?.readSession === 'function'
            && cursor !== undefined && cursor > (worker.statusSeq ?? -1)) {
            try {
              const loaded = await coldEvents(worker, signal);
              coldLifecycle = (loaded.events ?? []).filter((event) => Number(event.seq) > (worker.statusSeq ?? -1));
              delete worker.historyError;
            } catch (error) {
              if (signal.aborted) throw error;
              // Keep the admission barrier when history cannot be read: a
              // missing lifecycle observation must not become a false success.
              worker.historyError = errorText(error);
            }
          }
          snapshot = { state, events: coldLifecycle };
        } catch (error) {
          if (signal.aborted) throw error;
          if (isNotFound(error)) {
            markMissing(worker, `DSH session "${worker.sessionId}" for worker "${worker.workerId}" was not found. It may have been deleted.`);
            return { snapshot: {}, status: 'missing' };
          }
          throw error;
        }
      } else {
        snapshot = await sessionController.inspect(worker.sessionId, signal);
        coldStatus = 'released';
      }
    }
    // Track outcomes independently of client pagination, reading each lifecycle event once.
    const statusSeq = worker.statusSeq ?? -1;
    const lifecycleEvents = typeof session?.snapshotEvents === 'function'
      ? await abortable(session.snapshotEvents(statusSeq + 1), signal)
      : snapshot?.events ?? [];
    let observedTurnLifecycle = false;
    for (const event of lifecycleEvents) {
      if (event.seq <= (worker.statusSeq ?? -1)) continue;
      worker.statusSeq = Math.max(worker.statusSeq ?? -1, event.seq);
      // A restored or bound worker already has history. Outcomes at or before
      // this dispatch's baseline belong to an earlier turn and must not make
      // the newly admitted turn look complete while DSH still reports idle.
      if (event.seq <= (worker.dispatchBaselineSeq ?? -1)) continue;
      if (event.type === 'turn/start') {
        if (event.seq > (worker.dispatchBaselineSeq ?? -1)) observedTurnLifecycle = true;
        delete worker.turnEndReason;
        worker.cancelRequested = false;
        worker.turnActive = true;
      } else if (event.type === 'turn/end') {
        if (event.seq > (worker.dispatchBaselineSeq ?? -1)) observedTurnLifecycle = true;
        worker.turnEndReason = event.data?.reason;
        worker.turnActive = false;
        worker.completedTurnObserved = true;
      }
    }
    if (observedTurnLifecycle) worker.awaitingTurnStart = false;
    worker.queuedTaskCount = agent
      ? (agent?.inbox?.nextTurn?.length ?? 0) + (agent?.inbox?.nextStep?.length ?? 0)
      : (worker.coldQueue ?? 0);
    const queued = worker.queuedTaskCount > 0;
    let status = agent?.status ?? coldStatus ?? 'released';
    if (worker.admitting) status = 'queued';
    else if (status === 'idle' && worker.error) status = 'failed';
    else if (status === 'idle' && worker.turnActive) status = 'running';
    else if ((status === 'idle' || status === 'released') && worker.awaitingTurnStart && !worker.turnEndReason && !worker.cancelRequested) status = 'queued';
    else if (status === 'idle') {
      const kind = worker.turnEndReason?.kind;
      if (kind === 'aborted' || worker.cancelRequested) status = 'cancelled';
      else if (kind === 'blocked') status = 'blocked';
      else if (kind && kind !== 'completed') status = 'failed';
      else if (queued) status = 'queued';
    } else if (queued) status = 'queued';
    // A cold Agent may be released as soon as the new turn ends. If we observed
    // that new turn's lifecycle, report its real outcome instead of a generic
    // released state that would lose the successful completion.
    if (status === 'released' && observedTurnLifecycle) {
      const kind = worker.turnEndReason?.kind;
      if (kind === 'completed') status = 'idle';
      else if (kind === 'blocked') status = 'blocked';
      else if (kind) status = 'failed';
    }
    worker.status = status;
    delete worker.inspectError;
    return { snapshot, status };
  }

  async function dispatch(worker, task, mode, signal) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task must be a non-empty string.');
    if (!['queue', 'steer'].includes(mode)) throw new Error('mode must be "queue" or "steer".');
    requireUsableWorker(worker);
    await refreshValidation(worker, signal);
    requireUsableWorker(worker);
    worker.admitting = true;
    worker.error = undefined;
    delete worker.turnEndReason;
    worker.cancelRequested = false;
    worker.turnActive = false;
    try {
      const changes = worker.lastSnapshot
        ? await describeWorkspaceChanges(worker.cwd, worker.lastSnapshot)
        : { snapshot: await captureWorkspaceSnapshot(worker.cwd), summary: '' };
      signal.throwIfAborted();
      // DSH rejects every model step of an archived session. Restore it through
      // the registry before prompting so reuse keeps the original conversation.
      if (typeof workspaceRegistry.unarchiveSession === 'function') {
        await workspaceRegistry.unarchiveSession(worker.sessionId);
        signal.throwIfAborted();
      }
      // Reselect for each dispatch in case the desktop user changed the model.
      await sessionController.selectModel({ sessionId: worker.sessionId, ...model });
      signal.throwIfAborted();
      const dispatchBaselineSeq = await latestEventSeq(worker, signal);
      const requestId = randomUUID();
      // First dispatch is decided by successfully dispatched tasks (taskCount),
      // so a failed dispatch keeps the first-turn wording for the retry. A
      // restored or manually bound worker is already an existing conversation
      // even when its recovered taskCount is 0.
      const reused = worker.taskCount > 0 || worker.restored === true;
      await sessionController.prompt({
        requestId, sessionId: worker.sessionId, mode,
        content: [{ type: 'text', text: taskContent(task, changes.summary, reused) }]
      }, signal);
      worker.taskCount += 1;
      worker.dispatchBaselineSeq = dispatchBaselineSeq;
      // A reused worker whose prior turn has ended has a real admission gap:
      // DSH may briefly still report idle before emitting the next turn/start.
      // Restored/bound workers carry the same gap without a live
      // completedTurnObserved flag, so require a new lifecycle event for them too.
      worker.awaitingTurnStart = reused && (worker.completedTurnObserved === true || worker.restored === true);
      worker.lastTask = task;
      worker.lastSnapshot = changes.snapshot;
      worker.status = 'queued';
      worker.updatedAt = now();
      return { ...publicWorker(worker), requestId, reused, workspaceChanges: changes.summary, accepted: true, handoff: handoff(worker, 'running') };
    } catch (error) {
      worker.error = errorText(error);
      worker.status = 'failed';
      throw new Error(`Worker "${worker.workerId}" (DSH session ${worker.sessionId}) could not accept the task: ${errorText(error)}`, { cause: error });
    } finally { worker.admitting = false; }
  }

  function startWorker(args, extra) {
    return serialize(args.workerId, extra, async (signal) => {
      await ensureReady();
      const { workerId, role = 'generalist', task, cwd, workspaceId } = args;
      if (workers.has(workerId)) {
        const existing = workers.get(workerId);
        if ((workspaceId && workspaceId !== existing.workspaceId) || (cwd && cwd !== existing.cwd)) {
          throw new Error('An existing worker cannot change workspace. Use a different workerId.');
        }
        const result = await dispatch(existing, task, 'queue', signal);
        try { await persist(); } catch (error) { return reportPersistenceFailure(existing, result, error); }
        return result;
      }
      if (typeof task !== 'string' || !task.trim()) throw new Error('task must be a non-empty string.');
      if (cwd && workspaceId) throw new Error('cwd and workspaceId are mutually exclusive.');
      let workspace;
      if (workspaceId) workspace = workspaceRegistry.get(workspaceId);
      else if (cwd ?? config.workspace) workspace = await workspaceRegistry.create(cwd ?? config.workspace);
      if (!workspace) throw new Error('No DSH workspace found. Configure workspace or pass an existing workspaceId / absolute cwd.');
      signal.throwIfAborted();
      const created = await sessionController.create({ workspaceId: workspace.id });
      const sessionId = typeof created === 'string' ? created : created?.sessionId;
      if (!sessionId) throw new Error('DSH sessionController.create() did not return a session id.');
      if (bySession.has(sessionId)) {
        throw new Error(`DSH created session "${sessionId}", which is already bound to worker "${bySession.get(sessionId).workerId}". No new binding was saved.`);
      }
      const worker = {
        workerId, role, sessionId, cwd: workspace.path, workspaceId: workspace.id,
        status: 'created', taskCount: 0, lastTask: null, lastSnapshot: null,
        createdAt: now(), updatedAt: now(), streamVersion: 0, validated: true
      };
      workers.set(workerId, worker);
      bySession.set(sessionId, worker);
      // Persist the binding before admitting the first task. A failed write rolls
      // the in-memory binding back and never prompts a session absent from disk.
      try {
        await persist();
      } catch (error) {
        workers.delete(workerId);
        bySession.delete(sessionId);
        throw new Error(
          `Worker "${workerId}" was not bound: the DSH session was created but the worker registry write failed: ${errorText(error)}. `
          + 'No task was dispatched and no in-memory binding was kept.'
        );
      }
      const result = await dispatch(worker, task, 'steer', signal);
      try { await persist(); } catch (error) { return reportPersistenceFailure(worker, result, error); }
      return result;
    });
  }

  function assignTask({ workerId, task, mode = 'queue' }, extra) {
    return serialize(workerId, extra, async (signal) => {
      await ensureReady();
      const worker = requireUsableWorker(requireWorker(workerId));
      const result = await dispatch(worker, task, mode, signal);
      try { await persist(); } catch (error) { return reportPersistenceFailure(worker, result, error); }
      return result;
    });
  }

  function bindWorker(args, extra) {
    return serialize(args.workerId, extra, async (signal) => {
      await ensureReady();
      const { workerId, sessionId, role = 'generalist' } = args;
      if (typeof workerId !== 'string' || !workerId.trim()) throw new Error('workerId must be a non-empty string.');
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string.');
      if (typeof role !== 'string' || !role.trim()) throw new Error('role must be a non-empty string.');

      const existing = workers.get(workerId);
      if (existing) {
        if (existing.sessionId !== sessionId) {
          throw new Error(`Worker "${workerId}" is already bound to DSH session "${existing.sessionId}", not "${sessionId}". Refusing to rebind.`);
        }
        await refreshValidation(existing, signal);
        requireUsableWorker(existing);
        try { await inspect(existing, signal); } catch (error) { if (signal.aborted) throw error; existing.inspectError = errorText(error); }
        requireUsableWorker(existing);
        return { ...publicWorker(existing), bound: true, alreadyBound: true };
      }
      const other = bySession.get(sessionId);
      if (other) {
        throw new Error(`DSH session "${sessionId}" is already bound to worker "${other.workerId}". Refusing to bind one session to two workers.`);
      }

      const summaries = await listSessionSummaries(signal);
      if (summaries === undefined) {
        throw new Error('Cannot verify the DSH session: this DSH version does not expose sessionController.list(). Refusing to bind an unverified session.');
     