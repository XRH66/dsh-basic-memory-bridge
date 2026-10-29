/**
 * Durable factual memory: independently revisable fact/event notes and their
 * retained history. No forget channel is implemented.
 */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { clipText, collapseWhitespace } from './text.js';
import { toolFailureText, unwrapToolValue } from './mcp.js';
import { executeScopedTool } from './tool-call.js';
import { withCommitLock } from './coordinator.js';
import { invalidateTimeline } from './timeline.js';
import { carryPriority, priorityFromMetadata, softenPriorityPatch, reinforcePriorityPatch } from './priority.js';
import { PERSONAL_KINDS, isPersonalPermalink, personalRecordPath, shanghaiClock } from './personal-namespace.js';
import { stripFrontmatter, reinforcePersonalEntry } from './records.js';
import { DATE_UNKNOWN, formatRecordedAt } from './dates.js';
import { wantsHistory } from './history-intent.js';


export const MEMORY_MARKER = '<!-- dsh-fact-memory -->';
const CONTENT_CHANGE_KEYS = ['content_changed_at', 'content_changed_session_id', 'content_changed_message_id', 'content_change_action', 'content_change_time_kind'];
export const MEMORY_TAG = 'dsh-memory';
export const HISTORY_TAG = 'dsh-history';
export const MEMORY_KINDS = Object.freeze(['fact', 'event', 'history']);
export const MEMORY_STATUS = Object.freeze({ active: 'active', history: 'history' });

const KIND_DIRS = Object.freeze({ fact: 'facts', event: 'events', history: 'history' });
const MAX_CAPTURE_ACTIONS = 5;
const MAX_CANDIDATE_CHARS = 380;
const MAX_SEARCH_CANDIDATES = 20;
const MAX_LIST_CANDIDATES = 60;
const MAX_TITLE_CHARS = 80;
const MAX_EVENT_SUMMARY_CHARS = 48;
const MAX_FORGET_NOTES = 1000;
const OCCURRED_RE = /^(?:\d{4}-\d{2}(?:-\d{2})?|日期未明)$/;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function memoryFolder(config) {
  const raw = String(config?.captureFolder ?? 'chats').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return 'chats';
  return parts.join('/');
}

export function memoryDirectory(config, kind) {
  const dir = KIND_DIRS[kind];
  if (!dir) throw new MemoryError('INVALID_MEMORY_KIND', 'unsupported memory kind: ' + kind);
  return memoryFolder(config) + '/' + dir;
}

export function sanitizeMemoryTitle(value) {
  let title = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trim();
  return title;
}

export function isValidOccurredAt(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '日期未明') return true;
  if (/^\d{4}-\d{2}$/.test(text)) {
    const month = Number(text.slice(5));
    return month >= 1 && month <= 12;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeOccurredAt(value) {
  const text = String(value ?? '').trim();
  if (!text || !OCCURRED_RE.test(text) || !isValidOccurredAt(text)) return '日期未明';
  return text;
}

function shanghaiParts(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
    stamp: parts.year + parts.month + parts.day + parts.hour + parts.minute + parts.second,
    iso: date.toISOString(),
  };
}

function sourceDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sourceTimeAnchor(value) {
  const date = sourceDate(value);
  if (!date) return '';
  const clock = shanghaiClock(date);
  return clock.date + ' ' + clock.time + ' Asia/Shanghai';
}

function sourceTimeIso(value) {
  const date = sourceDate(value);
  return date ? date.toISOString() : '';
}

function memoryTitle({ kind, action, occurredAt }) {
  if (kind === 'event') {
    const summary = clipText(collapseWhitespace(action.eventSummary ?? action.value ?? action.title ?? ''), MAX_EVENT_SUMMARY_CHARS);
    return sanitizeMemoryTitle(occurredAt + ' - ' + (summary || '未命名事件'));
  }
  const title = String(action.title ?? '').trim();
  const scopedTitle = text => sanitizeMemoryTitle(text + (action.requirementScope && action.requirementScope !== 'general' ? ' · ' + action.requirementScope : ''));
  if (title) return scopedTitle(title);
  const subject = String(action.subject ?? '').trim();
  const attribute = String(action.attribute ?? '').trim();
  if (subject && attribute) return scopedTitle(subject + ' - ' + attribute);
  if (subject) return scopedTitle(subject);
  return scopedTitle(action.value ?? '未命名事实');
}

function memoryBody({ kind, category, title, value, subject, attribute, occurredAt, recordedAt, validFrom, validUntil, timeExpression, timeAnchor, sourceEventTime, requirementScope, historyTitle }) {
  const lines = [MEMORY_MARKER, '# ' + title, ''];
  if (kind === 'history') {
    lines.push('- [history] ' + value);
    lines.push('- 发生日期: ' + (occurredAt || DATE_UNKNOWN));
    if (validFrom) lines.push('- valid_from: ' + validFrom);
    if (validUntil) lines.push('- valid_until: ' + validUntil);
    if (subject) lines.push('- subject: ' + subject);
    if (attribute) lines.push('- attribute: ' + attribute);
  } else if (kind === 'event') {
    lines.push('- [event] ' + value);
    lines.push('- 发生日期: ' + (occurredAt || DATE_UNKNOWN));
  } else {
    lines.push('- [' + category + '] ' + value);
    if (subject) lines.push('- subject: ' + subject);
    if (attribute) lines.push('- attribute: ' + attribute);
    lines.push('- 发生日期: ' + (occurredAt || DATE_UNKNOWN));
  }
  lines.push('- 记录日期: ' + formatRecordedAt(recordedAt));
  if (requirementScope) lines.push('- 适用范围: ' + requirementScope);
  if (historyTitle) lines.push('- 历史证据: [[' + sanitizeMemoryTitle(historyTitle) + ']]');
  if (timeExpression) lines.push('- time_expression: ' + timeExpression);
  if (timeAnchor) lines.push('- time_anchor: ' + timeAnchor);
  if (sourceEventTime) lines.push('- source_event_time: ' + sourceEventTime);
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * Parse the managed fact block from a note body. The body, not frontmatter,
 * is the authority for value/subject/attribute/dates. Everything outside the
 * managed block is user content and must survive later edits.
 */
export function parseMemoryContent(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === MEMORY_MARKER);
  if (markerIndex < 0) return null;
  let index = markerIndex + 1;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  let title = '';
  if (String(lines[index] ?? '').startsWith('# ')) {
    title = String(lines[index]).slice(2).trim();
    index += 1;
  }
  const fields = { category: '', value: '', subject: '', attribute: '', occurredAt: '', recordedAt: '', validFrom: '', validUntil: '', timeExpression: '', timeAnchor: '', sourceEventTime: '', requirementScope: '', historyTitle: '' };
  const tail = [];
  let lastManaged = markerIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    let match = /^- \[([^\]]*)\]\s*(.*)$/.exec(line);
    if (match) {
      fields.category = match[1].trim();
      fields.value = match[2];
      lastManaged = index;
      continue;
    }
    match = /^- subject:\s*(.*)$/i.exec(line);
    if (match) { fields.subject = match[1].trim(); lastManaged = index; continue; }
    match = /^- attribute:\s*(.*)$/i.exec(line);
    if (match) { fields.attribute = match[1].trim(); lastManaged = index; continue; }
    match = /^- 发生日期:\s*(.*)$/.exec(line);
    if (match) { fields.occurredAt = match[1].trim(); lastManaged = index; continue; }
    match = /^- 记录日期:\s*(.*)$/.exec(line);
    if (match) { fields.recordedAt = match[1].trim(); lastManaged = index; continue; }
    match = /^- 适用范围:\s*(.*)$/.exec(line);
    if (match) { fields.requirementScope = match[1].trim(); lastManaged = index; continue; }
    match = /^- 历史证据:\s*\[\[(.*)\]\]\s*$/.exec(line);
    if (match) { fields.historyTitle = match[1].trim(); lastManaged = index; continue; }
    match = /^- valid_from:\s*(.*)$/i.exec(line);
    if (match) { fields.validFrom = match[1].trim(); lastManaged = index; continue; }
    match = /^- valid_until:\s*(.*)$/i.exec(line);
    if (match) { fields.validUntil = match[1].trim(); lastManaged = index; continue; }
    match = /^- time_expression:\s*(.*)$/i.exec(line);
    if (match) { fields.timeExpression = match[1].trim(); lastManaged = index; continue; }
    match = /^- time_anchor:\s*(.*)$/i.exec(line);
    if (match) { fields.timeAnchor = match[1].trim(); lastManaged = index; continue; }
    match = /^- source_event_time:\s*(.*)$/i.exec(line);
    if (match) { fields.sourceEventTime = match[1].trim(); lastManaged = index; continue; }
    tail.push(line);
  }
  return {
    title,
    ...fields,
    value: fields.value,
    tail: tail.join('\n').replace(/^\n+|\n+$/g, ''),
    markerIndex,
    lastManaged,
    lines,
  };
}

function managedBlockOf(content) {
  const parsed = parseMemoryContent(content);
  if (!parsed) return null;
  const blockLines = parsed.lines.slice(parsed.markerIndex, parsed.lastManaged + 1);
  const displaced = [];
  for (let index = 1; index < blockLines.length; index += 1) {
    const line = blockLines[index];
    if (!line.trim()) continue;
    if (line.startsWith('# ')) continue;
    if (/^-(?: \[[^\]]*\]| subject:| attribute:| 发生日期:| 记录日期:| 适用范围:| 历史证据:| valid_from:| valid_until:| time_expression:| time_anchor:| source_event_time:)/i.test(line)) continue;
    displaced.push(line);
  }
  return { block: blockLines.join('\n').trimEnd(), displaced };
}

function contentWithoutMarker(content) {
  return String(content ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== MEMORY_MARKER)
    .join('\n')
    .trim();
}

function rawList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function stringList(value) {
  return rawList(value)
    .map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item)))
    .filter(Boolean);
}

function noteFrontmatter(payload) {
  if (payload?.frontmatter && typeof payload.frontmatter === 'object') return payload.frontmatter;
  if (payload?.metadata && typeof payload.metadata === 'object') return payload.metadata;
  return {};
}

function noteMetadata(payload) {
  const meta = noteFrontmatter(payload);
  return {
    memoryId: String(meta.memory_id ?? ''),
    kind: String(meta.memory_kind ?? ''),
    status: String(meta.status ?? ''),
    subject: String(meta.subject ?? ''),
    attribute: String(meta.attribute ?? ''),
    requirementScope: String(meta.requirement_scope ?? ''),
    value: String(meta.value ?? ''),
    occurredAt: String(meta.occurred_at ?? ''),
    title: String(payload?.title ?? ''),
    sources: stringList(meta.sources),
    sourceSessionId: String(meta.source_session_id ?? ''),
    sourceTurn: Number(meta.source_turn ?? 0) || 0,
    supersedes: String(meta.supersedes_memory_id ?? ''),
    recordedAt: String(meta.recorded_at ?? ''),
    validFrom: String(meta.valid_from ?? ''),
    validUntil: String(meta.valid_until ?? ''),
    timeExpression: String(meta.time_expression ?? ''),
    timeAnchor: String(meta.time_anchor ?? ''),
    sourceEventTime: String(meta.source_event_time ?? ''),
    basePriority: Number(meta.base_priority ?? 1) || 1,
    softenedAt: String(meta.softened_at ?? ''),
    halfLifeDays: Number(meta.half_life_days ?? 30) || 30,
    priorityFloor: Number(meta.priority_floor ?? 0.01) || 0.01,
    softenCount: Number(meta.soften_count ?? 0) || 0,
  };
}

function parseSourceList(value) {
  return rawList(value).map((item) => {
    if (item && typeof item === 'object') return item;
    try {
      const parsed = JSON.parse(String(item));
      return parsed && typeof parsed === 'object' ? parsed : { session_id: String(item) };
    } catch {
      return { session_id: String(item) };
    }
  });
}

function memoryMetadata({
  memoryId,
  kind,
  status,
  subject,
  attribute,
  value,
  occurredAt,
  recordedAt,
  sessionId,
  turn,
  messageId,
  eventSeq,
  sources,
  previous,
  supersedes,
  validFrom,
  validUntil,
  timeExpression,
  timeAnchor,
  sourceEventTime,
  basePriority,
  softenedAt,
  halfLifeDays,
  priorityFloor,
  softenCount,
  softenFactor,
  softenReason,
  contentChange,
  requirementScope,
  historyPermalink,
  historyTitle,
}) {
  const meta = {
    source: 'dsh',
    source_plugin: 'dsh-basic-memory-bridge',
    memory_id: memoryId,
    memory_kind: kind,
    status,
    subject: String(subject ?? ''),
    attribute: String(attribute ?? ''),
    value: String(value ?? ''),
    occurred_at: String(occurredAt ?? ''),
    recorded_at: String(previous?.recorded_at ?? recordedAt ?? new Date().toISOString()),
    updated_at: new Date().toISOString(),
    source_session_id: String(previous?.source_session_id ?? sessionId ?? ''),
    source_turn: String(previous?.source_turn ?? turn ?? ''),
    source_message_id: String(previous?.source_message_id ?? messageId ?? ''),
    source_event_seq: String(previous?.source_event_seq ?? eventSeq ?? ''),
    sources: JSON.stringify(Array.isArray(sources) ? sources : []),
  };
  for (const key of CONTENT_CHANGE_KEYS) {
    if (previous?.[key] !== undefined) meta[key] = previous[key];
  }
  if (contentChange) Object.assign(meta, {
    content_changed_at: contentChange.at,
    content_changed_session_id: contentChange.session_id,
    content_changed_message_id: contentChange.message_id,
    content_change_action: contentChange.action,
    content_change_time_kind: contentChange.time_kind,
  });
  const prioritySource = carryPriority(previous);
  if (basePriority !== undefined) prioritySource.base_priority = basePriority;
  if (softenedAt !== undefined) prioritySource.softened_at = softenedAt;
  if (halfLifeDays !== undefined) prioritySource.half_life_days = halfLifeDays;
  if (priorityFloor !== undefined) prioritySource.priority_floor = priorityFloor;
  if (softenCount !== undefined) prioritySource.soften_count = softenCount;
  if (softenFactor !== undefined) prioritySource.soften_factor = softenFactor;
  if (softenReason !== undefined) prioritySource.soften_reason = softenReason;
  if (Object.keys(prioritySource).length > 0) {
    Object.assign(meta, prioritySource);
    const priority = priorityFromMetadata(prioritySource);
    meta.base_priority = priority.basePriority;
    meta.softened_at = priority.softenedAt;
    meta.half_life_days = priority.halfLifeDays;
    meta.priority_floor = priority.priorityFloor;
    meta.soften_count = priority.softenCount;
    if (prioritySource.soften_factor !== undefined) meta.soften_factor = prioritySource.soften_factor;
    if (prioritySource.soften_reason !== undefined) meta.soften_reason = prioritySource.soften_reason;
  }
  if (supersedes) meta.supersedes_memory_id = supersedes;
  const scope = String(requirementScope ?? previous?.requirement_scope ?? '').trim();
  if (scope) meta.requirement_scope = scope;
  const history = historyPermalink ?? previous?.latest_history_permalink;
  const historyLabel = historyTitle ?? previous?.latest_history_title;
  if (history) meta.latest_history_permalink = history;
  if (historyLabel) meta.latest_history_title = historyLabel;
  if (validFrom) meta.valid_from = String(validFrom);
  if (validUntil) meta.valid_until = String(validUntil);
  const timeExpressionValue = String(timeExpression ?? previous?.time_expression ?? '').trim();
  const timeAnchorValue = String(timeAnchor ?? previous?.time_anchor ?? '').trim();
  const sourceEventTimeValue = String(sourceEventTime ?? previous?.source_event_time ?? '').trim();
  if (timeExpressionValue) meta.time_expression = timeExpressionValue;
  if (timeAnchorValue) meta.time_anchor = timeAnchorValue;
  if (sourceEventTimeValue) meta.source_event_time = sourceEventTimeValue;
  return meta;
}

function listArgs(directory, { page = 1, pageSize = 100 } = {}) {
  return {
    dir_name: directory,
    depth: 1,
    page,
    page_size: pageSize,
    sort: 'updated_desc',
    output_format: 'json',
  };
}

function nodesOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.nodes)) return payload.nodes;
  if (Array.isArray(payload?.files)) return payload.files;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function hasMore(payload, nodes, pageSize) {
  if (typeof payload?.has_more === 'boolean') return payload.has_more;
  return nodes.length >= pageSize;
}

async function callMemory(ctx, tool, args) {
  if (!ctx?.tools || typeof ctx.tools.get !== 'function') {
    throw new MemoryError('MEMORY_UNAVAILABLE', 'Basic Memory tools are not available in this session');
  }
  const result = await executeScopedTool({
    tools: ctx.tools,
    name: 'mcp__basic_memory__' + tool,
    args,
    agent: ctx.agent,
    signal: ctx.signal,
  });
  if (!result || result.isError === true) {
    throw new MemoryError('MEMORY_ERROR', tool + ' failed: ' + toolFailureText(result));
  }
  const payload = unwrapToolValue(result);
  if (payload === null || payload === undefined) {
    throw new MemoryError('MEMORY_ERROR', tool + ' returned no payload');
  }
  if (payload && typeof payload === 'object' && payload.error) {
    throw new MemoryError('MEMORY_ERROR', tool + ' failed: ' + String(payload.error));
  }
  return payload;
}

export function assertMemoryVisible(ctx, names) {
  if (!ctx?.agent || !ctx?.tools || typeof ctx.tools.get !== 'function') {
    throw new MemoryError('MEMORY_UNAVAILABLE', 'Basic Memory tools are not available in this session');
  }
  for (const name of names) {
    let definition;
    try {
      definition = ctx.tools.get('mcp__basic_memory__' + name, ctx.agent);
    } catch {
      definition = null;
    }
    if (!definition || typeof definition.execute !== 'function') {
      throw new MemoryError('MEMORY_UNAVAILABLE', 'Basic Memory tool is not visible in this session: ' + name);
    }
  }
}

export async function readMemoryNote(ctx, identifier) {
  return callMemory(ctx, 'read_note', {
    identifier,
    project: ctx.project,
    include_content: true,
    include_frontmatter: true,
    output_format: 'json',
  });
}

async function listPage(ctx, directory, page, pageSize) {
  const payload = await callMemory(ctx, 'list_directory', { ...listArgs(directory, { page, pageSize }), project: ctx.project || ctx.config.project });
  return { payload, nodes: nodesOf(payload) };
}

export async function listAllNotes(ctx, directory, { maxNotes = MAX_FORGET_NOTES } = {}) {
  const out = [];
  const pageSize = 100;
  for (let page = 1; page <= 10 && out.length < maxNotes; page += 1) {
    const { payload, nodes } = await listPage(ctx, directory, page, pageSize);
    const files = nodes.filter((node) => node && node.type !== 'directory' && node.permalink);
    out.push(...files);
    if (!hasMore(payload, nodes, pageSize) || files.length === 0) break;
  }
  return out.slice(0, maxNotes);
}

async function listNodes(ctx, directory, limit = MAX_LIST_CANDIDATES) {
  const payload = await callMemory(ctx, 'list_directory', { ...listArgs(directory, { pageSize: limit }), project: ctx.project || ctx.config.project });
  return nodesOf(payload).filter((node) => node && node.type !== 'directory' && node.permalink).slice(0, limit);
}

async function writeNote(ctx, args) {
  const result = await executeScopedTool({
    tools: ctx.tools,
    name: 'mcp__basic_memory__write_note',
    args,
    agent: ctx.agent,
    signal: ctx.signal,
  });
  if (result && result.isError === true) {
    const text = toolFailureText(result);
    if (/checksum|conflict|modified/i.test(text)) return { conflict: true, payload: { error: text } };
    throw new MemoryError('MEMORY_ERROR', 'write_note failed: ' + text);
  }
  const payload = unwrapToolValue(result);
  if (payload?.action === 'conflict' || (payload?.error && /checksum|conflict|modified/i.test(String(payload.error)))) {
    return { conflict: true, payload };
  }
  if (payload?.error || !payload?.permalink) throw new MemoryError('MEMORY_ERROR', 'write_note failed: ' + String(payload?.error || 'missing permalink'));
  invalidateTimeline(ctx.config);
  return { conflict: false, payload: payload ?? {} };
}

async function editNote(ctx, args) {
  const result = await executeScopedTool({
    tools: ctx.tools,
    name: 'mcp__basic_memory__edit_note',
    args,
    agent: ctx.agent,
    signal: ctx.signal,
  });
  if (result && result.isError === true) {
    const text = toolFailureText(result);
    if (/checksum|conflict|modified|not found|no match|multiple/i.test(text)) {
      return { conflict: true, payload: { error: text } };
    }
    throw new MemoryError('MEMORY_ERROR', 'edit_note failed: ' + text);
  }
  const payload = unwrapToolValue(result);
  if (payload?.action === 'conflict' || (payload?.error && /checksum|conflict|modified|not found|no match|multiple/i.test(String(payload.error)))) {
    return { conflict: true, payload };
  }
  if (payload?.error || !payload) throw new MemoryError('MEMORY_ERROR', 'edit_note failed: ' + String(payload?.error || 'empty result'));
  invalidateTimeline(ctx.config);
  return { conflict: false, payload: payload ?? {} };
}

async function searchNotes(ctx, query, pageSize = MAX_SEARCH_CANDIDATES) {
  if (!query) return [];
  try {
    const payload = await callMemory(ctx, 'search_notes', {
      query,
      project: ctx.project,
      page_size: pageSize,
      output_format: 'json',
      search_type: 'hybrid',
      min_similarity: 0.0,
      tags: [MEMORY_TAG],
    });
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    return items;
  } catch {
    return [];
  }
}

function isMemoryPermalink(permalink) {
  return /\/(?:facts|events|history)\//i.test(String(permalink ?? ''));
}

async function hydrateMemory(payload, node) {
  if (!payload || payload.error) return null;
  const meta = noteMetadata(payload);
  if (!meta.memoryId) return null;
  const content = String(payload.content ?? '');
  const body = parseMemoryContent(content);
  return {
    memoryId: meta.memoryId,
    kind: meta.kind,
    status: meta.status,
    subject: body?.subject || meta.subject,
    attribute: body?.attribute || meta.attribute,
    requirementScope: body?.requirementScope || meta.requirementScope,
    value: body?.value || meta.value,
    occurredAt: body?.occurredAt || meta.occurredAt,
    recordedAt: meta.recordedAt || body?.recordedAt || '',
    validFrom: body?.validFrom || meta.validFrom,
    validUntil: body?.validUntil || meta.validUntil,
    timeExpression: body?.timeExpression || meta.timeExpression,
    timeAnchor: body?.timeAnchor || meta.timeAnchor,
    sourceEventTime: body?.sourceEventTime || meta.sourceEventTime,
    title: body?.title || String(payload.title ?? node?.title ?? ''),
    permalink: String(payload.permalink ?? node?.permalink ?? ''),
    checksum: String(payload.checksum ?? ''),
    filePath: String(payload.file_path ?? ''),
    content,
    metadata: noteFrontmatter(payload),
    meta,
    priority: priorityFromMetadata(noteFrontmatter(payload)),
    sources: parseSourceList(meta.sources),
  };
}

async function readCandidate(ctx, node) {
  if (!node?.permalink || !isMemoryPermalink(node.permalink)) return null;
  try {
    return await hydrateMemory(await readMemoryNote(ctx, node.permalink), node);
  } catch (error) {
    if (ctx.strictReads) throw error;
    return null;
  }
}

export async function loadCaptureCandidates(ctx, query) {
  const byPermalink = new Map();
  const add = (note) => {
    if (!note || !note.memoryId) return;
    if ([true, 'true'].includes(note.metadata?.qa_fixture)) return;
    if (note.kind === 'history') return;
    if (note.status && note.status !== MEMORY_STATUS.active) return;
    if (!byPermalink.has(note.permalink)) byPermalink.set(note.permalink, note);
  };
  for (const item of await searchNotes(ctx, query, MAX_SEARCH_CANDIDATES)) {
    const node = { permalink: String(item?.permalink ?? ''), title: String(item?.title ?? '') };
    if (!node.permalink || !isMemoryPermalink(node.permalink)) continue;
    add(await readCandidate(ctx, node));
  }
  for (const kind of ['fact', 'event']) {
    const nodes = await listNodes(ctx, memoryDirectory(ctx.config, kind), MAX_LIST_CANDIDATES).catch((error) => { if (ctx.strictReads) throw error; return []; });
    for (const node of nodes) {
      if (byPermalink.size >= MAX_LIST_CANDIDATES) break;
      add(await readCandidate(ctx, node));
    }
  }
  return [...byPermalink.values()].slice(0, MAX_LIST_CANDIDATES);
}

export function formatCaptureCandidates(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '(none)';
  const lines = [];
  let used = 0;
  for (const note of notes) {
    const line = [
      '- memory_id=' + note.memoryId,
      'kind=' + note.kind,
      'title=' + note.title,
      note.subject ? 'subject=' + note.subject : '',
      note.attribute ? 'attribute=' + note.attribute : '',
      note.requirementScope ? 'requirement_scope=' + note.requirementScope : '',
      'value=' + clipText(note.value || note.content, MAX_CANDIDATE_CHARS),
      note.occurredAt ? 'occurred_at=' + note.occurredAt : '',
      note.timeExpression ? 'time_expression=' + note.timeExpression : '',
      note.timeAnchor ? 'time_anchor=' + note.timeAnchor : '',
      note.sourceEventTime ? 'source_event_time=' + note.sourceEventTime : '',
    ].filter(Boolean).join(' | ');
    if (used + line.length + 1 > 7000) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function normalizeAction(action) {
  const value = String(action ?? '').trim().toUpperCase();
  return ['ADD', 'UPDATE', 'CORRECT', 'REINFORCE', 'NONE'].includes(value) ? value : '';
}

function normalizeCategory(value, kind) {
  if (kind === 'event') return 'event';
  const category = String(value ?? 'fact').trim().toLowerCase();
  return ['preference', 'fact', 'decision', 'relationship'].includes(category) ? category : 'fact';
}

function normalizeEvidence(value) {
  return collapseWhitespace(String(value ?? ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function isGrounded(evidence, userText) {
  const quote = normalizeEvidence(evidence);
  if (quote.length < 2) return false;
  return normalizeEvidence(userText).includes(quote);
}

export function parseMemoryActionsDetailed(raw) {
  const text = String(raw ?? '').replace(/[\u0060]{3}(?:json)?/gi, '').replace(/[\u0060]{3}/g, '').trim();
  if (!text) {
    return { status: 'empty', actions: [], textLength: 0, itemCount: 0, skippedItems: 0, error: 'empty-output' };
  }
  let parsed;
  let parseError = '';
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parseError = error instanceof Error ? error.message : 'invalid-json';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
        parseError = '';
      } catch {
        // Keep the original parse failure for diagnostics.
      }
    }
  }
  const hasActions = Array.isArray(parsed) || Array.isArray(parsed?.actions);
  if (!hasActions) {
    return {
      status: 'invalid',
      actions: [],
      textLength: text.length,
      itemCount: 0,
      skippedItems: 0,
      error: parseError || 'actions-array-missing',
    };
  }
  const items = Array.isArray(parsed) ? parsed : parsed.actions;
  const out = [];
  let skippedItems = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      skippedItems += 1;
      continue;
    }
    const action = normalizeAction(item.action);
    if (!action || action === 'NONE') {
      skippedItems += 1;
      continue;
    }
    const rawKind = String(item.kind ?? 'fact').trim().toLowerCase();
    const personal = ['thoughts', 'diary'].includes(rawKind);
    const kind = personal ? rawKind : rawKind === 'event' ? 'event' : 'fact';
    const value = collapseWhitespace(String(item.value ?? item.text ?? item.summary ?? '')).trim();
    const evidence = collapseWhitespace(String(item.evidence ?? '')).trim();
    if (!value || !evidence || (personal && (action !== 'REINFORCE' || !item.target_record || !item.target_entry_id)) || (!personal && action === 'REINFORCE' && !String(item.target_memory_id ?? item.targetMemoryId ?? '').trim())) {
      skippedItems += 1;
      continue;
    }
    const rawOccurred = String(item.occurred_at ?? item.occurredAt ?? '').trim();
    const rawEffective = String(item.effective_at ?? item.effectiveAt ?? item.valid_until ?? item.validUntil ?? '').trim();
    out.push({
      action,
      kind,
      category: normalizeCategory(item.category, kind),
      title: String(item.title ?? '').trim(),
      subject: collapseWhitespace(String(item.subject ?? '')).trim(),
      attribute: collapseWhitespace(String(item.attribute ?? '')).trim(),
      value: clipText(value, 1000),
      eventSummary: collapseWhitespace(String(item.event_summary ?? item.eventSummary ?? value)).trim(),
      occurredAt: kind === 'event' ? rawOccurred : normalizeOccurredAt(rawOccurred),
      timeExpression: collapseWhitespace(String(item.time_expression ?? item.timeExpression ?? '')).trim(),
      effectiveDate: rawEffective,
      targetMemoryId: String(item.target_memory_id ?? item.targetMemoryId ?? '').trim(),
      requirementScope: collapseWhitespace(String(item.requirement_scope ?? item.requirementScope ?? '')).slice(0, 120),
      requirementLifetime: String(item.requirement_lifetime ?? item.requirementLifetime ?? '').trim(),
      ...(personal ? { targetRecord: String(item.target_record), targetEntryId: String(item.target_entry_id) } : {}),
      evidence: clipText(evidence, 300),
    });
    if (out.length >= MAX_CAPTURE_ACTIONS) {
      skippedItems += Math.max(0, items.length - out.length);
      break;
    }
  }
  return {
    status: out.length > 0 ? 'ok' : items.length > 0 ? 'empty-dropped' : 'empty',
    actions: out,
    textLength: text.length,
    itemCount: items.length,
    skippedItems,
    error: parseError,
  };
}

export function parseMemoryActions(raw) {
  return parseMemoryActionsDetailed(raw).actions;
}

function canonicalKey(value) {
  return collapseWhitespace(String(value ?? ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function matchesSameSubject(note, action) {
  if (!note) return false;
  if (!sameRequirementScope(note, action)) return false;
  const meta = note.meta ?? note;
  const actionSubject = canonicalKey(action.subject);
  const metaSubject = canonicalKey(meta.subject);
  const actionAttribute = canonicalKey(action.attribute);
  const metaAttribute = canonicalKey(meta.attribute);
  if (actionSubject && metaSubject && actionSubject !== metaSubject) return false;
  if (actionAttribute && metaAttribute && actionAttribute !== metaAttribute) return false;
  if (actionSubject && metaSubject) {
    if (actionAttribute && metaAttribute) return true;
    return true;
  }
  if (action.title && note.title && canonicalKey(action.title) === canonicalKey(note.title)) return true;
  return false;
}

/**
 * An explicit target_memory_id selects a note, but it must not let a capture
 * rewrite that note into a different subject or attribute. Only compare fields
 * that both sides actually state, so an id-only action still works.
 */
function conflictsWithTarget(note, action) {
  if (!note) return false;
  if (action.requirementScope && note.requirementScope && !sameRequirementScope(note, action)) return true;
  const meta = note.meta ?? note;
  for (const field of ['subject', 'attribute']) {
    const incoming = canonicalKey(action[field]);
    const stored = canonicalKey(meta[field]);
    if (incoming && stored && incoming !== stored) return true;
  }
  return false;
}

function sourceEntry({ sessionId, turn, messageId, eventSeq, sourceEventTime, now }) {
  const eventDate = sourceDate(sourceEventTime) ?? (now instanceof Date ? now : new Date(now ?? Date.now()));
  return {
    session_id: String(sessionId ?? ''),
    turn: Number(turn ?? 0) || 0,
    message_id: String(messageId ?? ''),
    event_seq: Number(eventSeq ?? 0) || 0,
    at: eventDate.toISOString(),
  };
}

function mergeSources(existing, addition) {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((item) => JSON.stringify(item)));
  for (const item of addition ?? []) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function nextMetaFrom(note, values) {
  const previous = note?.metadata ?? {};
  return memoryMetadata({
    memoryId: note?.memoryId,
    kind: note?.kind,
    status: values.status ?? note?.status ?? MEMORY_STATUS.active,
    subject: values.subject ?? note?.subject,
    attribute: values.attribute ?? note?.attribute,
    value: values.value ?? note?.value,
    occurredAt: values.occurredAt ?? note?.occurredAt,
    sessionId: values.sessionId,
    turn: values.turn,
    messageId: values.messageId,
    eventSeq: values.eventSeq,
    sources: values.sources,
    previous,
    supersedes: values.supersedes,
    validFrom: values.validFrom ?? note?.validFrom,
    validUntil: values.validUntil ?? note?.validUntil,
    timeExpression: values.timeExpression ?? note?.timeExpression,
    timeAnchor: values.timeAnchor ?? note?.timeAnchor,
    sourceEventTime: values.sourceEventTime ?? note?.sourceEventTime,
    contentChange: values.contentChange,
    requirementScope: values.requirementScope ?? note?.requirementScope,
    historyPermalink: values.historyPermalink,
    historyTitle: values.historyTitle,
  });
}

function historyTitleFor(note, clock) {
  return sanitizeMemoryTitle('历史 - ' + (note.subject || note.title || '记忆') + ' - ' + clock.date + ' ' + clock.stamp);
}

async function createHistoryFrom(ctx, note, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, validUntil, revoked = false, operationId }) {
  const oldValue = note.value || '';
  if (!oldValue) return null;
  const historyId = operationId ? createHash('sha256').update(operationId + ':' + note.memoryId).digest('hex') : randomUUID();
  const recordedAtDate = typeof now === 'function' ? now() : (now instanceof Date ? now : new Date(now ?? Date.now()));
  const recordedAt = recordedAtDate.toISOString();
  const status = revoked ? 'revoked' : MEMORY_STATUS.history;
  const stableClock = operationId && sourceDate(sourceEventTime) ? shanghaiParts(sourceDate(sourceEventTime)) : clock;
  const title = sanitizeMemoryTitle((revoked ? '已撤销/错误 - ' : '') + historyTitleFor(note, stableClock) + ' - ' + historyId.slice(0, 6));
  if (operationId) {
    // A crash between history/current writes reuses the same history artifact.
    let found;
    try { found = await readMemoryNote(ctx, title); }
    catch (error) { if (!/NOTE_NOT_FOUND/.test(error.message)) throw error; }
    if (found && noteMetadata(found).memoryId === historyId) return { memoryId: historyId, title, permalink: found.permalink, status: revoked ? 'revoked' : 'history' };
    if (found) throw new MemoryError('HISTORY_ID_CONFLICT', 'history title belongs to another note');
  }
  const from = String(note.validFrom || note.metadata?.valid_from || '');
  const until = String(validUntil || note.validUntil || '');
  const managed = memoryBody({
    kind: 'history',
    title,
    value: (revoked ? '[已撤销/错误，仅供审阅] ' : '') + oldValue,
    subject: note.subject,
    attribute: note.attribute,
    occurredAt: note.occurredAt,
    recordedAt,
    validFrom: from,
    validUntil: until,
    timeExpression: note.timeExpression,
    timeAnchor: note.timeAnchor,
    sourceEventTime: note.sourceEventTime,
    requirementScope: note.requirementScope,
  });
  const oldFull = contentWithoutMarker(note.content || '');
  const content = managed + (oldFull ? '\n## 完整旧版\n\n' + oldFull + '\n' : '');
  const source = sourceEntry({ sessionId, turn, messageId, eventSeq, sourceEventTime, now: typeof now === 'function' ? now() : now });
  const args = {
    title,
    content,
    directory: memoryDirectory(ctx.config, 'history'),
    project: ctx.project,
    tags: [MEMORY_TAG, HISTORY_TAG],
    note_type: 'note',
    metadata: memoryMetadata({
      memoryId: historyId,
      kind: 'history',
      status,
      subject: note.subject,
      attribute: note.attribute,
      value: oldValue,
      occurredAt: note.occurredAt,
      recordedAt,
      sessionId,
      turn,
      messageId,
      eventSeq,
      sources: [source],
      requirementScope: note.requirementScope,
      supersedes: note.memoryId,
      validFrom: from,
      validUntil: until,
      timeExpression: note.timeExpression,
      timeAnchor: note.timeAnchor,
      sourceEventTime: note.sourceEventTime,
      previous: { ...carryPriority(note.metadata), decay_anchor_at: priorityFromMetadata(note.metadata, ctx.config).decayAnchorAt },
      basePriority: note.metadata?.base_priority,
      softenedAt: note.metadata?.softened_at,
      halfLifeDays: note.metadata?.half_life_days,
      priorityFloor: note.metadata?.priority_floor,
      softenCount: note.metadata?.soften_count,
      softenFactor: note.metadata?.soften_factor,
      softenReason: note.metadata?.soften_reason,
    }),
    output_format: 'json',
  };
  const written = await writeNote(ctx, args);
  if (written.conflict) throw new MemoryError('WRITE_CONFLICT', 'history note changed while writing');
  return {
    memoryId: historyId,
    kind: 'history',
    status,
    title,
    permalink: String(written.payload?.permalink ?? ''),
    checksum: String(written.payload?.checksum ?? ''),
    content,
  };
}

async function writeCurrentMemory(ctx, note, values) {
  const title = values.title ?? note.title;
  const content = memoryBody({
    kind: note.kind,
    category: values.category ?? 'fact',
    title,
    value: values.value,
    subject: values.subject ?? note.subject,
    attribute: values.attribute ?? note.attribute,
    occurredAt: values.occurredAt ?? note.occurredAt,
    recordedAt: note.recordedAt || note.metadata?.recorded_at || '',
    timeExpression: values.timeExpression ?? note.timeExpression,
    timeAnchor: values.timeAnchor ?? note.timeAnchor,
    sourceEventTime: values.sourceEventTime ?? note.sourceEventTime,
    requirementScope: values.requirementScope ?? note.requirementScope,
    historyTitle: values.historyTitle ?? note.metadata?.latest_history_title,
  });
  const managed = managedBlockOf(note.content || '');
  if (!managed) {
    throw new MemoryError('BODY_UNMANAGED', 'cannot update a memory note whose managed body is missing');
  }
  const newBlock = [content.trim(), managed.displaced.length ? '\n\n' + managed.displaced.join('\n') : ''].join('');
  const args = {
    identifier: note.permalink,
    operation: 'find_replace',
    find_text: managed.block,
    content: newBlock,
    expected_replacements: 1,
    project: ctx.project,
    expected_checksum: note.checksum,
    metadata: { ...nextMetaFrom(note, values), ...values.priorityPatch },
    output_format: 'json',
  };
  if (!args.expected_checksum) throw new MemoryError('MISSING_CHECKSUM', 'cannot update a memory note without its checksum');
  const written = await editNote(ctx, args);
  if (written.conflict) throw new MemoryError('WRITE_CONFLICT', 'memory note changed while writing');
  return {
    memoryId: note.memoryId,
    title,
    permalink: String(written.payload?.permalink ?? note.permalink),
    checksum: String(written.payload?.checksum ?? ''),
    block: newBlock,
  };
}

function sameFactIdentity(note, action) {
  if (!note || note.kind !== 'fact') return false;
  if (!sameRequirementScope(note, action)) return false;
  const noteSubject = canonicalKey(note.subject);
  const noteAttribute = canonicalKey(note.attribute);
  const actionSubject = canonicalKey(action.subject);
  const actionAttribute = canonicalKey(action.attribute);
  return Boolean(noteSubject && noteAttribute && actionSubject && actionAttribute)
    && noteSubject === actionSubject
    && noteAttribute === actionAttribute;
}

function sameRequirementScope(note, action) {
  // An omitted scope may select an explicit ID for a legacy note; implicit matching must not cross scopes.
  return canonicalKey(note.requirementScope ?? note.metadata?.requirement_scope ?? '') === canonicalKey(action.requirementScope ?? '');
}

async function addMemory(ctx, action, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, existing, source }) {
  const kind = action.kind;
  const value = action.value;
  const occurredAt = kind === 'event' ? (action.occurredAt || '日期未明') : normalizeOccurredAt(action.occurredAt);
  if (kind === 'event' && !isValidOccurredAt(occurredAt)) {
    throw new MemoryError('INVALID_DATE', 'event date is not a real calendar date: ' + occurredAt);
  }
  const title = memoryTitle({ kind, action, occurredAt });
  if (!title) throw new MemoryError('INVALID_TITLE', 'memory title is empty');
  const timeExpression = String(action.timeExpression ?? '').trim();
  const timeAnchor = timeExpression ? sourceTimeAnchor(sourceEventTime) : '';
  const sourceEventTimeIso = timeExpression ? sourceTimeIso(sourceEventTime) : '';

  const duplicate = existing.find((note) => {
    if (note.kind !== kind) return false;
    if (canonicalKey(note.value) !== canonicalKey(value)) return false;
    if (kind === 'event') {
      return canonicalKey(note.occurredAt) === canonicalKey(occurredAt)
        && canonicalKey(note.title) === canonicalKey(title);
    }
    return matchesSameSubject(note, action);
  });
  if (duplicate) {
    if (ctx.config.naturalDecayStartedAt) {
      const reinforced = await reinforceMemory(ctx, duplicate, action, source);
      return { ...reinforced, action: 'ADD', duplicate: true };
    }
    const sources = mergeSources(duplicate.sources, [source]);
    const updated = await writeCurrentMemory(ctx, duplicate, {
      value: duplicate.value,
      subject: duplicate.subject,
      attribute: duplicate.attribute,
      occurredAt: duplicate.occurredAt,
      recordedAt: duplicate.recordedAt,
      sources,
      category: action.category,
      title: duplicate.title,
      timeExpression: duplicate.timeExpression,
      timeAnchor: duplicate.timeAnchor,
      sourceEventTime: duplicate.sourceEventTime,
    });
    return { action: 'ADD', kind, memoryId: updated.memoryId, permalink: updated.permalink, duplicate: true };
  }

  // A fact is identified by its verified subject+attribute. A different value
  // on the same identity must update that note (and keep any soft-downweight),
  // never create a fresh full-priority copy. Events stay independent.
  const sameIdentity = kind === 'fact'
    ? existing.find((note) => note.kind === 'fact' && note.status === MEMORY_STATUS.active && sameFactIdentity(note, action))
    : null;
  if (sameIdentity && canonicalKey(sameIdentity.value) !== canonicalKey(value)) {
    const updated = await updateMemory(ctx, { ...action, action: 'UPDATE' }, {
      sessionId,
      turn,
      messageId,
      eventSeq,
      sourceEventTime,
      now,
      clock,
      target: sameIdentity,
      source,
    });
    return {
      action: 'ADD',
      kind,
      memoryId: updated.memoryId,
      permalink: updated.permalink,
      updatedExisting: true,
      historyMemoryId: updated.historyMemoryId,
      historyPermalink: updated.historyPermalink,
      historyStatus: updated.historyStatus,
    };
  }

  const memoryId = randomUUID();
  const recordedAt = (typeof now === 'function' ? now() : (now instanceof Date ? now : new Date(now ?? Date.now()))).toISOString();
  const content = memoryBody({
    kind,
    category: action.category,
    title,
    value,
    subject: action.subject,
    attribute: action.attribute,
    occurredAt,
    recordedAt,
    requirementScope: action.requirementScope,
    timeExpression,
    timeAnchor,
    sourceEventTime: sourceEventTimeIso,
  });
  const args = {
    title,
    content,
    directory: memoryDirectory(ctx.config, kind),
    project: ctx.project,
    tags: kind === 'event' ? [MEMORY_TAG, 'dsh-event'] : [MEMORY_TAG, 'dsh-fact'],
    note_type: 'note',
    metadata: memoryMetadata({
      memoryId,
      kind,
      status: MEMORY_STATUS.active,
      subject: action.subject,
      attribute: action.attribute,
      requirementScope: action.requirementScope,
      value,
      occurredAt,
      recordedAt,
      timeExpression,
      timeAnchor,
      sourceEventTime: sourceEventTimeIso,
      sessionId,
      turn,
      messageId,
      eventSeq,
      sources: [source],
      contentChange: { ...source, action: 'ADD', time_kind: sourceDate(sourceEventTime) ? 'message' : 'recorded' },
    }),
    output_format: 'json',
  };
  const written = await writeNote(ctx, args);
  if (written.conflict) throw new MemoryError('WRITE_CONFLICT', 'memory note changed while writing');
  return {
    action: 'ADD',
    kind,
    memoryId,
    title,
    permalink: String(written.payload?.permalink ?? ''),
    checksum: String(written.payload?.checksum ?? ''),
    duplicate: false,
  };
}

function memoryDestination(filePath, title) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || !/\.md$/i.test(normalized)) return '';
  const name = sanitizeMemoryTitle(title);
  if (!name) return '';
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) + '/' + name + '.md' : name + '.md';
}

/** Restore the old managed block when a title move fails, so path and title stay consistent. */
async function rollbackTitleChange(ctx, target, updated) {
  const managed = managedBlockOf(target.content || '');
  if (!managed || !updated?.block || !updated?.checksum) return false;
  const restored = await editNote(ctx, {
    identifier: target.permalink,
    operation: 'find_replace',
    find_text: updated.block,
    content: managed.block,
    expected_replacements: 1,
    project: ctx.project,
    expected_checksum: updated.checksum,
    metadata: { ...nextMetaFrom(target, {
      value: target.value,
      subject: target.subject,
      attribute: target.attribute,
      occurredAt: target.occurredAt,
      timeExpression: target.timeExpression,
      timeAnchor: target.timeAnchor,
      sourceEventTime: target.sourceEventTime,
      sources: target.sources,
    }), ...Object.fromEntries(CONTENT_CHANGE_KEYS.map(key => [key, target.metadata?.[key] ?? ''])) },
    output_format: 'json',
  });
  return restored.conflict !== true;
}

async function updateMemory(ctx, action, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, target, source }) {
  if (!target) throw new MemoryError('TARGET_NOT_FOUND', 'memory to update was not found');
  const priorityPatch = ctx.config.naturalDecayStartedAt ? reinforcePriorityPatch(target.metadata, { ...ctx.config, now: source.at }) : null;
  const sources = mergeSources(target.sources, [{ ...source, ...(priorityPatch ? { reinforced: true } : {}) }]);
  const value = action.value;
  const occurredAt = target.kind === 'event'
    ? (action.occurredAt || target.occurredAt || '日期未明')
    : target.occurredAt;
  if (target.kind === 'event' && !isValidOccurredAt(occurredAt)) {
    throw new MemoryError('INVALID_DATE', 'event date is not a real calendar date: ' + occurredAt);
  }
  const effective = String(action.effectiveDate ?? '').trim();
  if (effective && !/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
    throw new MemoryError('INVALID_DATE', 'effective date must be YYYY-MM-DD: ' + effective);
  }
  if (effective && !isValidOccurredAt(effective)) {
    throw new MemoryError('INVALID_DATE', 'effective date is not a real calendar date: ' + effective);
  }
  const oldSummary = target.kind === 'event'
    ? (String(target.title ?? '').includes(' - ') ? String(target.title).slice(String(target.title).indexOf(' - ') + 3) : target.value)
    : '';
  const nextSummary = String(action.eventSummary ?? '').trim()
    || (canonicalKey(value) !== canonicalKey(target.value) ? value : oldSummary);
  const title = target.kind === 'event'
    ? memoryTitle({ kind: 'event', action: { eventSummary: nextSummary }, occurredAt })
    : target.title;
  const titleChanged = canonicalKey(title) !== canonicalKey(target.title);
  if (titleChanged && !target.filePath) {
    throw new MemoryError('FILE_PATH_MISSING', 'cannot rename an event memory without its real file_path');
  }
  const restatedTimeExpression = String(action.timeExpression ?? '').trim();
  const nextTimeExpression = restatedTimeExpression || String(target.timeExpression ?? '').trim();
  const timeChanged = nextTimeExpression !== String(target.timeExpression ?? '').trim();
  // A restated relative phrase is anchored to this user message even when the
  // text is identical: "last week" said on a later day means a later week.
  const timeAnchor = nextTimeExpression
    ? (restatedTimeExpression || !target.timeAnchor ? sourceTimeAnchor(sourceEventTime) : target.timeAnchor)
    : (target.timeAnchor || '');
  const sourceEventTimeIso = nextTimeExpression
    ? (restatedTimeExpression || !target.sourceEventTime ? sourceTimeIso(sourceEventTime) : target.sourceEventTime)
    : (target.sourceEventTime || '');
  const changed = value !== target.value
    || (action.subject && action.subject !== target.subject)
    || (action.attribute && action.attribute !== target.attribute)
    || (target.kind === 'event' && occurredAt !== target.occurredAt)
    || titleChanged
    || timeChanged
    || Boolean(restatedTimeExpression);
  const materialChanged = value !== target.value
    || Boolean(action.subject && action.subject !== target.subject)
    || Boolean(action.attribute && action.attribute !== target.attribute)
    || (target.kind === 'event' && occurredAt !== target.occurredAt)
    || titleChanged || timeChanged;
  const history = changed
    ? await createHistoryFrom(ctx, target, {
      sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock,
      validUntil: action.action === 'UPDATE' ? (effective || '') : '',
      revoked: action.action === 'CORRECT',
      operationId: source.operation_id,
    })
    : null;
  const updated = await writeCurrentMemory(ctx, target, {
    title,
    value,
    subject: action.subject || target.subject,
    attribute: action.attribute || target.attribute,
    occurredAt,
    recordedAt: target.recordedAt,
    sources,
    category: action.category,
    validFrom: action.action === 'UPDATE' && effective ? effective : target.validFrom,
    timeExpression: nextTimeExpression,
    timeAnchor,
    sourceEventTime: sourceEventTimeIso,
    priorityPatch,
    requirementScope: action.requirementScope || target.requirementScope,
    historyPermalink: history?.permalink,
    historyTitle: history?.title,
    contentChange: materialChanged
      ? { ...source, action: action.action, time_kind: sourceDate(sourceEventTime) ? 'message' : 'recorded' }
      : undefined,
  });
  let filePath = target.filePath;
  let permalink = updated.permalink;
  if (titleChanged) {
    const destination = memoryDestination(target.filePath, title);
    if (destination && destination !== target.filePath) {
      try {
        const moved = await callMemory(ctx, 'move_note', {
          identifier: target.permalink,
          destination_path: destination,
          project: ctx.project,
          output_format: 'json',
        });
        if (moved && moved.moved === false) throw new Error('move_note did not move the note');
        filePath = String(moved?.file_path ?? destination);
        permalink = String(moved?.permalink ?? updated.permalink);
      } catch (error) {
        await rollbackTitleChange(ctx, target, updated).catch(() => {});
        throw new MemoryError('TITLE_MOVE_FAILED', 'could not move the retitled event note: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }
  return {
    action: action.action,
    kind: target.kind,
    memoryId: target.memoryId,
    title,
    permalink,
    filePath,
    historyMemoryId: history?.memoryId ?? '',
    historyPermalink: history?.permalink ?? '',
    historyStatus: history?.status ?? '',
    reinforced: Boolean(priorityPatch),
  };
}

async function reinforceMemory(ctx, target, action, source) {
  if (!target || target.status !== MEMORY_STATUS.active || !['fact', 'event'].includes(target.kind)) throw new MemoryError('INVALID_REINFORCE_TARGET', 'active fact/event required');
  if (canonicalKey(target.value) !== canonicalKey(action.value)) throw new MemoryError('REINFORCE_VALUE_CHANGED', 'a changed fact needs UPDATE/CORRECT');
  const patch = reinforcePriorityPatch(target.metadata, { ...ctx.config, now: source.at });
  const result = { action: 'REINFORCE', kind: target.kind, memoryId: target.memoryId, permalink: target.permalink, metadataOnly: true, reinforced: Boolean(patch) };
  // Cooldown and stale statements do not write or extend the cooldown.
  if (!patch) return result;
  if (!target.checksum) throw new MemoryError('MISSING_CHECKSUM', 'cannot reinforce without checksum');
  const sources = mergeSources(target.sources, [{ ...source, operation: 'REINFORCE' }]);
  const metadata = { ...patch, sources: JSON.stringify(sources) };
  const written = await editNote(ctx, { identifier: target.permalink, operation: 'append', content: '', expected_checksum: target.checksum, metadata, project: ctx.project, output_format: 'json' });
  if (written.conflict) throw new MemoryError('WRITE_CONFLICT', 'memory changed before reinforcement');
  const fresh = await readMemoryNote(ctx, target.permalink);
  const actual = noteFrontmatter(fresh);
  if (stripFrontmatter(fresh.content ?? '') !== stripFrontmatter(target.content) || Object.entries(metadata).some(([k,v]) => String(actual[k]) !== String(v))) throw new MemoryError('REINFORCE_READBACK_MISMATCH', 'reinforcement readback failed');
  return result;
}

async function applyOneAction(ctx, action, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, existing, source }) {
  if (action.requirementLifetime === 'temporary') return { action: action.action, skipped: 'temporary-requirement', metadataOnly: true };
  if (action.requirementScope && action.requirementLifetime && action.requirementLifetime !== 'ongoing') throw new MemoryError('INVALID_REQUIREMENT_LIFETIME', 'requirement_lifetime must be ongoing or temporary');
  if (['thoughts', 'diary'].includes(action.kind)) return reinforcePersonalEntry(ctx, action, source);
  const targetById = action.targetMemoryId
    ? existing.find((note) => note.memoryId === action.targetMemoryId)
    : null;
  const target = targetById ?? existing.find((note) => matchesSameSubject(note, action)) ?? null;
  if (source.operation_id) {
    const done = existing.find((note) => note.sources?.some((s) => s.operation_id === source.operation_id));
    if (done) {
      const mark = done.sources.find(s => s.operation_id === source.operation_id);
      const metadataOnly = mark.operation === 'REINFORCE';
      return { action: action.action, kind: done.kind, memoryId: done.memoryId, permalink: done.permalink, recovered: true, metadataOnly, reinforced: metadataOnly || Boolean(mark.reinforced), duplicate: metadataOnly && action.action === 'ADD' };
    }
    // Delayed jobs must not undo a later user statement or an observed manual edit.
    if (target && (action.action !== 'ADD' || action.kind === 'fact')) {
      const incoming = Date.parse(source.at);
      const latest = Math.max(0, ...target.sources.map((s) => Date.parse(s.at) || 0), Number(ctx.externalEdits?.[target.permalink] ?? 0));
      if (latest > incoming) return { action: action.action, skipped: 'superseded', permalink: target.permalink, memoryId: target.memoryId };
    }
  }
  if (action.action === 'ADD') {
    return addMemory(ctx, action, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, existing, source });
  }
  if (targetById && conflictsWithTarget(targetById, action)) {
    return {
      action: action.action,
      skipped: 'target-mismatch',
      kind: action.kind,
      memoryId: targetById.memoryId,
    };
  }
  if (action.action === 'REINFORCE') return reinforceMemory(ctx, targetById, action, source);
  if (action.action === 'UPDATE' || action.action === 'CORRECT') {
    if (!target) return { action: action.action, skipped: 'target-not-found', kind: action.kind };
    return updateMemory(ctx, action, { sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, target, source });
  }
  return { action: action.action, skipped: 'unknown-action' };
}

/** Apply one capture batch under the commit lock. */
export async function applyMemoryActions(ctx, actions, {
  sessionId,
  turn,
  messageId,
  eventSeq,
  sourceEventTime,
  now = () => new Date(),
  operationId,
  completed = {},
  onApplied,
}) {
  if (!Array.isArray(actions) || actions.length === 0) return { committed: false, reason: 'no-actions', results: [] };
  const clock = shanghaiParts(typeof now === 'function' ? now() : now);
  return withCommitLock(async () => {
    const existing = await loadCaptureCandidates(ctx, actions.map((action) => action.evidence).join('\n'));
    const byId = [...existing];
    const results = [];
    for (const [index, action] of actions.entries()) {
      ctx.signal?.throwIfAborted?.();
      if (completed[index]) { results.push(completed[index]); continue; }
      const source = sourceEntry({ sessionId, turn, messageId, eventSeq, sourceEventTime, now: typeof now === 'function' ? now() : now });
      if (operationId) source.operation_id = operationId + ':' + index;
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await applyOneAction(ctx, action, {
            sessionId, turn, messageId, eventSeq, sourceEventTime, now, clock, existing: byId, source,
          });
          break;
        } catch (error) {
          if (error.code === 'WRITE_CONFLICT' && attempt < 2) {
            const fresh = await loadCaptureCandidates(ctx, action.evidence);
            byId.splice(0, byId.length, ...fresh);
            continue;
          }
          if (results.some((item) => item && !item.skipped)) {
            return { committed: true, partial: true, reason: 'partial-write', results };
          }
          throw error;
        }
      }
      if (operationId && result?.skipped && !['superseded', 'temporary-requirement'].includes(result.skipped)) throw new MemoryError('CAPTURE_TARGET_UNRESOLVED', result.skipped);
      await onApplied?.(index, { ...result, expectedValue: result?.skipped ? undefined : action.value });
      results.push(result);
      if (result?.permalink) {
        const fresh = await readCandidate(ctx, { permalink: result.permalink, title: result.title });
        if (fresh) {
          const previous = byId.findIndex(n => n.memoryId === fresh.memoryId);
          if (previous < 0) byId.push(fresh); else byId[previous] = fresh;
        }
      }
    }
    return { committed: results.some((result) => result && !result.skipped), results };
  });
}

function personalKindFor(permalink, project) {
  for (const kind of PERSONAL_KINDS) {
    if (personalRecordPath(kind, permalink, project)) return kind;
  }
  return '';
}

function candidateLine(target) {
  const id = target.memoryId ? 'memory_id=' + target.memoryId : 'record=' + target.permalink;
  return [id, 'permalink=' + target.permalink, 'title=' + target.title].join(' | ');
}

async function findMemoryById(ctx, memoryId) {
  const id = String(memoryId ?? '').trim();
  if (!id) return null;
  for (const item of await searchNotes(ctx, id, 20)) {
    const permalink = String(item?.permalink ?? '');
    if (!permalink || !isMemoryPermalink(permalink)) continue;
    const note = await hydrateMemory(await readMemoryNote(ctx, permalink), { permalink });
    if (note?.memoryId === id) return note;
  }
  for (const kind of ['fact', 'event']) {
    const nodes = await listAllNotes(ctx, memoryDirectory(ctx.config, kind), { maxNotes: 300 }).catch(() => []);
    for (const node of nodes) {
      if (!node?.permalink) continue;
      const note = await hydrateMemory(await readMemoryNote(ctx, node.permalink), node);
      if (note?.memoryId === id) return note;
    }
  }
  return null;
}

async function resolveSoftenTarget(ctx, { memoryId, identifier, query }) {
  const exact = String(identifier ?? '').trim();
  if (exact) {
    const payload = await readMemoryNote(ctx, exact);
    const permalink = String(payload?.permalink ?? exact);
    if (isPersonalPermalink(permalink)) {
      const kind = personalKindFor(permalink, ctx.project);
      if (!kind) throw new MemoryError('INVALID_TARGET', 'outside the dafeiyu record namespace: ' + permalink);
      return {
        scope: 'personal',
        kind,
        memoryId: '',
        title: String(payload?.title ?? ''),
        permalink,
        checksum: String(payload?.checksum ?? ''),
        content: String(payload?.content ?? ''),
        metadata: noteFrontmatter(payload),
      };
    }
    const note = await hydrateMemory(payload, { permalink });
    if (!note) throw new MemoryError('INVALID_TARGET', 'not a managed fact/event memory: ' + permalink);
    if (note.kind === 'history') throw new MemoryError('INVALID_TARGET', 'history notes inherit priority from their active memory');
    if (note.kind !== 'fact' && note.kind !== 'event') throw new MemoryError('INVALID_TARGET', 'not a fact/event memory');
    if (note.status !== MEMORY_STATUS.active) throw new MemoryError('INACTIVE_TARGET', 'only active memories can be softened');
    return { scope: 'memory', kind: note.kind, memoryId: note.memoryId, title: note.title, permalink: note.permalink, checksum: note.checksum, content: note.content, metadata: note.metadata };
  }

  const byId = String(memoryId ?? '').trim();
  if (byId) {
    const note = await findMemoryById(ctx, byId);
    if (!note) throw new MemoryError('TARGET_NOT_FOUND', 'no active fact/event has memory_id ' + byId);
    if (note.status !== MEMORY_STATUS.active) throw new MemoryError('INACTIVE_TARGET', 'only active memories can be softened');
    return { scope: 'memory', kind: note.kind, memoryId: note.memoryId, title: note.title, permalink: note.permalink, checksum: note.checksum, content: note.content, metadata: note.metadata };
  }

  const text = collapseWhitespace(String(query ?? ''));
  if (!text) throw new MemoryError('INVALID_ARGUMENT', 'pass memoryId, identifier, or query');
  const found = [];
  const seen = new Set();
  for (const item of await searchNotes(ctx, text, 8)) {
    const permalink = String(item?.permalink ?? '');
    if (!permalink || !isMemoryPermalink(permalink) || seen.has(permalink)) continue;
    seen.add(permalink);
    const note = await hydrateMemory(await readMemoryNote(ctx, permalink), { permalink });
    if (!note || note.kind === 'history' || note.status !== MEMORY_STATUS.active) continue;
    found.push(note);
  }
  if (found.length === 0) throw new MemoryError('TARGET_NOT_FOUND', 'no matching active memory for: ' + text);
  // A fuzzy query is only a candidate finder. Actual softening always needs
  // an exact memoryId or identifier so one query can never alter several notes.
  return { candidates: found.slice(0, 8).map(candidateLine) };
}

async function applySoftenPatch(ctx, target, { reason, now }) {
  if (!target.checksum) throw new MemoryError('MISSING_CHECKSUM', 'cannot soften a note without its current checksum');
  const patch = softenPriorityPatch(target.metadata, {
    factor: ctx.config.softenFactor,
    halfLifeDays: ctx.config.halfLifeDays,
    priorityFloor: ctx.config.priorityFloor,
    naturalDecayStartedAt: ctx.config.naturalDecayStartedAt,
    now,
    reason,
  });
  const written = await editNote(ctx, {
    identifier: target.permalink,
    operation: 'append',
    content: '',
    expected_checksum: target.checksum,
    project: ctx.project,
    metadata: patch,
    output_format: 'json',
  });
  if (written.conflict) throw new MemoryError('STALE_REVISION', 'memory changed before soften; read it again');
  const payload = await readMemoryNote(ctx, String(written.payload?.permalink ?? target.permalink));
  const afterMeta = noteFrontmatter(payload);
  const priority = priorityFromMetadata(afterMeta, {
    now,
    halfLifeDays: ctx.config.halfLifeDays,
    priorityFloor: ctx.config.priorityFloor,
  });
  const bodyUnchanged = target.content === undefined
    || stripFrontmatter(payload?.content ?? '') === stripFrontmatter(target.content);
  return {
    scope: target.scope,
    kind: target.kind,
    memoryId: target.memoryId,
    permalink: String(payload?.permalink ?? target.permalink),
    title: String(payload?.title ?? target.title),
    basePriority: priority.basePriority,
    effectivePriority: priority.effectivePriority,
    softenedAt: priority.softenedAt,
    bodyUnchanged,
    patch,
  };
}

/** Apply one explicit soft-downweight request. Never deletes or edits note body. */
export async function softenMemory(ctx, args = {}) {
  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  try {
    const resolved = await resolveSoftenTarget(ctx, args);
    if (Array.isArray(resolved?.candidates)) {
      return {
        ok: false,
        action: 'soften',
        kind: '',
        memoryId: '',
        permalink: '',
        basePriority: 0,
        effectivePriority: 0,
        softenedAt: '',
        bodyUnchanged: true,
        summary: '找到 ' + resolved.candidates.length + ' 个候选，尚未修改；请用其中一条的 memoryId 或 identifier 再调用以实际降权。',
        candidates: resolved.candidates,
        errorCode: 'NEEDS_SELECTION',
        errorMessage: 'multiple candidate memories match; choose one explicitly',
      };
    }
    const applied = await applySoftenPatch(ctx, resolved, { reason: args.reason, now });
    const softenFactor = applied.patch?.soften_factor ?? ctx.config.softenFactor;
    return {
      ok: applied.bodyUnchanged,
      action: 'soften',
      kind: applied.kind,
      memoryId: applied.memoryId,
      permalink: applied.permalink,
      basePriority: applied.basePriority,
      effectivePriority: applied.effectivePriority,
      softenedAt: applied.softenedAt,
      bodyUnchanged: applied.bodyUnchanged,
      summary: applied.bodyUnchanged
        ? '已降权：从当前有效权重按系数 ' + softenFactor + ' 调整（默认 0.5，即减半），原文与附件保留；仅降低默认召回排序，明确强线索仍可召回。未删除、未停用、未影响其他记录。'
        : '已写入降权元数据，但回读发现正文变化，请人工核对；未删除任何内容。',
      candidates: [],
      errorCode: applied.bodyUnchanged ? '' : 'BODY_CHANGED',
      errorMessage: applied.bodyUnchanged ? '' : 'note body changed during metadata-only edit',
    };
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : 'SOFTEN_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: 'soften',
      kind: '',
      memoryId: '',
      permalink: '',
      basePriority: 0,
      effectivePriority: 0,
      softenedAt: '',
      bodyUnchanged: true,
      summary: '未降权：' + code + ' — ' + message,
      candidates: [],
      errorCode: code,
      errorMessage: message,
    };
  }
}

/** Native tool for an explicit "forget/soften/stop bringing this up" request. */
export function createSoftenTool({ tools, config, getConfig, logger, now, onSoftened } = {}) {
  return {
    name: 'soften_memory',
    description: 'Soft-downweight exactly one named long-term memory or one whole dafeiyu personal note when the user explicitly asks to stop bringing it up, downweight it, soften it, or forget it. This never deletes or rewrites the note body: it only lowers default recall ranking and records when it was softened. Strong cues can still retrieve it. Pass memory_id from a recall block, or an exact permalink; a fuzzy query returns candidates and changes nothing until one is chosen. Do not confirm the downweight until this tool succeeds.',
    parameters: {
      memoryId: {
        type: 'string',
        description: 'Exact memory_id of one active fact/event (from a recall block or search).',
      },
      identifier: {
        type: 'string',
        description: 'Exact Basic Memory permalink of one active fact/event or one dafeiyu personal note.',
      },
      query: {
        type: 'string',
        description: 'User wording used only to find candidates when no exact id/permalink is known. Multiple matches return candidates without writing.',
      },
      reason: {
        type: 'string',
        description: 'Short reason from the user request, stored as metadata for review.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          kind: { type: 'string' },
          memoryId: { type: 'string' },
          permalink: { type: 'string' },
          basePriority: { type: 'number' },
          effectivePriority: { type: 'number' },
          softenedAt: { type: 'string' },
          bodyUnchanged: { type: 'boolean' },
          summary: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          errorCode: { type: 'string' },
          errorMessage: { type: 'string' },
        },
        required: ['ok', 'action', 'kind', 'memoryId', 'permalink', 'basePriority', 'effectivePriority', 'softenedAt', 'bodyUnchanged', 'summary', 'candidates', 'errorCode', 'errorMessage'],
      },
      render(args, value) {
        const lines = [value.summary];
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push('candidates:', ...value.candidates.map((item) => '- ' + item));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const runtimeConfig = getConfig ? await getConfig() : config;
      const result = await softenMemory({
        tools,
        agent: exec?.agent,
        signal: exec?.signal,
        config: runtimeConfig,
        project: config?.project ?? 'personal',
        logger,
        now,
      }, args ?? {});
      if (!result.ok) {
        logger?.warn?.('[basic-memory-bridge] soften_memory failed: ' + result.errorCode + ' ' + result.errorMessage);
      } else if (typeof onSoftened === 'function') {
        try {
          onSoftened(exec?.agent?.session?.id, result);
        } catch (error) {
          logger?.warn?.('[basic-memory-bridge] soften callback failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      return result;
    },
  };
}

export function questionWantsHistory(query) {
  return wantsHistory(query);
}
