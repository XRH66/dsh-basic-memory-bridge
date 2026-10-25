import { createHash, randomUUID } from 'node:crypto';
import { carryPriority, priorityFromMetadata } from './priority.js';

// One hidden annotation per existing HH:mm block; no second database or files.
export const ENTRY_MARKER = '<!-- dsh-entry:';
export const entryFingerprint = text => createHash('sha256').update(String(text).normalize('NFKC').replace(/\s+/gu, ' ').trim()).digest('hex');
export function entryManaged(kind, name = '') {
  return ['thoughts', 'diary'].includes(kind) && !/(?:^|[/\\])自我档案(?:\.md)?$/.test(String(name));
}
export function entryId(entry, index) {
  return entry.memory?.id || 'legacy-' + entryFingerprint([index, entry.time, entry.recordedAt, entry.text].join('\n')).slice(0, 24);
}
export function entryRecordedAt(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text.replace(' ', 'T') + ':00+08:00';
  return /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}
export function parseEntryMarker(line) {
  const match = /^<!-- dsh-entry:(\{.*\}) -->$/.exec(line.trim());
  if (!match) return null;
  const state = JSON.parse(match[1]);
  if (!state || !/^[a-zA-Z0-9-]{1,80}$/.test(state.id)) throw new Error('INVALID_ENTRY_STATE');
  return state;
}
export const renderEntryMarker = state => ENTRY_MARKER + JSON.stringify(state) + ' -->';

/** Newer explicit whole-note softening still applies, but never refreshes age. */
export function entryMetadata(entry, noteMetadata = {}, config = {}) {
  const recordedAt = entryRecordedAt(entry.recordedAt);
  const inherited = { ...carryPriority(noteMetadata), recorded_at: recordedAt };
  const own = entry.memory;
  if (!own) return inherited;
  const meta = { ...carryPriority(own), recorded_at: own.recorded_at || recordedAt };
  const softenAt = Date.parse(noteMetadata.softened_at) || 0;
  const anchor = Date.parse(meta.decay_anchor_at || meta.recorded_at || config.naturalDecayStartedAt) || 0;
  if (softenAt > anchor) {
    const atSoften = priorityFromMetadata(meta, { ...config, now: softenAt });
    const note = priorityFromMetadata(noteMetadata, { ...config, now: softenAt });
    Object.assign(meta, {
      base_priority: Math.min(note.basePriority, Math.max(atSoften.priorityFloor, atSoften.effectivePriority * Number(noteMetadata.soften_factor || .5))),
      decay_anchor_at: noteMetadata.softened_at,
      softened_at: noteMetadata.softened_at,
    });
  }
  return meta;
}

/** Migrate only on an actual write; no guessed occurrence/recording dates. */
export function materializeEntry(entry, index, noteMetadata, config = {}, { fresh = false, at } = {}) {
  if (entry.memory) return entry;
  const meta = fresh ? { recorded_at: entryRecordedAt(entry.recordedAt), base_priority: 1, decay_anchor_at: at } : entryMetadata(entry, noteMetadata, config);
  const priority = priorityFromMetadata(meta, config);
  return { ...entry, memory: {
    id: fresh ? randomUUID() : entryId(entry, index),
    ...carryPriority(meta),
    ...(meta.recorded_at ? { recorded_at: meta.recorded_at } : {}),
    ...(priority.decayAnchorAt ? { decay_anchor_at: priority.decayAnchorAt } : {}),
  } };
}

/** Replace only this entry's annotation, preserving every human-written byte. */
export function replaceEntryMarker(content, index, state) {
  const lines = String(content).split(/(?<=\n)/);
  let current = 0, heading = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) if (/^\s*##\s+\d{2}:\d{2}\s*$/.test(lines[i])) {
    current++;
    if (current === index) heading = i;
    else if (current === index + 1) { end = i; break; }
  }
  if (heading < 0) throw new Error('ENTRY_NOT_FOUND');
  const newline = lines[heading].endsWith('\r\n') ? '\r\n' : '\n';
  for (let i = heading + 1; i < end; i++) if (lines[i].trim().startsWith(ENTRY_MARKER)) {
    lines[i] = renderEntryMarker(state) + newline;
    return lines.join('');
  }
  if (!lines[heading].endsWith('\n')) lines[heading] += newline;
  lines.splice(heading + 1, 0, renderEntryMarker(state) + newline);
  return lines.join('');
}
