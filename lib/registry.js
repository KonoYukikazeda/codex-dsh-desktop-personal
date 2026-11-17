import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const REGISTRY_VERSION = 2;
export const LEGACY_REGISTRY_VERSION = 1;
export const MAX_WORKERS = 200;
export const REGISTRY_DIRECTORY = 'codex-dsh-desktop';
export const REGISTRY_FILE = 'workers.json';

export const LIMITS = Object.freeze({
  workerId: 128,
  sessionId: 256,
  role: 1024,
  customer: 80,
  purpose: 200,
  cwd: 4096,
  lastTask: 500
});
export const LIFECYCLES = Object.freeze(['active', 'archived']);

const errorText = (error) => error instanceof Error ? error.message : String(error);

/** Count Unicode code points, not UTF-16 code units. */
export function unicodeLength(value) {
  return [...value].length;
}

/** Truncate to a Unicode code-point budget and report whether anything was removed. */
export function truncateUnicode(value, max) {
  const text = String(value ?? '');
  const characters = [...text];
  return {
    text: characters.slice(0, max).join(''),
    truncated: characters.length > max
  };
}

function normalizedText(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`${name} must be non-empty.`);
  if (/[\u0000-\u001F\u007F]/.test(text)) throw new Error(`${name} must not contain control characters.`);
  if (unicodeLength(text) > max) throw new Error(`${name} must be at most ${max} Unicode characters.`);
  return text;
}

/** Validate and trim one customer label. */
export function normalizeCustomer(value) {
  return normalizedText(value, 'customer', LIMITS.customer);
}

/** Validate and trim one purpose summary. */
export function normalizePurpose(value) {
  return normalizedText(value, 'purpose', LIMITS.purpose);
}

/** Validate one lifecycle value. */
export function normalizeLifecycle(value) {
  if (!LIFECYCLES.includes(value)) {
    throw new Error(`lifecycle must be one of: ${LIFECYCLES.join(', ')}.`);
  }
  return value;
}

/** Validate only the metadata keys present in `input`; omitted keys stay unchanged. */
export function normalizeMetadata(input = {}) {
  const result = {};
  if (Object.hasOwn(input, 'customer')) result.customer = normalizeCustomer(input.customer);
  if (Object.hasOwn(input, 'purpose')) result.purpose = normalizePurpose(input.purpose);
  if (Object.hasOwn(input, 'lifecycle')) result.lifecycle = normalizeLifecycle(input.lifecycle);
  return result;
}

/** A stable, reportable failure while locating, reading, validating, or writing the worker registry. */
export class RegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/**
 * Resolve the registry path.
 *
 * The default remains `<profileContext.dir>/codex-dsh-desktop/workers.json` for
 * ordinary installs. A deployment may override it with `config.stateFile`
 * (this machine uses E:/APP/codex-dsh-desktop-data/workers.json); there is
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

/** Build the version-2 on-disk document from live worker records. */
export function createRegistryDocument(workers, { now = Date.now } = {}) {
  if (!Array.isArray(workers)) throw new TypeError('workers must be an array.');
  if (workers.length > MAX_WORKERS) {
    throw new RegistryError('LIMIT_EXCEEDED', `Worker registry has ${workers.length} records; the hard limit is ${MAX_WORKERS}.`);
  }
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date(now()).toISOString(),
    workers: workers.map((worker) => {
      const lastTask = worker.lastTask === null || worker.lastTask === undefined
        ? { text: null, truncated: false }
        : truncateUnicode(worker.lastTask, LIMITS.lastTask);
      return {
        workerId: worker.workerId,
        sessionId: worker.sessionId,
        role: worker.role,
        customer: worker.customer ?? null,
        purpose: worker.purpose ?? null,
        lifecycle: worker.lifecycle ?? 'active',
        workspaceId: worker.workspaceId ?? null,
        cwd: worker.cwd,
        createdAt: worker.createdAt,
        updatedAt: worker.updatedAt,
        taskCount: worker.taskCount,
        lastTask: lastTask.text,
        lastTaskTruncated: worker.lastTaskTruncated === true || lastTask.truncated
      };
    })
  };
}

function invalid(message, cause) {
  return new RegistryError('INVALID_RECORD', message, cause === undefined ? {} : { cause });
}

function requireString(value, name, workerId) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`Worker registry entry "${workerId}" has an invalid ${name}.`);
  return value;
}

function requireBounded(value, name, workerId, max) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`Worker registry entry "${workerId}" has an invalid ${name}.`);
  if (unicodeLength(value) > max) throw invalid(`Worker registry entry "${workerId}" has a ${name} longer than ${max} Unicode characters.`);
  return value;
}

function requireTimestamp(value, name, workerId) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid ${name} timestamp.`);
  }
  return value;
}

function registryMetadataText(value, name, workerId) {
  if (value === null || value === undefined) return null;
  try {
    return normalizedText(value, name, LIMITS[name]);
  } catch (error) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid ${name}: ${errorText(error)}`);
  }
}

function validateEntry(entry, index, seenWorkerIds, seenSessionIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalid(`Worker registry entry at index ${index} is not an object.`);
  }
  const workerId = requireBounded(entry.workerId, 'workerId', `#${index}`, LIMITS.workerId);
  const sessionId = requireBounded(entry.sessionId, 'sessionId', workerId, LIMITS.sessionId);
  const role = requireBounded(entry.role, 'role', workerId, LIMITS.role);
  requireTimestamp(entry.createdAt, 'createdAt', workerId);
  requireTimestamp(entry.updatedAt, 'updatedAt', workerId);
  if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) || unicodeLength(entry.cwd) > LIMITS.cwd) {
    throw invalid(`Worker registry entry "${workerId}" has an invalid cwd.`);
  }
  if (entry.workspaceId !== null && entry.workspaceId !== undefined && (typeof entry.workspaceId !== 'string' || !entry.workspaceId.trim() || unicodeLength(entry.workspaceId) > LIMITS.sessionId)) {
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
  if (entry.lastTaskTruncated !== undefined && typeof entry.lastTaskTruncated !== 'boolean') {
    throw invalid(`Worker registry entry "${workerId}" has an invalid lastTaskTruncated flag.`);
  }
  const lastTask = entry.lastTask === null || entry.lastTask === undefined
    ? { text: null, truncated: false }
    : truncateUnicode(entry.lastTask, LIMITS.lastTask);
  const customer = registryMetadataText(entry.customer, 'customer', workerId);
  const purpose = registryMetadataText(entry.purpose, 'purpose', workerId);
  let lifecycle = 'active';
  if (entry.lifecycle !== undefined) {
    try {
      lifecycle = normalizeLifecycle(entry.lifecycle);
    } catch (error) {
      throw invalid(`Worker registry entry "${workerId}" has an invalid lifecycle: ${errorText(error)}`);
    }
  }
  if (seenWorkerIds.has(workerId)) throw new RegistryError('CONFLICT', `Worker registry contains duplicate workerId "${workerId}".`);
  if (seenSessionIds.has(sessionId)) throw new RegistryError('CONFLICT', `Worker registry binds DSH session "${sessionId}" to more than one worker.`);
  seenWorkerIds.add(workerId);
  seenSessionIds.add(sessionId);
  return {
    workerId,
    sessionId,
    role,
    customer,
    purpose,
    lifecycle,
    workspaceId: entry.workspaceId ?? null,
    cwd: entry.cwd,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    taskCount: entry.taskCount,
    lastTask: lastTask.text,
    lastTaskTruncated: entry.lastTaskTruncated === true || lastTask.truncated
  };
}

/**
 * Validate a parsed registry document without touching disk. Version 1 is
 * upgraded in memory: lifecycle defaults to active, customer/purpose default to
 * null, and oversized lastTask values are truncated with an explicit flag.
 */
export function parseRegistryDocument(parsed, path = 'worker registry') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`Worker registry "${path}" must contain a JSON object.`);
  }
  if (parsed.version !== LEGACY_REGISTRY_VERSION && parsed.version !== REGISTRY_VERSION) {
    throw new RegistryError(
      'UNSUPPORTED_VERSION',
      `Worker registry "${path}" has version ${JSON.stringify(parsed.version)}; this plugin supports versions ${LEGACY_REGISTRY_VERSION} and ${REGISTRY_VERSION}. The file was left unchanged.`
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
 * Profile-scoped worker registry with versioned validation, v1-to-v2
 * normalization, atomic replacement, and serialized writes.
 */
export function createWorkerRegistry({ profileContext, stateFile, now = Date.now } = {}) {
  const path = resolveRegistryPath({ profileContext, stateFile });
  let writeTail = Promise.resolve();
  let loadedVersion = null;

  return {
    path,
    get loadedVersion() { return loadedVersion; },
    /** Load the persisted workers; a missing file is an empty registry, every other read failure is loud. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          loadedVersion = null;
          return [];
        }
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
      loadedVersion = parsed?.version ?? null;
      return parseRegistryDocument(parsed, path);
    },
    /**
     * Replace the registry with a version-2 snapshot. Writes are serialized in
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
