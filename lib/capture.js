import { clipText } from './text.js';
import { toolFailureText } from './mcp.js';
import { applyMemoryActions, formatCaptureCandidates, isGrounded, loadCaptureCandidates, parseMemoryActionsDetailed } from './memory.js';
import { shanghaiClock } from './personal-namespace.js';
import { loadPersonalCandidates } from './records.js';

const MAX_INPUT_CHARS = 6000;

function personalEvidenceGrounded(action, userText) {
  // Quoted examples and minimal acknowledgements cannot sustain self-echoes.
  const direct = String(userText).replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ');
  return action.evidence.replace(/[\p{P}\s]/gu, '').length >= 6 && isGrounded(action.evidence, direct);
}

/** Resolve the provider/model used for the background capture call. */
export function resolveCaptureTarget(config, agent) {
  if (config.captureProvider && config.captureModel) {
    return { provider: config.captureProvider, model: config.captureModel };
  }
  try {
    const header = agent?.session?.requestHeader?.()?.config;
    if (header?.provider && header?.model) return { provider: header.provider, model: header.model };
  } catch {
    // fall through to agent options
  }
  const options = agent?.options;
  if (options?.provider && options?.model) return { provider: options.provider, model: options.model };
  return null;
}

export const MEMORY_CAPTURE_SYSTEM_PROMPT = [
  'You maintain durable factual memory for one DSH conversation, stored as independent notes in Basic Memory.',
  'Return JSON only, with no markdown fences and no commentary.',
  'Schema: {"actions":[{"action":"ADD|UPDATE|CORRECT|REINFORCE","kind":"fact|event","category":"preference|fact|decision|relationship","subject":"...","attribute":"...","value":"...","event_summary":"...","occurred_at":"YYYY-MM-DD|YYYY-MM|日期未明","time_expression":"exact relative-time phrase from FINAL USER MESSAGE, or empty","effective_at":"YYYY-MM-DD (optional; UPDATE/CORRECT only, only when the user states it)","target_memory_id":"...","evidence":"..."}]}',
  'Return 0 to 5 actions. Zero actions is a normal result when the turn has no new durable user fact or event.',
  'Only use statements the user explicitly said or confirmed in FINAL USER MESSAGE. Never derive facts from the assistant answer, a recalled note, a quotation, a hypothesis, or your own interpretation.',
  'The evidence field must be an exact contiguous quote from FINAL USER MESSAGE. If no exact quote supports the action, omit the action.',
  'Use ADD for a new fact or event. Use UPDATE when the user states a lasting change to an existing fact value. Use CORRECT when the user explicitly says an existing stored fact was wrong.',
  'For UPDATE or CORRECT, set target_memory_id to the matching CANDIDATES memory_id. If none matches, use ADD only when the statement is genuinely new.',
  'For an explicit ongoing user requirement, add requirement_scope (general, chat, work, or the specific named context) and requirement_lifetime:"ongoing". Reuse the matching candidate subject, attribute, scope and target_memory_id for the SAME semantic topic even when the user rephrases it; do not create synonymous competing standards. Different scopes remain separate. Ordinary factual memories need neither field.',
  'A one-turn/today/this-task-only instruction is not an ongoing personal rule: omit it, or mark requirement_lifetime:"temporary" so storage skips it. Quoted old requirements are history, not new current instructions. For uncertain scope or identity, omit the change rather than guess.',
  'The value of a current requirement contains ONLY what applies now, with its scope. Do not include superseded wording, comparisons with old versions, or a change narrative; code retains the old version separately. If only one clause changes, preserve the other still-valid clauses. The source message time orders changes; file modification time is not a new user statement.',
  'Use REINFORCE when FINAL USER MESSAGE directly restates or confirms the same stored fact/event. Set target_memory_id to that exact candidate and copy its value unchanged. A new value requires UPDATE/CORRECT, not REINFORCE; do not ADD a duplicate. A question merely asking to recall something is NOT confirmation. A quoted example, hypothetical, assistant statement, search/read result, or index maintenance is never reinforcement. Return zero actions for these.',
  'SUBJECTIVE CANDIDATES are her past thoughts/diary, never verified user facts. For these ONLY, REINFORCE may use kind thoughts|diary, target_record and target_entry_id copied exactly from the candidate (no target_memory_id needed), value copied from that entry, and exact current user evidence. Only substantive new user discussion, a new shared experience, or a concrete response to that old idea qualifies. Merely asking to recall, a generic "嗯/是的/记得", the assistant repeating or rewriting its own idea, a quote/example, or a user contradicting that impression does NOT qualify. Do not turn her subjective impressions into ADD/UPDATE/CORRECT user facts. Self-profile is excluded. When uncertain, return no subjective action.',
  'A one-off event such as drinking tea today is an event; it must not overwrite a lasting preference with UPDATE.',
  'A fact is a stable subject/attribute/value. A long-term preference may be a fact with category preference. An event happened at a real date and is not a preference.',
  'occurred_at must come from the user stated date, not today. Use YYYY-MM-DD for a full date, YYYY-MM when only the month is known, and 日期未明 when unknown. Never invent a date.',
  'time_expression must be an exact contiguous quote from FINAL USER MESSAGE when it contains a relative time such as 上周, 前阵子, or 最近; otherwise leave it empty. It is not occurred_at: never turn a relative phrase into a calendar date.',
  'Use EARLIER DIRECT USER MESSAGES only to resolve a pronoun or relative reference in FINAL USER MESSAGE. Never re-store those earlier messages as new facts, and never quote them as evidence.',
  'event_summary must be a short concrete summary of the event, not a preference.',
  'Skip greetings, small talk, transient moods, one-off logistics, secrets or credentials, tool logs, hidden reasoning, and assistant speculation.',
  'Write titles, values, and summaries in the dominant language of FINAL USER MESSAGE.',
  'Never convert the assistant own emotions, preferences, subjective impressions, or content recalled from personal notes into user facts or relationship agreements.',
  'A memory-control request (soften, downweight, forget, stop mentioning, or delete) is not a user fact or preference; never turn it into ADD, UPDATE, or CORRECT.',
].join('\n');

function eventTimeLabel(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const clock = shanghaiClock(new Date(ms));
  return clock.date + ' ' + clock.time + ' Asia/Shanghai';
}

function buildMemoryCapturePrompt({ userText, assistantText, candidates, personalCandidates, sourceEventTime, priorUserMessages }) {
  const user = clipText(String(userText ?? ''), MAX_INPUT_CHARS);
  const assistant = clipText(String(assistantText ?? ''), MAX_INPUT_CHARS);
  const earlier = (Array.isArray(priorUserMessages) ? priorUserMessages : [])
    .map((text) => clipText(String(text ?? ''), 500))
    .filter(Boolean)
    .slice(-3);
  return [
    'CURRENT USER MESSAGE TIME (Asia/Shanghai):',
    eventTimeLabel(sourceEventTime),
    '',
    'EARLIER DIRECT USER MESSAGES (oldest to newest; reference only, never new facts):',
    '<<<EARLIER',
    earlier.length ? earlier.map((text, index) => (index + 1) + '. ' + text).join('\n') : '(none)',
    'EARLIER>>>',
    '',
    'CANDIDATES (existing factual/event notes; may be empty):',
    '<<<CANDIDATES',
    formatCaptureCandidates(candidates),
    'CANDIDATES>>>',
    'SUBJECTIVE CANDIDATES (reference only, not user facts):',
    JSON.stringify(personalCandidates.map(({ kind, targetRecord, targetEntryId, value }) => ({kind, target_record:targetRecord, target_entry_id:targetEntryId, value:clipText(value,500)}))),
    '',
    'FINAL USER MESSAGE:',
    '<<<USER',
    user,
    'USER>>>',
    '',
    'FINAL ASSISTANT ANSWER (context only; never a source of user facts):',
    '<<<ASSISTANT',
    assistant,
    'ASSISTANT>>>',
  ].join('\n');
}

async function synthesizeMemoryActions({ llm, agent, config, sessionId, userText, assistantText, candidates, personalCandidates, sourceEventTime, priorUserMessages, signal }) {
  const target = resolveCaptureTarget(config, agent);
  if (!target) throw new Error('no provider/model available for capture');
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM service unavailable');
  let text = '';
  let finish;
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    system: MEMORY_CAPTURE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildMemoryCapturePrompt({ userText, assistantText, candidates, personalCandidates, sourceEventTime, priorUserMessages }) }] }],
    maxTokens: config.captureMaxTokens,
    temperature: 0.2,
    sessionId,
    signal,
  });
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    throw new Error('capture model call failed: ' + toolFailureText({ error: finish.failure }));
  }
  return { text, finishKind: String(finish?.kind ?? '') };
}

async function captureInner({ sessionId, turn, userText, assistantText, agent, config, tools, llm, signal, now, sourceMessageId, sourceEventSeq, sourceEventTime, priorUserMessages, logger, recovery }) {
  if (!tools || typeof tools.get !== 'function') throw new Error('scoped tool runtime unavailable');
  const ctx = { tools, agent, sessionId, project: config.project, config, vaultPath: config.vaultPath, now, signal, externalEdits: recovery?.externalEdits, strictReads: Boolean(recovery) };
  if (recovery?.actions) return persistActions(recovery.actions);
  signal?.throwIfAborted?.();
  const candidates = await loadCaptureCandidates(ctx, userText);
  const personalCandidates = await loadPersonalCandidates(ctx, userText);
  signal?.throwIfAborted?.();
  const synthesized = await synthesizeMemoryActions({ llm, agent, config, sessionId, userText, assistantText, candidates, personalCandidates, sourceEventTime, priorUserMessages, signal });
  signal?.throwIfAborted?.();

  const parsed = parseMemoryActionsDetailed(synthesized.text);
  const finishKind = String(synthesized.finishKind ?? '');
  const rawLength = synthesized.text.length;

  // A max-token finish means the JSON may be cut off. Do not try to salvage
  // half an action object and do not report this as the normal zero-action case.
  if (/max[-_]?tokens?/i.test(finishKind)) {
    logger?.warn?.(`[basic-memory-bridge] capture stopped at the max token budget for ${sessionId} turn ${turn} (finish=${finishKind}, rawLength=${rawLength}, parse=${parsed.status}); no memory was written`);
    return { persisted: false, reason: 'truncated-output', parse: parsed.status, finish: finishKind, rawLength };
  }

  if (parsed.status === 'invalid' || parsed.status === 'empty-dropped') {
    const reason = parsed.status === 'invalid' ? 'invalid-capture-json' : 'invalid-capture-actions';
    logger?.warn?.(`[basic-memory-bridge] capture output could not be parsed into valid actions for ${sessionId} turn ${turn} (parse=${parsed.status}, rawLength=${rawLength}, skipped=${parsed.skippedItems}); no memory was written`);
    return { persisted: false, reason, parse: parsed.status, finish: finishKind, rawLength };
  }

  const actions = parsed.actions
    .filter((action) => isGrounded(action.evidence, userText))
    .filter(action => !['thoughts','diary'].includes(action.kind) || (personalEvidenceGrounded(action, userText) && personalCandidates.some(p => p.targetRecord === action.targetRecord && p.targetEntryId === action.targetEntryId)))
    .map((action) => {
      const timeExpression = String(action.timeExpression ?? '').trim();
      return {
        ...action,
        ...(['thoughts','diary'].includes(action.kind) ? {entryHash:personalCandidates.find(p => p.targetRecord===action.targetRecord && p.targetEntryId===action.targetEntryId).entryHash} : {}),
        timeExpression: timeExpression && isGrounded(timeExpression, userText) ? timeExpression : '',
      };
    });
  if (actions.length === 0) {
    if (parsed.actions.length && parsed.actions.every(action => ['thoughts','diary'].includes(action.kind))) return { persisted: false, reason: 'no-durable-actions', parse: parsed.status, actions: 0 };
    if (parsed.actions.length > 0) {
      logger?.warn?.(`[basic-memory-bridge] capture actions were not grounded in the final user message for ${sessionId} turn ${turn} (actions=${parsed.actions.length}); no memory was written`);
      return { persisted: false, reason: 'actions-not-grounded', parse: parsed.status, actions: 0 };
    }
    return { persisted: false, reason: 'no-durable-actions', parse: parsed.status, actions: 0 };
  }

  await recovery?.prepare?.(actions);
  return persistActions(actions);

  async function persistActions(actions) {
  const applied = await applyMemoryActions(ctx, actions, {
    sessionId,
    turn,
    messageId: sourceMessageId ?? '',
    eventSeq: sourceEventSeq ?? '',
    sourceEventTime,
    now: now ?? (() => new Date()),
    operationId: recovery?.id,
    completed: recovery?.completed,
    onApplied: recovery?.checkpoint,
  });
  if (applied.results?.length && applied.results.every((r) => r.skipped === 'superseded')) return { persisted: false, reason: 'superseded', result: applied.results };
  if (applied.results?.length && applied.results.every((r) => ['temporary-requirement', 'superseded'].includes(r.skipped))) return { persisted: false, reason: 'no-durable-actions', result: applied.results };
  if (!applied.committed) {
    return { persisted: false, reason: applied.reason ?? 'not-committed', actions: 0 };
  }
  return { persisted: true, partial: Boolean(applied.partial), reason: applied.reason || '', actions: applied.results.length, result: applied.results };
  }
}

/**
 * Synthesize and persist durable memory for one completed turn.
 * Never throws: failures are diagnostics only, and the timeout aborts the work.
 */
export async function captureTurn({ sessionId, turn, userText, assistantText, sourceMessageId, sourceEventSeq, sourceEventTime, priorUserMessages, agent, config, tools, llm, logger, now, recovery }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('capture timeout'));
      resolve('timeout');
    }, config.captureTimeoutMs);
    timer.unref?.();
  });
  const work = captureInner({
    sessionId,
    turn,
    userText,
    assistantText,
    sourceMessageId,
    sourceEventSeq,
    sourceEventTime,
    priorUserMessages,
    agent,
    config,
    tools,
    llm,
    logger,
    signal: controller.signal,
    now,
    recovery,
  });
  work.catch(() => {});
  try {
    const result = await Promise.race([work, timeout]);
    if (result === 'timeout') {
      logger?.warn?.(`[basic-memory-bridge] capture timed out after ${config.captureTimeoutMs}ms for ${sessionId} turn ${turn}`);
      return { persisted: false, timedOut: true, reason: 'timeout' };
    }
    return result;
  } catch (error) {
    logger?.warn?.(`[basic-memory-bridge] capture failed for ${sessionId} turn ${turn}: ${error instanceof Error ? error.message : String(error)}`);
    return { persisted: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
