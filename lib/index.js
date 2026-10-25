import { randomUUID } from 'node:crypto';
import { Config, resolveConfig } from './config.js';
import { createMemoryWorker } from './worker.js';
import { createPermanentDeleteGuard } from './delete-guard.js';
import { makePersonalRecallMessage, makeRecallMessage, recallForTurn } from './recall.js';
import { createRecordsTool, recallPersonalForTurn } from './records.js';
import { createSoftenTool } from './memory.js';
import { compileSpec } from './tool-schema.js';
import { contentText, isDirectUserMessage } from './text.js';
import { recallNavigation } from './navigation.js';
import { createMemoryStatus } from './status.js';
import { DEFAULT_VAULT_PATH } from './review.js';

export const name = 'basic-memory-bridge';
export const inject = ['tools', 'llm', 'agents'];

const MAX_TRACKED_KEYS = 1000;

function trimSet(set, maxSize) {
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

/**
 * Build the bridge's hook handlers with injected services, so the same logic is
 * usable from the Cordis plugin and from unit tests.
 */
export function createBridge({ config, tools, llm, logger, now, findAgent } = {}) {
  const resolved = resolveConfig(config);
  const sessions = new Map();
  const agents = new Map();
  const recalledTurns = new Set();
  const enqueuedTurns = new Set();
  const deleteGuard = createPermanentDeleteGuard({ tools, logger });
  const memoryStatus = createMemoryStatus(resolved, logger);
  const report = (id, turn, patch) => memoryStatus.set(id, turn, patch).catch(() => {});

  /**
   * Resolve one MCP definition through the live agent scope. This is a
   * read-only probe: it never mounts a server or rewrites session settings.
   * Missing runtimes, missing definitions, thrown lookups and definitions
   * without execute are all treated as unavailable.
   */
  function visibleTool(toolName, agent) {
    if (!agent || typeof tools?.get !== 'function') return null;
    try {
      const definition = tools.get(toolName, agent);
      return definition && typeof definition.execute === 'function' ? definition : null;
    } catch {
      return null;
    }
  }

  function recallToolsAvailable(agent) {
    return Boolean(visibleTool('mcp__basic_memory__search_notes', agent));
  }

  function captureToolsAvailable(agent) {
    return Boolean(
      visibleTool('mcp__basic_memory__read_note', agent)
      && visibleTool('mcp__basic_memory__write_note', agent),
    );
  }

  function softenerAvailable(agent) {
    return Boolean(visibleTool('soften_memory', agent));
  }

  /** Keep only direct user words from before the current user/message event. */
  function earlierDirectUserMessages(session, currentId) {
    try {
      const messages = session?.deriveMessages?.();
      if (!Array.isArray(messages)) return [];
      const direct = messages.filter((message) => isDirectUserMessage(message));
      const current = currentId ? direct.findIndex((message) => String(message.id) === String(currentId)) : -1;
      const earlier = current >= 0 ? direct.slice(0, current) : (currentId ? direct : direct.slice(0, -1));
      return earlier
        .map((message) => contentText(message.content).trim())
        .filter(Boolean)
        .slice(-3);
    } catch {
      return [];
    }
  }

  function makeControlPolicyMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '<memory_control_policy source="dafeiyu">',
          'When the user explicitly asks to stop bringing up, downweight, soften, or forget one specific stored memory, use the soften_memory tool.',
          'First locate the exact target with search/read or an id/permalink already in context. If several notes match, ask which one.',
          'Call soften_memory only after the target is unambiguous, and do not confirm a downweight before the tool succeeds.',
          'A phrase such as 别忘了 or 我忘了 by itself is not a downweight request.',
          'Ordinary user facts and events are handled by the existing automatic turn-end capture; do not call write_note, edit_note, or move_note on bridge-managed notes under chats/facts, chats/events, or chats/history in the foreground, because that bypasses the bridge history and versioning. Search and read are allowed.',
          'This restriction does not apply to dafeiyu_records subjective notes or to soften_memory; a downweight must still be executed and succeed in the foreground before you confirm it.',
          'When the user corrects something, acknowledge it naturally and let the turn-end capture persist it; do not claim the disk has already been updated.',
          'This policy is not user memory and must never be stored as a fact.',
          '</memory_control_policy>',
        ].join('\n'),
      }],
      source: { kind: 'dafeiyu-memory-control', form: 'policy' },
    };
  }

  /**
   * A successful soften call belongs to the current turn. Capture must not
   * turn that memory-control instruction into a new fact for the same turn.
   * This is an in-memory turn marker, not a disable switch for later turns.
   */
  function markSoftened(sessionId) {
    const state = sessions.get(sessionId);
    if (state) state.captureSuppressed = true;
  }

  const worker = createMemoryWorker({
    config: resolved, tools, llm, logger, now, status: memoryStatus, findAgent,
    available: (agent) => resolved.autoCapture && captureToolsAvailable(agent),
  });

  async function onPreStep(payload, next) {
    const decision = await next();
    if (!decision || decision.kind !== 'enter') return decision;

    const sessionId = payload?.agent?.session?.id;
    const agent = payload?.agent;
    if (!sessionId || !agent) return decision;
    deleteGuard.protect(agent);
    worker.attach(agent);

    const base = decision;
    const searchReady = recallToolsAvailable(agent);
    const wantFact = searchReady && resolved.autoRecall;
    const wantPersonal = searchReady && resolved.personalRecall;
    const wantPolicy = searchReady && softenerAvailable(agent);
    if (wantFact || wantPersonal || wantPolicy || resolved.autoCapture) {
      agents.set(sessionId, agent);
      const state = sessions.get(sessionId);
      if (state && state.turn === payload.turn) state.agent = agent;
    }
    if (payload.step !== 1 || (!wantFact && !wantPersonal && !wantPolicy)) return base;
    const directMessages = Array.isArray(payload.messages) ? payload.messages.filter(isDirectUserMessage) : [];
    if (directMessages.length === 0) return base;

    const key = `${sessionId}:${payload.turn}`;
    if (recalledTurns.has(key)) return base;
    recalledTurns.add(key);
    trimSet(recalledTurns, MAX_TRACKED_KEYS);

    if (payload.signal?.aborted) return base;
    try {
      const runtimeConfig = await worker.getConfig();
      const [factText, personalText, navigationText] = await Promise.all([
        wantFact
          ? recallForTurn({
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools,
              logger,
            })
          : Promise.resolve(''),
        wantPersonal
          ? recallPersonalForTurn({
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools,
              logger,
            })
          : Promise.resolve(''),
        wantFact && resolved.maxIndexNotes > 0
          ? recallNavigation({ messages: directMessages, sessionId, agent, config: runtimeConfig, tools, logger })
          : Promise.resolve(''),
      ]);
      if (payload.signal?.aborted) return base;
      const appended = [];
      if (factText) appended.push(makeRecallMessage(factText));
      if (personalText) appended.push(makePersonalRecallMessage(personalText));
      if (navigationText) {
        const message = makeRecallMessage(navigationText);
        appended.push({ ...message, source: { kind: 'basic-memory-navigation', form: 'recall' } });
      }
      if (wantPolicy) appended.push(makeControlPolicyMessage());
      if (appended.length === 0) return base;
      return { ...base, messages: [...(base.messages ?? []), ...appended] };
    } catch (error) {
      logger?.warn?.(`[basic-memory-bridge] recall hook failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return base;
    }
  }

  function onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? {};

    if (event.type === 'turn/start') {
      sessions.set(sessionId, {
        turn: data.turn,
        agent: agents.get(sessionId),
        userText: '',
        assistantText: '',
        assistantInterrupted: false,
        captureSuppressed: false,
        sourceMessageId: '',
        sourceEventSeq: 0,
        sourceEventTime: 0,
        priorUserMessages: [],
      });
      return;
    }

    const state = sessions.get(sessionId);
    if (!state) return;

    if (event.type === 'user/message') {
      if (isDirectUserMessage(data)) {
        const text = contentText(data.content).trim();
        if (text.length > 0) {
          state.userText = text;
          state.sourceMessageId = String(data.id ?? data.message?.id ?? '');
          state.sourceEventSeq = Number(event.seq ?? 0) || 0;
          const eventTime = Number(event.time ?? 0);
          state.sourceEventTime = Number.isFinite(eventTime) && eventTime > 0 ? eventTime : 0;
          state.priorUserMessages = earlierDirectUserMessages(session, state.sourceMessageId);
        }
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (data.turn === state.turn) {
        state.assistantText = contentText(data.message?.content).trim();
        state.assistantInterrupted = data.interrupted === true;
      }
      return;
    }

    if (event.type !== 'turn/end') return;
    if (data.turn !== state.turn) return;

    const agent = state.agent;
    sessions.delete(sessionId);
    agents.delete(sessionId);

    const completed = data.reason?.kind === 'completed';
    if (!resolved.autoCapture || !completed || state.assistantInterrupted || state.userText.length === 0 || state.assistantText.length === 0) {
      report(sessionId, state.turn, { state: 'skipped', reason: completed ? 'disabled-or-empty' : 'turn-interrupted' });
      return;
    }
    if (state.captureSuppressed) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'memory-control' });
      return;
    }
    if (!agent) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'no-agent' });
      logger?.warn?.(`[basic-memory-bridge] capture skipped for ${sessionId}: no agent was observed before the turn ended`);
      return;
    }
    if (!captureToolsAvailable(agent)) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'memory-disabled' });
      logger?.warn?.(`[basic-memory-bridge] capture skipped for ${sessionId}: basic_memory read_note/write_note are not visible`);
      return;
    }

    const key = `${sessionId}:${state.turn}`;
    if (enqueuedTurns.has(key)) return;
    enqueuedTurns.add(key);
    trimSet(enqueuedTurns, MAX_TRACKED_KEYS);
    worker.accept({ ...state, sessionId }, agent).catch((error) => {
      logger?.warn?.('[basic-memory-bridge] capture queued in RAM; persistence retry pending: ' + error.message);
      report(sessionId, state.turn, { state: 'failed', reason: 'queue-write-failed', count: null });
    });
  }

  function waitForIdle() { return worker.idle(); }

  return {
    config: resolved,
    onPreStep,
    onSessionEvent,
    waitForIdle,
    retryPending: worker.wake,
    getRecoveryState: worker.store.read,
    getMemoryConfig: worker.getConfig,
    dispose: worker.dispose,
    markSoftened,
    getMemoryStatus: memoryStatus.get,
    refreshPermanentDeleteProtection: deleteGuard.refresh,
  };
}

/** Register the bridge on a Cordis context. */
export function apply(ctx, rawConfig) {
  // Use the same existing default Vault as records/review when production omits it.
  // Core-only tests can still use createBridge without a filesystem store.
  const config = resolveConfig({ ...rawConfig, vaultPath: rawConfig?.vaultPath || DEFAULT_VAULT_PATH });
  const bridge = createBridge({
    config,
    tools: ctx.tools,
    llm: ctx.llm,
    logger: ctx.logger,
    findAgent: (id) => ctx.agents?.get?.(id),
  });

  const recordsTool = createRecordsTool({
    tools: ctx.tools,
    config,
    getConfig: bridge.getMemoryConfig,
    logger: ctx.logger,
    now: () => new Date(),
  });
  const softenTool = createSoftenTool({
    tools: ctx.tools,
    config,
    getConfig: bridge.getMemoryConfig,
    logger: ctx.logger,
    now: () => new Date(),
    onSoftened: (sessionId) => bridge.markSoftened(sessionId),
  });
  for (const tool of [recordsTool, softenTool]) {
    const disposeTool = ctx.tools.register({
      ...tool,
      parameters: compileSpec(tool.parameters),
    });
    if (typeof disposeTool === 'function') {
      ctx.on('dispose', () => {
        try {
          disposeTool();
        } catch {
          // ignore double-dispose
        }
      });
    }
  }
  ctx.on('agent/pre-step', bridge.onPreStep, { prepend: true });
  ctx.on('session/event', bridge.onSessionEvent);
  ctx.on('tools/change', bridge.refreshPermanentDeleteProtection);
  ctx.on('dispose', bridge.dispose);
  return bridge;
}

export { Config };
