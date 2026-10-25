/**
 * Unwrap the value shape returned by DSH 0.2.1-rc.2's MCP client:
 * { content: JsonValue[], structuredContent?: JsonValue }.
 * FastMCP nests JSON tool results under structuredContent.result.
 */
export function unwrapToolValue(result) {
  if (!result || typeof result !== 'object' || result.isError === true) return null;
  const value = result.value;
  if (!value || typeof value !== 'object') return null;
  if (value.structuredContent !== null && typeof value.structuredContent === 'object') {
    const structured = value.structuredContent;
    return structured.result !== undefined ? structured.result : structured;
  }
  if (Array.isArray(value.content)) {
    const block = value.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (!block) return null;
    try {
      return JSON.parse(block.text);
    } catch {
      return { text: block.text };
    }
  }
  return null;
}

/** Produce a short diagnostic string for a failed DSH tool result. */
export function toolFailureText(result) {
  if (!result || typeof result !== 'object') return 'tool returned no result';
  if (result.error && typeof result.error === 'object' && typeof result.error.message === 'string') return result.error.message;
  if (typeof result.error === 'string') return result.error;
  if (Array.isArray(result.content)) {
    const block = result.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (block) return block.text.slice(0, 300);
  }
  return 'tool reported an error';
}
