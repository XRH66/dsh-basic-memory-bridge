/** Return the plain text blocks of a message content array. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/** Whether a session message came from the human user rather than synthetic context. */
export function isDirectUserMessage(message) {
  return Boolean(message && message.role === 'user' && message.source && message.source.kind === 'user');
}

/** Collapse all whitespace runs into single spaces. */
export function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Clip plain text to a maximum length, preserving whole characters. */
export function clipText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}
