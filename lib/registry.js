import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const REGISTRY_VERSION = 1;
export const REGISTRY_DIRECTORY = 'codex-dsh-desktop';
export const REGISTRY_FILE = 'workers.json';

const errorText = (error) => error instanceof Error ? error.message : String(error);

/** A stable, reportable failure while locating, reading, validating, or writing the worker registry. */
export class RegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/**
 * Resolve the profile-scoped registry path.
 *
 * The default is `<profileContext.dir>/codex-dsh-desktop/workers.json`: the DSH
 * profile owns it, so every restart of the same profile finds the same file.
 * `stateFile` is an explicit override for tests or unusual deployments; there is
 * deliberately no process.cwd() or workspace fallback.
 */
export function resolveRegistryPath({ profileContext, stateFile } = {}) {
  if (stateFile !== undefined && stateFile !== null) {
    if (typeof stateFile !== 'string' || !stateFile.trim()) {
      throw new RegistryError('INVALID_LOCATION', 'config.stateFile must be a non-empty string when provided.');
    }
    return resolve(stateFile);
  }
  if (typeof profileContext?.dir === 'string' && profileContext.dir.trim()) {
    return join(profileContext.dir, REGISTRY_DIRECTORY, REGISTRY_FILE);
  }
  throw new RegistryError(
    'NO_LOCATION',
    'Cannot locate the DSH profile data directory (profileContext.dir is unavailable). Load this plugin through a DSH profile or set config.stateFile explicitly.'
  );
}

/** Build the versioned on-disk document from live worker records. */
export function createRegistryDocument(workers, { now = Date.now } = {}) {
  if (!Array.isArray(workers)) throw new TypeError('workers must be an array.');
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date(now()).toISOString(),
    workers: workers.map((worker) => ({
      workerId: worker.workerId,
      sessionId: worker.sessionId,
      role: worker.role,
      workspaceId: worker.workspaceId ?? null,
      cwd: worker.cwd,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      taskCount: worker.taskCount,
      lastTask: worker.lastTask ?? null
    }))
  };
}

function invalid(message, cause) {
  return new RegistryError('INVALID_RECORD', message, cause === undefined ? {} : { cause });
}

function requireString(value, name, workerId) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`Worker registry entry "${workerId}" has an invalid ${name}.`);
  return value;
}

function requireTimestamp(value, name, workerId) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid ${name} timestamp.`);
  }
  return value;
}

function validateEntry(entry, index, seenWorkerIds, seenSessionIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalid(`Worker registry entry at index ${index} is not an object.`);
  }
  const workerId = requireString(entry.workerId, 'workerId', `#${index}`);
  const sessionId = requireString(entry.sessionId, 'sessionId', workerId);
  const role = requireString(entry.role, 'role', workerId);
  requireTimestamp(entry.createdAt, 'createdAt', workerId);
  requireTimestamp(entry.updatedAt, 'updatedAt', workerId);
  if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) {
    throw invalid(`Worker registry entry "${workerId}" has a non-absolute cwd.`);
  }
  if (entry.workspaceId !== null && entry.workspaceId !== undefined && (typeof entry.workspaceId !== 'string' || !entry.workspaceId.trim())) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid workspaceId.`);
  }
  if (!Number.isSafeInteger(entry.taskCount) || entry.taskCount < 0 || Object.is(entry.taskCount, -0)) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid taskCount.`);
  }
  if (entry.lastTask !== null && entry.lastTask !== undefined && typeof entry.lastTask !== 'string') {
    throw invalid(`Worker registry entry "${workerId}" has an invalid lastTask.`);
  }
  if (entry.taskCount > 0 && typeof entry.lastTask !== 'string') {
    throw invalid(`Worker registry entry "${workerId}" has taskCount > 0 but no recorded lastTask.`);
  }
  if (seenWorkerIds.has(workerId)) throw new RegistryError('CONFLICT', `Worker registry contains duplicate workerId "${workerId}".`);
  if (seenSessionIds.has(sessionId)) throw new RegistryError('CONFLICT', `Worker registry binds DSH session "${sessionId}" to more than one worker.`);
  seenWorkerIds.add(workerId);
  seenSessionIds.add(sessionId);
  return {
    workerId,
    sessionId,
    role,
    workspaceId: entry.workspaceId ?? null,
    cwd: entry.cwd,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    taskCount: entry.taskCount,
    lastTask: entry.lastTask ?? null
  };
}

/** Validate a parsed registry document without touching disk. */
export function parseRegistryDocument(parsed, path = 'worker registry') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`Worker registry "${path}" must contain a JSON object.`);
  }
  if (parsed.version !== REGISTRY_VERSION) {
    throw new RegistryError(
      'UNSUPPORTED_VERSION',
      `Worker registry "${path}" has version ${JSON.stringify(parsed.version)}; this plugin supports version ${REGISTRY_VERSION}. The file was left unchanged.`
    );
  }
  if (!Array.isArray(parsed.workers)) {
    throw invalid(`Worker registry "${path}" must contain a "workers" array.`);
  }
  const seenWorkerIds = new Set();
  const seenSessionIds = new Set();
  return parsed.workers.map((entry, index) => validateEntry(entry, index, seenWorkerIds, seenSessionIds));
}

async function writeAtomically(path, text) {
  const directory = dirname(path);
  const temporary = join(directory, `.${process.pid}-${randomUUID()}.workers.tmp`);
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new RegistryError('WRITE_FAILED', `Could not write worker registry "${path}": ${errorText(error)}`, { cause: error });
  }
}

/**
 * Profile-scoped worker registry with versioned validation, atomic replacement,
 * and serialized writes. Reads never create or replace the file.
 */
export function createWorkerRegistry({ profileContext, stateFile, now = Date.now } = {}) {
  const path = resolveRegistryPath({ profileContext, stateFile });
  let writeTail = Promise.resolve();

  return {
    path,
    /** Load the persisted workers; a missing file is an empty registry, every other read failure is loud. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw new RegistryError('READ_FAILED', `Could not read worker registry "${path}": ${errorText(error)}`, { cause: error });
      }
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (error) {
        throw new RegistryError(
          'INVALID_JSON',
          `Worker registry "${path}" is not valid JSON: ${errorText(error)}. The file was left unchanged.`,
          { cause: error }
        );
      }
      return parseRegistryDocument(parsed, path);
    },
    /**
     * Replace the registry with a snapshot of `workers`. Writes are serialized in
     * call order; each call snapshots its input before waiting, so concurrent
     * saves cannot interleave or drop an already accepted record.
     */
    save(workers) {
      const document = createRegistryDocument(workers, { now });
      const text = `${JSON.stringify(document, null, 2)}\n`;
      const operation = writeTail.then(() => writeAtomically(path, text));
      writeTail = operation.catch(() => undefined);
      return operation;
    }
  };
}
