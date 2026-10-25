import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shanghaiClock } from './personal-namespace.js';

export const REVIEW_LIST_TITLE = '待审清单';
export { DEFAULT_VAULT_PATH } from './paths.js';
import { DEFAULT_VAULT_PATH } from './paths.js';
export const REVIEW_LIST_FILENAME = REVIEW_LIST_TITLE + '.md';

export class ReviewListError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewListError';
    this.code = code;
  }
}

let reviewChain = Promise.resolve();

/** Serialize review-list read/modify/write operations in this process. */
export function withReviewLock(task) {
  const run = reviewChain.then(task, task);
  reviewChain = run.catch(() => {});
  return run;
}

function toSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function withoutTrailingSlashes(value) {
  return toSlashes(value).replace(/\/+$/, '');
}

function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function projectPrefix(project) {
  return project ? String(project).replace(/[^a-zA-Z0-9]/g, '') + '/' : '';
}

/** The review list lives outside the Basic Memory vault, beside it. */
export function managementDirectory(config = {}) {
  const vault = path.resolve(withoutTrailingSlashes(config?.vaultPath || DEFAULT_VAULT_PATH));
  return path.join(path.dirname(vault), 'management');
}

export function reviewListPath(config = {}) {
  return path.join(managementDirectory(config), REVIEW_LIST_FILENAME);
}

export function safeReviewName(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 70);
}

/**
 * Resolve a real Basic Memory file_path to a local path. Absolute paths and
 * relative paths must stay inside the configured vault; symlinks that escape
 * it are rejected. Missing files still return a lexical path so size can be
 * reported as unknown; link creation validates existence separately.
 */
export async function reviewAbsolutePath(filePath, { vaultPath = '', project = '' } = {}) {
  let raw = toSlashes(filePath).trim();
  if (!raw) return '';
  const vault = path.resolve(withoutTrailingSlashes(vaultPath || DEFAULT_VAULT_PATH));
  let candidate;
  if (path.isAbsolute(raw)) {
    candidate = path.resolve(raw);
    if (!isInside(vault, candidate)) return '';
  } else {
    const prefix = projectPrefix(project);
    if (prefix && raw.startsWith(prefix)) raw = raw.slice(prefix.length);
    raw = raw.replace(/^\.?\//, '');
    if (!raw) return '';
    candidate = path.resolve(vault, raw);
    if (!isInside(vault, candidate)) return '';
  }
  try {
    const [vaultReal, candidateReal] = await Promise.all([fs.realpath(vault), fs.realpath(candidate)]);
    if (!isInside(vaultReal, candidateReal)) return '';
    return candidateReal;
  } catch {
    return candidate;
  }
}

function obsidianUri(absolutePath) {
  return 'obsidian://open?path=' + encodeURIComponent(toSlashes(absolutePath));
}

/**
 * Build a standard Markdown link to the real note through Obsidian's open
 * path URI. The path is verified to belong to the vault; when no real path is
 * available the caller says so instead of guessing a filename from permalink.
 */
export async function reviewLink(filePath, { vaultPath = '', project = '' } = {}) {
  const local = await reviewAbsolutePath(filePath, { vaultPath, project });
  if (!local) return '';
  try {
    const stat = await fs.stat(local);
    if (!stat.isFile()) return '';
  } catch {
    return '';
  }
  return '[打开原文](' + obsidianUri(local) + ')';
}

export function formatBytes(value) {
  if (value === null || value === undefined || value === '') return '未统计';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '未统计';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export async function fileSize(absolutePath) {
  if (!absolutePath) return null;
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export async function vaultCapacity(vaultPath, config = {}, statfs = fs.statfs) {
  const target = String(vaultPath || DEFAULT_VAULT_PATH);
  try {
    const stats = await statfs(target);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const minFree = Number(config.vaultMinFreeBytes) > 0 ? Number(config.vaultMinFreeBytes) : 2 * 1024 * 1024 * 1024;
    const ratio = Number(config.vaultMinFreeRatio) > 0 ? Number(config.vaultMinFreeRatio) : 0.01;
    const low = Number.isFinite(total) && total > 0 ? free < Math.max(minFree, total * ratio) : false;
    return { total, free, low, minFree, ratio };
  } catch {
    return { total: 0, free: 0, low: false, minFree: 0, ratio: 0 };
  }
}

export async function readReviewList(config = {}) {
  const file = reviewListPath(config);
  try {
    const content = await fs.readFile(file, 'utf8');
    return { path: file, exists: true, content };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: file, exists: false, content: '' };
    throw new ReviewListError('REVIEW_READ_FAILED', 'cannot read review list ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

/** Atomically replace the review list and verify the exact bytes on disk. */
export async function saveReviewList(config, content) {
  const file = reviewListPath(config);
  const directory = path.dirname(file);
  const temp = path.join(directory, '.' + path.basename(file) + '.' + process.pid + '.' + randomUUID() + '.tmp');
  const text = String(content ?? '');
  let handle = null;
  try {
    await fs.mkdir(directory, { recursive: true });
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
    const written = await fs.readFile(file, 'utf8');
    if (written !== text) throw new ReviewListError('REVIEW_WRITE_VERIFY_FAILED', 'review list readback differs from the content written');
    return { path: file, bytes: Buffer.byteLength(text, 'utf8'), content: text };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    if (error instanceof ReviewListError) throw error;
    throw new ReviewListError('REVIEW_WRITE_FAILED', 'cannot write review list ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function capacityLine(capacity, sampledAt) {
  return 'Vault 所在卷可用 ' + formatBytes(capacity?.free) + ' / ' + formatBytes(capacity?.total) + '；状态：' + (capacity?.low ? '不足' : '足够') + '；采样时间：' + (sampledAt || '未统计') + '。本轮不会据容量自动停用、归档或删除任何记忆。';
}

function reviewHeader(capacity, sampledAt) {
  const lines = [
    '# 待审清单',
    '',
    '> 本清单保存在 Vault 外的本地管理目录，不进入 Basic Memory 索引。',
    '> 提交待审本身不删除、不停用、不降权任何原文或附件；soften_memory 是单独的显式降权操作。',
    '> 请在 Obsidian 或资源管理器中查看原文后，再决定是否由你本人物理删除。',
    '> 归档和回收站不等于已释放磁盘空间。',
    '',
  ];
  if (capacity) {
    lines.push('## 容量状态', '', capacityLine(capacity, sampledAt), '');
  }
  lines.push('## 待审记录', '');
  return lines.join('\n');
}

function refreshReviewHeader(text, capacity, sampledAt) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('> Agent 只会提交人工审阅'));
  if (header >= 0) lines[header] = '> 提交待审本身不删除、不停用、不降权任何原文或附件；soften_memory 是单独的显式降权操作。';
  const capacityAt = lines.findIndex((line) => line.startsWith('Vault 所在卷可用'));
  if (capacityAt >= 0) lines[capacityAt] = capacityLine(capacity, sampledAt);
  return lines.join('\n');
}

function hasReviewEntry(content, { kind, scopeKey, title, target }) {
  return String(content ?? '').split(/\r?\n/).some((line) => {
    const cells = line.split(' | ');
    if (cells.length < 5) return false;
    return cells[1] === String(kind || 'record')
      && cells[2].startsWith(scopeKey + '：')
      && cells[3] === String(title || '').replace(/\s+/g, ' ')
      && cells[4] === target;
  });
}

async function appendReviewEntryUnlocked(ctx, { kind, title, reason, scope, bytes, filePath, clock, sampledAt }) {
  const scopeKey = String(scope || '整篇').trim();
  const link = await reviewLink(filePath, { vaultPath: ctx.vaultPath, project: ctx.project });
  const target = link || '（未取得真实文件路径，请在 Vault 中按标题查找）';
  const line = '- ' + clock.date + ' ' + clock.time + ' | ' + String(kind || 'record') + ' | ' + String(reason || '待人工审阅').replace(/\s+/g, ' ') + ' | ' + String(title || '').replace(/\s+/g, ' ') + ' | ' + target + ' | ' + formatBytes(bytes);
  const capacity = await vaultCapacity(ctx.vaultPath, ctx.config);
  const current = await readReviewList(ctx);
  if (hasReviewEntry(current.content, { kind, scopeKey, title, target })) {
    return { updated: false, path: current.path, bytes: Buffer.byteLength(current.content, 'utf8') };
  }
  const body = current.content.trim() ? refreshReviewHeader(current.content, capacity, sampledAt) : reviewHeader(capacity, sampledAt);
  const content = body.replace(/\s+$/, '') + '\n' + line + '\n';
  const written = await saveReviewList(ctx, content);
  return { updated: true, path: written.path, bytes: written.bytes };
}

export async function appendReviewEntry(ctx, { kind, title, permalink, reason, scope = '整篇', bytes = null, filePath = '', now = () => new Date() }) {
  const clock = shanghaiClock(typeof now === 'function' ? now() : now);
  const sampledAt = clock.date + ' ' + clock.time + ' Asia/Shanghai';
  return withReviewLock(() => appendReviewEntryUnlocked(ctx, {
    kind,
    title,
    reason,
    scope,
    bytes,
    filePath,
    clock,
    sampledAt,
  }));
}
