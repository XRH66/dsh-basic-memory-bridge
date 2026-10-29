import { randomUUID } from 'node:crypto';

const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
/** Harness usage is cumulative. Cache reads/writes are separate from uncached input. */
export function normalizeUsage(usage) {
  if (!usage) return null;
  const output = number(usage.outputTokens), total = number(usage.totalTokens);
  const uncached = number(usage.inputTokens), cached = number(usage.cacheReadTokens);
  const cacheWrite = number(usage.cacheWriteTokens);
  const input = total !== null && output !== null && total >= output
    ? total - output : uncached === null ? null : uncached + (cached ?? 0) + (cacheWrite ?? 0);
  return { input, output, total: total ?? (input !== null && output !== null ? input + output : null),
    cached, cacheWrite, uncached };
}

/** Observe the existing two background callers; never starts an extra request. */
export function measuredLlm(llm, report, context) {
  return { async *stream(options) {
    const record = { id: randomUUID(), ...context, provider: options.provider, model: options.model,
      at: new Date().toISOString(), state: 'running', usage: null };
    const save = async () => { try { await report(structuredClone(record)); } catch { /* telemetry must not replay a successful write */ } };
    const started = Date.now();
    await save();
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'usage' || chunk.type === 'finish' && chunk.usage) record.usage = normalizeUsage(chunk.usage);
        if (chunk.type === 'finish') record.finish = chunk.reason?.kind;
        yield chunk;
      }
      record.state = /error|abort/i.test(record.finish || '') ? 'failed' : 'finished';
    } catch (error) { record.state = 'failed'; throw error; }
    finally { if (record.state === 'failed' && record.usage?.total === 0) record.usage = null; record.elapsedMs = Date.now() - started; await save(); }
  } };
}
