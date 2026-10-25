/**
 * Shared date display rules for memory and personal records.
 * Occurrence dates keep the precision that the source actually stated;
 * record dates come from the real persistence time.
 */
export const DATE_UNKNOWN = '日期未明';

const OCCURRED_RE = /^(?:\d{4}-\d{2}(?:-\d{2})?|日期未明)$/;

export function isValidOccurredAt(value) {
  const text = String(value ?? '').trim();
  if (!text || text === DATE_UNKNOWN) return true;
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
  if (!text || !OCCURRED_RE.test(text) || !isValidOccurredAt(text)) return DATE_UNKNOWN;
  return text;
}

/** Render an ISO timestamp as Asia/Shanghai YYYY-MM-DD HH:mm, or 日期未明. */
export function formatRecordedAt(value) {
  const text = String(value ?? '').trim();
  if (!text || text === DATE_UNKNOWN) return DATE_UNKNOWN;
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return DATE_UNKNOWN;
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
}
