import { readdir, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.dsh', '.omx', '.next', '.nuxt', '.turbo', '.cache',
  'node_modules', 'vendor', 'dist', 'build', 'coverage', 'out'
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function workspacePath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/') || '.';
}

async function walk(root, current, entries, scan, limits) {
  if (scan.truncated) return;
  if (scan.directories >= limits.maxDirectories) {
    scan.complete = false;
    scan.truncated = true;
    return;
  }
  scan.directories += 1;
  let children;
  try {
    children = await readdir(current, { withFileTypes: true });
  } catch (error) {
    recordFailure(scan, workspacePath(root, current), error);
    return;
  }

  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (scan.truncated) return;
    if (child.isSymbolicLink()) continue;
    const absolutePath = join(current, child.name);
    if (child.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(child.name)) await walk(root, absolutePath, entries, scan, limits);
      continue;
    }
    if (!child.isFile()) continue;
    if (entries.size >= limits.maxEntries) {
      scan.complete = false;
      scan.truncated = true;
      return;
    }

    try {
      // lstat prevents following a file replaced with a symlink during traversal.
      const file = await lstat(absolutePath);
      if (!file.isFile()) continue;
      entries.set(workspacePath(root, absolutePath), `${file.size}:${file.mtimeMs}`);
    } catch (error) {
      recordFailure(scan, workspacePath(root, absolutePath), error);
    }
  }
}

function recordFailure(scan, path, error) {
  scan.complete = false;
  scan.errorCount += 1;
  if (scan.errors.length < 10) scan.errors.push({ path, code: error?.code ?? 'SCAN_ERROR' });
}

export async function captureWorkspaceSnapshot(root, { maxEntries = 5000, maxDirectories = 1000 } = {}) {
  const limits = {
    maxEntries: positiveInteger(maxEntries, 'maxEntries'),
    maxDirectories: positiveInteger(maxDirectories, 'maxDirectories')
  };
  const entries = new Map();
  const scan = { complete: true, truncated: false, directories: 0, errorCount: 0, errors: [] };
  // Keep the Map API used by the resident-session manager, while preserving coverage information.
  Object.defineProperty(entries, 'scan', { value: scan });
  await walk(root, root, entries, scan, limits);
  return entries;
}

export async function describeWorkspaceChanges(root, previousSnapshot, { maxPaths = 80, ...scanOptions } = {}) {
  positiveInteger(maxPaths, 'maxPaths');
  const current = await captureWorkspaceSnapshot(root, scanOptions);
  const previous = previousSnapshot instanceof Map ? previousSnapshot : new Map();
  const baselineComplete = previous.scan?.complete !== false;
  const added = [];
  const modified = [];
  const removed = [];

  for (const [path, signature] of current) {
    if (!previous.has(path)) {
      if (baselineComplete) added.push(path);
    } else if (previous.get(path) !== signature) modified.push(path);
  }
  // Incomplete traversal cannot distinguish an unread path from a deletion.
  if (current.scan.complete && baselineComplete) {
    for (const path of previous.keys()) {
      if (!current.has(path)) removed.push(path);
    }
  }

  const all = [...added.map((path) => `+ ${path}`), ...modified.map((path) => `~ ${path}`), ...removed.map((path) => `- ${path}`)];
  const warnings = [];
  if (!baselineComplete) warnings.push('基线扫描不完整；不根据未观察到的路径推断新增或删除。');
  if (!current.scan.complete) {
    const detail = current.scan.truncated ? '达到扫描上限。' : '部分元数据无法读取。';
    const failures = current.scan.errors.map(({ path, code }) => `${path} (${code})`).join(', ');
    warnings.push(`当前工作区扫描不完整。${detail}不推断删除。${failures ? `未读取到的路径：${failures}。` : ''}${current.scan.errorCount > current.scan.errors.length ? `另有 ${current.scan.errorCount - current.scan.errors.length} 个扫描失败。` : ''}`);
  }
  const shown = all.slice(0, maxPaths);
  const remainder = all.length - shown.length;
  const summary = all.length || warnings.length
    ? [
      '自本 worker 上次派工以来（不是上次完成以来）的工作区文件元数据变化：',
      ...warnings,
      ...shown,
      ...(remainder ? [`……另有 ${remainder} 个路径未显示`] : []),
      '本扫描只比较文件大小与修改时间，不能证明文件内容未变。动手前请读取相关工作区文件并查看 git diff。'
    ].join('\n')
    : '';
  return { added, modified, removed, snapshot: current, summary };
}
