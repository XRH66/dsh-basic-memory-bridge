import path from 'node:path';
import { createHash } from 'node:crypto';
import { wikiLinks, factValue, memoryCall } from './navigation.js';
import { formatRecordedAt } from './dates.js';

export const AUTO_START = '<!-- dsh-index:auto -->';
export const AUTO_END = '<!-- /dsh-index:auto -->';
export const canonical = (s) => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const topicKey = (title) => createHash('sha256').update(canonical(title)).digest('hex');
export const topicTitle = (s) => typeof s === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ·（）()&_-]{0,39}$/u.test(s.trim()) ? s.trim() : '';

export function refers(link, note) {
  return [note.title, note.permalink, String(note.permalink).replace(/^[^/]+\//, ''), String(note.file_path || '').replace(/\.md$/i, '')]
    .some((v) => v && canonical(link.target) === canonical(v));
}
export function rowRefers(row, note) {
  const marker = /<!-- bm:([^ ]+) -->/.exec(row);
  if (marker) return marker[1] === encodeURIComponent(note.permalink);
  const links = wikiLinks(row);
  return links.length === 1 && refers(links[0], note);
}
function row(note, config, summary = factValue(note)) {
  let file = String(note.file_path || '').replace(/\\/g, '/');
  if (file && (path.isAbsolute(file) || /^[A-Za-z]:\//.test(file))) {
    file = path.relative(config.vaultPath, file).replace(/\\/g, '/');
  }
  if (!file || file.startsWith('../') || /[\[\]\n\r|#]/.test(file)) file = note.title;
  const target = file.replace(/\.md$/i, '');
  const label = String(note.title).replace(/[\[\]\n\r|]/g, ' ');
  const text = String(summary || '').replace(/[\r\n]/g, ' ').replace(/<!--/g, '').slice(0, 240);
  return '- [[' + target + (target === label ? '' : '|' + label) + ']]' + (text ? ' —— ' + text : '') + ' <!-- bm:' + encodeURIComponent(note.permalink) + ' -->';
}

/** Refresh existing link rows in place; only new references enter the auto region. */
export function updateIndexBody(body, { refresh = [], add = [], remove = [], config = {}, at = new Date().toISOString() } = {}) {
  const text = String(body);
  const starts = text.split(AUTO_START), ends = text.split(AUTO_END);
  if (starts.length !== ends.length || starts.length > 2) throw new Error('INVALID_INDEX_REGION');
  const start = text.indexOf(AUTO_START), end = text.indexOf(AUTO_END);
  if (start >= 0 && end < start) throw new Error('INVALID_INDEX_REGION');
  let before = start < 0 ? text : text.slice(0, start);
  let after = start < 0 ? '' : text.slice(end + AUTO_END.length);
  const original = start < 0 ? '' : text.slice(start + AUTO_START.length, end);
  let lines = original.split('\n').filter((s) => s.trim() && !/^## 自动整理$|^- (?:创建日期|更新日期):/.test(s));
  let changed = false;
  let outsideChanged = false;
  function refreshInPlace(part) {
    return part.split('\n').flatMap(line => {
      if (!/^- \[\[/.test(line) || wikiLinks(line).length !== 1) return [line];
      if (remove.some(n => rowRefers(line, n))) { outsideChanged = true; return []; }
      const note = refresh.find(n => rowRefers(line, n));
      if (!note) return [line];
      const next = row(note, config, note.indexSummary);
      if (next !== line) outsideChanged = true;
      return [next];
    }).join('\n');
  }
  before = refreshInPlace(before);
  after = refreshInPlace(after);
  lines = lines.filter((line) => {
    if (remove.some((n) => rowRefers(line, n))) { changed = true; return false; }
    return true;
  }).map((line) => {
    const note = refresh.find((n) => rowRefers(line, n));
    if (!note) return line;
    const next = row(note, config, note.indexSummary);
    if (next !== line) changed = true;
    return next;
  });
  for (const note of add) {
    if ([...lines, ...before.split('\n'), ...after.split('\n')].some((line) => rowRefers(line, note))) continue;
    lines.push(row(note, config, note.indexSummary)); changed = true;
  }
  if (!changed) return outsideChanged ? before + (start < 0 ? '' : AUTO_START + original + AUTO_END + after) : text;
  const date = formatRecordedAt(at);
  const created = /^- 创建日期:\s*(.+)$/m.exec(original)?.[1] || (start < 0 ? date : '日期未明');
  const block = [AUTO_START, '## 自动整理', '- 创建日期: ' + created, '- 更新日期: ' + date, '', ...lines, AUTO_END].join('\n');
  return before.trimEnd() + '\n\n' + block + (after || '\n');
}

export async function saveIndexBody(ctx, note, content) {
  if (content === note.content) return false;
  if (!note.checksum) throw new Error('MISSING_CHECKSUM');
  await memoryCall(ctx, 'edit_note', { identifier: note.permalink, operation: 'find_replace', find_text: note.content, content, expected_replacements: 1, expected_checksum: note.checksum });
  const fresh = await memoryCall(ctx, 'read_note', { identifier: note.permalink, include_content: true });
  if (fresh.content !== content) throw new Error('INDEX_READBACK_MISMATCH');
  Object.assign(note, fresh);
  return true;
}

export async function ensureIndexPage(ctx, title, indexes, at) {
  const matches = indexes.filter((n) => canonical(n.title) === canonical(title));
  if (matches.length > 1) throw new Error('AMBIGUOUS_INDEX_TITLE');
  if (matches.length) return matches[0];
  // Stable title + non-overwrite makes a lost write response recoverable on the next catalog read.
  const written = await memoryCall(ctx, 'write_note', {
    title, directory: 'index', content: '# ' + title + '\n', tags: ['index', 'moc'], overwrite: false,
    metadata: { index_topic_key: topicKey(title), index_created_at: at, status: 'active' },
  });
  const fresh = await memoryCall(ctx, 'read_note', { identifier: written.permalink, include_content: true });
  if (canonical(fresh.title) !== canonical(title) || !String(fresh.permalink).startsWith(ctx.config.project + '/index/')) throw new Error('INDEX_CREATE_READBACK_MISMATCH');
  indexes.push(fresh);
  return fresh;
}

/** Explicit requests lower the threshold only for a directly named topic. */
export function requestedIndexTopic(text) {
  const s = String(text).trim();
  if (s.length > 160 || /[“”"「」]|不要|不用|别|不必|假如|例如|比如|举例/.test(s)) return '';
  const match = /^(?:请|帮我|请帮我)?\s*(?:给|把)\s*(.{1,30}?)\s*(?:单独|独立)?\s*(?:建(?:立)?(?:一?个)?|新建(?:一?个)?|整理(?:成)?)\s*(?:主题)?索引[。！!]?$/u.exec(s);
  return match ? topicTitle(match[1]) : '';
}
