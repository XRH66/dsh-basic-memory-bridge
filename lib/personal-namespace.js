/** Shared personal-record namespace helpers for the dafeiyu records. */
export const PERSONAL_ROOT = 'dafeiyu';
export const PERSONAL_KINDS = Object.freeze(['thoughts', 'diary', 'gallery', 'people']);
export const PERSONAL_TAGS = Object.freeze(['dafeiyu', 'subjective']);
export const DIARY_DAILY_LIMIT = 3;
export const PERSONAL_TIME_ZONE = 'Asia/Shanghai';

/** True when a Basic Memory permalink points into the personal namespace. */
export function isPersonalPermalink(permalink) {
  return /(^|\/)dafeiyu(\/|$)/i.test(String(permalink ?? ''));
}

/** Directory for one personal record kind. */
export function personalDirectory(kind) {
  return `${PERSONAL_ROOT}/${kind}`;
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Basic Memory returns canonical permalinks prefixed with the project
 * (for example `personal/dafeiyu/thoughts/...`), while the Vault-relative
 * directory stays `dafeiyu/thoughts`. Strip only the configured project
 * prefix, then normalize to the exact `dafeiyu/<kind>/...` record path.
 * Returns '' for traversal, query fragments, cross-project, cross-kind or
 * factual paths.
 */
export function personalRecordPath(kind, permalink, project = '') {
  const raw = String(permalink ?? '').trim();
  if (!raw || /\.\.|[?#]/.test(raw) || raw.includes('\0')) return '';
  const normalized = normalizePath(raw);
  const scope = normalizePath(project);
  let relative = normalized;
  if (scope && normalized.toLowerCase().startsWith(scope.toLowerCase() + '/')) {
    relative = normalized.slice(scope.length + 1);
  }
  const prefix = `${PERSONAL_ROOT}/${kind}/`;
  if (relative.length <= prefix.length) return '';
  if (!relative.toLowerCase().startsWith(prefix.toLowerCase())) return '';
  if (relative.slice(prefix.length).split('/').some((part) => part === '' || part === '.')) return '';
  return relative;
}

/** Canonical identifier accepted by Basic Memory read_note/delete_note. */
export function memoryIdentifier(value, project = '') {
  const normalized = normalizePath(value);
  const scope = normalizePath(project);
  if (!normalized) return '';
  if (!scope) return normalized;
  if (normalized.toLowerCase().startsWith(scope.toLowerCase() + '/')) return normalized;
  return `${scope}/${normalized}`;
}

/** Parent directory of a normalized personal record permalink. */
export function personalParentDirectory(kind, permalink, project = '') {
  const normalized = personalRecordPath(kind, permalink, project);
  if (!normalized) return '';
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

/** Wall clock in the personal time zone, formatted for note headings. */
export function shanghaiClock(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PERSONAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${pick('hour')}:${pick('minute')}`,
    stamp: `${pick('hour')}${pick('minute')}${pick('second')}`,
    iso: date.toISOString(),
  };
}
