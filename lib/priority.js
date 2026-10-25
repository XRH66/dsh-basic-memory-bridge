import { collapseWhitespace } from './text.js';

export const DEFAULT_SOFTEN_FACTOR = 0.5;
export const DEFAULT_HALF_LIFE_DAYS = 30;
export const DEFAULT_PRIORITY_FLOOR = 0.01;
export const DEFAULT_RECALL_PRIORITY = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY_KEYS = [
  'base_priority',
  'softened_at',
  'half_life_days',
  'priority_floor',
  'soften_count',
  'soften_factor',
  'soften_reason',
  'decay_anchor_at',
  'reinforced_at',
  'reinforcement_count',
];
const DATE_CUE_RE = /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日/;
const CJK_RUN_RE = /\p{Script=Han}+/gu;
const ASCII_WORD_RE = /[a-z0-9]+/g;
const GENERIC_CJK = new Set([
  '偏好', '喜欢', '习惯', '记忆', '用户', '老大', '什么', '怎么', '是否', '记得',
  '之前', '以前', '现在', '这个', '那个', '事情', '内容', '相关', '告诉', '说过',
  '提到', '忘记', '忘掉', '淡化', '想起', '主动', '一个', '一些', '我们', '你们',
  '他们', '她们', '它们', '自己', '可以', '应该', '需要', '觉得', '认为', '知道',
  '一下', '有点', '比较', '非常', '特别', '真的', '其实', '但是', '然后', '因为',
  '所以', '如果', '还是', '就是', '不是', '没有', '已经', '一直', '总是', '偶尔',
]);
const GENERIC_ASCII = new Set([
  'preference', 'preferences', 'memory', 'memories', 'remember', 'forget', 'user',
  'users', 'like', 'likes', 'habit', 'habits', 'what', 'which', 'anything',
  'something', 'thing', 'things', 'about', 'personal', 'fact', 'facts', 'soften',
  'weaken', 'downweight', 'priority', 'active', 'recall', 'the', 'and', 'for',
  'you', 'your', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were',
]);

function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundPriority(value) {
  return Math.max(0.000001, Math.round(value * 1e6) / 1e6);
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string' && now.trim()) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isoNow(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  const ms = nowMs(now);
  return new Date(ms).toISOString();
}

/** Read the priority fields that live only in note metadata/frontmatter. */
export function carryPriority(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const out = {};
  for (const key of PRIORITY_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') out[key] = source[key];
  }
  return out;
}

function asDateString(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? text : '';
}

/**
 * Decay is calculated on read, never by sweeping/re-writing the Vault.
 * The durable rollout baseline prevents old notes ageing instantly at upgrade.
 */
export function priorityFromMetadata(metadata, {
  now,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  priorityFloor = DEFAULT_PRIORITY_FLOOR,
  naturalDecayStartedAt,
} = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const floor = clamp(numberOr(source.priority_floor ?? priorityFloor, DEFAULT_PRIORITY_FLOOR), 0.000001, 0.5);
  const half = clamp(numberOr(source.half_life_days ?? halfLifeDays, DEFAULT_HALF_LIFE_DAYS), 1, 3650);
  const base = Math.max(floor, numberOr(source.base_priority, 1));
  const softenedAt = asDateString(source.softened_at);
  const explicit = [asDateString(source.decay_anchor_at), softenedAt].filter(Boolean);
  const baseline = asDateString(naturalDecayStartedAt);
  const anchor = explicit.length ? new Date(Math.max(...explicit.map(Date.parse))).toISOString()
    : baseline ? new Date(Math.max(Date.parse(baseline), Date.parse(asDateString(source.recorded_at)) || 0)).toISOString() : '';
  let effective = base;
  if (anchor) {
    const elapsedDays = Math.max(0, (nowMs(now) - Date.parse(anchor)) / DAY_MS);
    effective = base * Math.pow(2, -elapsedDays / half);
  }
  return {
    basePriority: roundPriority(base),
    effectivePriority: roundPriority(Math.max(floor, effective)),
    softenedAt,
    halfLifeDays: half,
    priorityFloor: floor,
    softenCount: Math.max(0, Math.trunc(numberOr(source.soften_count, 0))),
    softenFactor: numberOr(source.soften_factor, DEFAULT_SOFTEN_FACTOR),
    softened: Boolean(softenedAt),
    decayAnchorAt: anchor,
    reinforcedAt: asDateString(source.reinforced_at),
    reinforcementCount: Math.max(0, Math.trunc(numberOr(source.reinforcement_count, 0))),
  };
}

/** Only a verified new user reaffirmation calls this, never a read/search. */
export function reinforcePriorityPatch(metadata, options = {}) {
  const current = priorityFromMetadata(metadata, options);
  const at = nowMs(options.now);
  const last = Math.max(Date.parse(current.decayAnchorAt) || 0, Date.parse(current.reinforcedAt) || 0);
  if (!current.decayAnchorAt || at - last < DAY_MS || at < (Date.parse(options.naturalDecayStartedAt) || 0)) return null;
  const ceiling = Math.max(1, current.basePriority);
  return {
    base_priority: roundPriority(current.effectivePriority + (ceiling - current.effectivePriority) * 0.25),
    decay_anchor_at: isoNow(at),
    reinforced_at: isoNow(at),
    reinforcement_count: current.reinforcementCount + 1,
    half_life_days: Math.max(current.halfLifeDays, Math.min(180, current.halfLifeDays * 1.25)),
    priority_floor: current.priorityFloor,
  };
}

/** Compute the metadata patch for one explicit soften request. */
export function softenPriorityPatch(metadata, {
  factor = DEFAULT_SOFTEN_FACTOR,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  priorityFloor = DEFAULT_PRIORITY_FLOOR,
  naturalDecayStartedAt,
  now,
  reason = '',
} = {}) {
  const current = priorityFromMetadata(metadata, { now, halfLifeDays, priorityFloor, naturalDecayStartedAt });
  const appliedFactor = clamp(numberOr(factor, DEFAULT_SOFTEN_FACTOR), 0.05, 0.95);
  const nextBase = Math.max(current.priorityFloor, current.effectivePriority * appliedFactor);
  const patch = {
    base_priority: roundPriority(nextBase),
    softened_at: isoNow(now),
    decay_anchor_at: isoNow(now),
    half_life_days: clamp(numberOr(halfLifeDays, DEFAULT_HALF_LIFE_DAYS), 1, 3650),
    priority_floor: current.priorityFloor,
    soften_count: current.softenCount + 1,
    soften_factor: appliedFactor,
  };
  const cleanReason = collapseWhitespace(String(reason ?? '')).slice(0, 200);
  if (cleanReason) patch.soften_reason = cleanReason;
  return patch;
}

function normalizeCueText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawCueText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function extractDateKeys(value) {
  const raw = rawCueText(value);
  const full = new Set();
  const monthDay = new Set();
  const rest = raw.replace(/((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g, (match, year, month, day) => {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (validCalendarDate(y, m, d)) full.add(y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    return ' ';
  });
  for (const match of rest.matchAll(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g)) {
    const m = Number(match[1]);
    const d = Number(match[2]);
    if (validCalendarDate(2000, m, d)) monthDay.add(String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
  }
  return { full, monthDay };
}

function targetTitleOf(text) {
  const line = String(text ?? '').split(/\r?\n/).find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : '';
}

function hasGenericCjkPart(term) {
  if (GENERIC_CJK.has(term)) return true;
  for (const word of GENERIC_CJK) {
    if (word.length === 2 && term.includes(word)) return true;
  }
  return false;
}

function titleIsSpecific(title) {
  const normalized = normalizeCueText(title);
  if (normalized.length < 3) return false;
  if (/^(用户|我的|个人|记忆|偏好|喜好|习惯|关于)/.test(normalized)) return false;
  return true;
}

/**
 * Strong cues keep a record eligible for the top of the default list even when
 * its priority is low. They are deliberately conservative: an explicit date
 * must match the target record; a quoted phrase or an exact title-derived
 * phrase must match; and only CJK runs of 3+ or ASCII words of 3+ that are not
 * generic count as distinctive entities. Generic "preference/memory/user"
 * words never bypass downweighting.
 */
export function isStrongCue(query, text) {
  const raw = rawCueText(query);
  if (!raw) return false;
  const targetRaw = rawCueText(text);
  if (!targetRaw) return false;

  const queryDates = extractDateKeys(raw);
  const targetDates = extractDateKeys(text);
  if (queryDates.full.size > 0 || queryDates.monthDay.size > 0) {
    for (const date of queryDates.full) {
      if (targetDates.full.has(date)) return true;
      if (targetDates.monthDay.has(date.slice(5))) return true;
    }
    for (const date of queryDates.monthDay) {
      if (targetDates.monthDay.has(date)) return true;
      for (const full of targetDates.full) if (full.slice(5) === date) return true;
    }
    return false;
  }

  const q = normalizeCueText(raw);
  const target = normalizeCueText(text);
  if (!q || !target) return false;

  const quoted = raw.match(/["“”'‘’「」『』]([^"“”'‘’「」『』]{2,40})["“”'‘’「」『』]/);
  if (quoted) {
    const phrase = normalizeCueText(quoted[1]);
    if (phrase && !hasGenericCjkPart(phrase) && target.includes(phrase)) return true;
  }

  const title = targetTitleOf(text);
  if (title && titleIsSpecific(title)) {
    const fullTitle = normalizeCueText(title);
    if (fullTitle && q.includes(fullTitle)) return true;
    const core = normalizeCueText(title.split(/\s+[-—–]\s+/)[0]);
    if (core.length >= 3 && core !== fullTitle && q.includes(core)) return true;
  }

  for (const match of q.matchAll(ASCII_WORD_RE)) {
    const word = match[0];
    if (word.length < 3 || GENERIC_ASCII.has(word)) continue;
    if (new RegExp('(?:^|\\s)' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)').test(target)) return true;
  }

  for (const match of q.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    const maxLength = Math.min(6, run.length);
    for (let length = 3; length <= maxLength; length += 1) {
      for (let index = 0; index + length <= run.length; index += 1) {
        const term = run.slice(index, index + length);
        if (hasGenericCjkPart(term)) continue;
        if (target.includes(term)) return true;
      }
    }
  }
  return false;
}

/**
 * Relevance multiplied by effective priority for ordinary queries. Explicit
 * strong cues bypass the multiplier but never bypass eligibility/filtering.
 */
export function adjustedRelevance(score, metadata, {
  query = '',
  text = '',
  now,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  priorityFloor = DEFAULT_PRIORITY_FLOOR,
  naturalDecayStartedAt,
} = {}) {
  const priority = priorityFromMetadata(metadata, { now, halfLifeDays, priorityFloor, naturalDecayStartedAt });
  const strongCue = isStrongCue(query, text);
  const baseScore = numberOr(score, 0);
  return {
    score: strongCue ? baseScore : baseScore * priority.effectivePriority,
    baseScore,
    priority,
    strongCue,
    eligible: strongCue || priority.effectivePriority >= DEFAULT_RECALL_PRIORITY,
  };
}
