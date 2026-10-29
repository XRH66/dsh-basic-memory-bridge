import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Config, resolveConfig } from './config.js';
import { createMemoryWorker } from './worker.js';
import { createPermanentDeleteGuard } from './delete-guard.js';
import { makeRecallMessage, collectFactRecall } from './recall.js';
import { createRecordsTool, collectPersonalRecall } from './records.js';
import { createSoftenTool } from './memory.js';
import { compileSpec } from './tool-schema.js';
import { contentText, isDirectUserMessage } from './text.js';
import { collectNavigation } from './navigation.js';
import { CONTEXT_SOURCE, composeMemoryContext, expireMemoryContext, recallConversation } from './context.js';
import { createMemoryStatus } from './status.js';
import { DEFAULT_VAULT_PATH } from './review.js';
import { createTimelineReader } from './timeline.js';
import { createRecentConversationStore, createRecentConversationTool, RECENT_SOURCE } from './recent-context.js';

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
  const timeline = createTimelineReader({ config: resolved, logger, now });
  const recentContext = createRecentConversationStore({config:resolved,logger});
  const report = (id, turn, patch) => memoryStatus.set(id, turn, patch).catch(() => {});
  function reportRecall(id, turn, recall) {
    const state = sessions.get(id);
    if (state?.turn === turn) state.recall = recall;
    return report(id, turn, { recall });
  }

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

  function recentAvailable(agent) {
    return resolved.recentContext && Boolean(resolved.vaultPath) && recallToolsAvailable(agent) && captureToolsAvailable(agent);
  }
  function recentReport(id,turn,stats,extra={}) {
    const {text,rows,messages,...metadata}=stats;
    return report(id,turn,{recentContext:{...metadata,...extra}});
  }
  function saveRecent(sessionId,state,input) {
    if(!state.recentAllowed)return;
    recentContext.record({sessionId,turn:state.turn,...input})
      .then(stats=>recentReport(sessionId,state.turn,stats,{...state.recentSelection}))
      .catch(error=>recentReport(sessionId,state.turn,{enabled:true,storage:'error',reason:'storage-error',error:error.message}));
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
    const wantTimeline = searchReady && resolved.autoRecall && resolved.maxTimelineEntries > 0
      && Boolean(visibleTool('mcp__basic_memory__read_note', agent));
    const wantRecent = recentAvailable(agent);
    if (wantFact || wantPersonal || wantPolicy || resolved.autoCapture || wantRecent) {
      agents.set(sessionId, agent);
      const state = sessions.get(sessionId);
      if (state && state.turn === payload.turn) {state.agent = agent;if(payload.step===1)state.recentAllowed=wantRecent;}
    }
    if (payload.step !== 1) return base;
    // Pre-step precedes step/start. Count only replacements actually committed later.
    const expired = { messages: 0, chars: 0 };
    if (!wantFact && !wantPersonal && !wantPolicy && !wantTimeline && !wantRecent) {
      await recentReport(sessionId,payload.turn,{enabled:false,storage:'disabled',reason:resolved.recentContext?'memory-unavailable':'disabled',capacityTokens:resolved.recentContextTokens,injectedChars:0,items:[]});
      await reportRecall(sessionId, payload.turn, { reason: searchReady ? 'disabled' : 'memory-unavailable', totalChars: 0, channels: {}, expired });
      return base;
    }
    const pending = Array.isArray(payload.messages) ? payload.messages.filter(isDirectUserMessage) : [];
    if (pending.length === 0) return base;
    const directMessages = recallConversation(agent.session, pending);

    const key = `${sessionId}:${payload.turn}`;
    if (recalledTurns.has(key)) return base;
    recalledTurns.add(key);
    trimSet(recalledTurns, MAX_TRACKED_KEYS);

    if (payload.signal?.aborted) return base;
    try {
      const runtimeConfig = await worker.getConfig();
      const fact = { reason: 'disabled' }, personal = { reason: 'disabled' }, navigation = { reason: 'disabled' };
      const [factNotes, personalNotes, navigationNotes, recent, profile] = await Promise.all([
        wantFact
          ? collectFactRecall({
              diagnostics: fact,
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools,
              logger,
            })
          : Promise.resolve([]),
        wantPersonal
          ? collectPersonalRecall({
              diagnostics: personal,
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools,
              logger,
            })
          : Promise.resolve([]),
        wantFact && resolved.maxIndexNotes > 0
          ? collectNavigation({ diagnostics: navigation, messages: directMessages, sessionId, agent, config: runtimeConfig, tools, logger })
          : Promise.resolve([]),
        wantTimeline
          ? timeline.read({ sessionId, config: runtimeConfig, signal: payload.signal })
          : Promise.resolve({ text: '', stats: { state: 'disabled', entries: 0, chars: 0 } }),
        resolved.vaultPath ? readFile(path.join(resolved.vaultPath,'dafeiyu/thoughts/自我档案.md'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}) : Promise.resolve(''),
      ]);
      if (payload.signal?.aborted) return base;
      const appended = [];
      const visibleMessages=[...(agent.session.deriveMessages?.()||[]),...pending];
      const recentPage=wantRecent?await recentContext.page({sessionId,turn:payload.turn,
        excludeMessageIds:visibleMessages.map(m=>m.id).filter(Boolean),maxChars:Math.floor(resolved.maxContextChars*0.6)})
        .catch(error=>({enabled:true,storage:'error',reason:'storage-error',error:error.message,text:'',items:[]})):null;
      const recentChars=recentPage?.text.length||0;
      const packed=composeMemoryContext({facts:factNotes,personal:personalNotes,navigation:navigationNotes,timeline:recent.entries||[],
        messages:directMessages,profilePresent:profile.includes('<!-- dafeiyu-record kind=thoughts -->'),config:{...runtimeConfig,sessionId,maxContextChars:resolved.maxContextChars-recentChars}});
      if(packed.text)appended.push(makeRecallMessage(packed.text,CONTEXT_SOURCE));
      if (wantPolicy) appended.push(makeControlPolicyMessage());
      if(recentPage?.text)appended.push(makeRecallMessage(recentPage.text,RECENT_SOURCE));
      const recentSelection={injectedChars:recentChars,items:recentPage?.items||[],olderAvailable:recentPage?.olderAvailable||false,beforeId:recentPage?.beforeId||null,reason:recentPage?.reason||(wantRecent?'empty':'disabled')};
      const state=sessions.get(sessionId);if(state)state.recentSelection=recentSelection;
      await recentReport(sessionId,payload.turn,recentPage||{enabled:false,storage:'disabled',capacityTokens:resolved.recentContextTokens},recentSelection);
      if (wantTimeline) {
        report(sessionId, payload.turn, { timeline: recent.stats });
      }
      const previous = (await memoryStatus.get(sessionId)).jobs.filter(j => j.turn < payload.turn).at(-1)?.recall;
      const channel = (details, text, budget) => ({ ...details, chars: text.length,
        count: details.items?.length ?? details.entries ?? 0, budget,
        fingerprint: text ? createHash('sha256').update(text).digest('hex') : null });
      const channels = {
        policy: channel({ reason: wantPolicy ? 'control-rules' : 'disabled' }, wantPolicy ? contentText(makeControlPolicyMessage().content) : '', null),
        recentContext:channel({...recentSelection,count:recentSelection.items.length},recentPage?.text||'',resolved.maxContextChars),
      };
      const diagnostic={facts:fact,personal,navigation,timeline:{...recent.stats,reason:recent.stats.state==='ready'?'recent-window':recent.stats.state==='disabled'?'disabled':'timeline-unavailable'}};
      for(const name of ['facts','personal','navigation','timeline']){
        const selected=packed.channels[name];
        channels[name]={...diagnostic[name],...selected,count:selected.items.length,budget:resolved.maxContextChars,
          fingerprint:selected.items.length?createHash('sha256').update(JSON.stringify(selected.items)+packed.text).digest('hex'):null};
      }
      for (const [name, detail] of Object.entries(channels)) detail.repeatedChars = detail.fingerprint && detail.fingerprint === previous?.channels?.[name]?.fingerprint ? detail.chars : 0;
      await reportRecall(sessionId, payload.turn, { channels, totalChars:appended.reduce((n,m)=>n+contentText(m.content).length,0),contextChars:packed.text.length+recentChars,
        contextBudget:resolved.maxContextChars,expired,overheadChars:packed.overheadChars,repeatedChars: Object.values(channels).reduce((n,c) => n+c.repeatedChars,0) });
      if (appended.length === 0) return base;
      // Native pre-step commits this array in order: contextual additions first,
      // actual human messages last, with their existing identities untouched.
      const original=base.messages||[];
      return { ...base, messages: [...original.filter(m=>!isDirectUserMessage(m)),...appended,...original.filter(isDirectUserMessage)] };
    } catch (error) {
      logger?.warn?.(`[basic-memory-bridge] recall hook failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return base;
    }
  }

  async function onRequest(payload, next) {
    const session = payload?.agent?.session;
    const state = sessions.get(session?.id);
    if (payload.step === 1 && state?.turn === payload.turn && !state.expired) {
      // Native agent/request runs after step/start publication, before new input
      // is admitted. session/event itself forbids reentrant append. Clean once
      // per turn, including pure mode, so retries retain this turn's additions.
      state.expired = expireMemoryContext(session, payload);
      await reportRecall(session.id, payload.turn, { ...state.recall, expired: state.expired });
    }
    return next();
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
        recentAllowed:false,
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
          const agent=state.agent||findAgent?.(sessionId);
          if(agent&&!state.agent){state.agent=agent;state.recentAllowed=recentAvailable(agent);}
          saveRecent(sessionId,state,{user:{id:state.sourceMessageId,text,seq:state.sourceEventSeq,
            time:new Date(state.sourceEventTime||(now?now():new Date()).getTime()).toISOString(),timeKind:state.sourceEventTime?'message':'recorded'}});
        }
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (data.turn === state.turn) {
        state.assistantText = contentText(data.message?.content).trim();
        state.assistantInterrupted = data.interrupted === true;
        state.assistantMessageId=String(data.message?.id||`${sessionId}:event:${event.seq}`);
        state.assistantEventSeq=Number(event.seq??0);
      }
      return;
    }

    if (event.type !== 'turn/end') return;
    if (data.turn !== state.turn) return;

    const agent = state.agent;
    sessions.delete(sessionId);
    agents.delete(sessionId);

    const completed = data.reason?.kind === 'completed';
    saveRecent(sessionId,state,{status:completed&&!state.assistantInterrupted?'completed':'interrupted',
      assistant:state.assistantText?{id:state.assistantMessageId,text:state.assistantText,seq:state.assistantEventSeq}:null});
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

  async function waitForIdle() { await recentContext.idle();await worker.idle(); }

  return {
    config: resolved,
    onPreStep,
    onRequest,
    onSessionEvent,
    waitForIdle,
    retryPending: worker.wake,
    getRecoveryState: worker.store.read,
    getMemoryConfig: worker.getConfig,
    dispose: async()=>{await recentContext.idle();await worker.dispose();},
    recentContext,
    recentTool:createRecentConversationTool({store:recentContext,available:recentAvailable,config:resolved,
      onRead:async(agent,page)=>{const state=sessions.get(agent?.session?.id);if(state)await report(agent.session.id,state.turn,{recentRead:{items:page.items,beforeId:page.beforeId,chars:page.text?.length||0}});}}),
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
  for (const tool of [recordsTool, softenTool, bridge.recentTool]) {
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
  ctx.on('agent/request', bridge.onRequest, { prepend: true });
  ctx.on('session/event', bridge.onSessionEvent);
  ctx.on('tools/change', bridge.refreshPermanentDeleteProtection);
  ctx.on('basic-memory/retry-session', request => {
    if (!/^session-[a-zA-Z0-9-]{1,100}$/.test(request.sessionId || '')) return;
    request.accepted = true;
    bridge.retryPending({ resumeSessionId: request.sessionId }).catch(error => ctx.logger?.warn?.('[basic-memory-bridge] manual retry pending: ' + error.message));
  });
  ctx.on('dispose', bridge.dispose);
  return bridge;
}

export { Config };
