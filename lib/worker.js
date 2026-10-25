import { captureTurn, resolveCaptureTarget } from './capture.js';
import { maintainIndexes } from './maintenance.js';
import { createRecoveryStore, jobId, observeLocalFacts, retryDelay, mergePending } from './recovery.js';
import { requestedIndexTopic } from './index-pages.js';

/** Reuses the mounted MCP scope and original model; never starts a chat turn. */
export function createMemoryWorker({ config, tools, llm, logger, now, status, available, findAgent }) {
  const store = createRecoveryStore(config);
  const runners = new Map();
  const incoming = new Map();
  let chain = Promise.resolve(), stopped = false, scheduled = 0;
  const warn = (error) => logger?.warn?.('[basic-memory-bridge] recovery pending: ' + (error.code || error.message));
  async function getConfig() {
    let state = await store.read();
    if (!state.naturalDecayStartedAt) {
      await store.update(s => { s.naturalDecayStartedAt ||= new Date(typeof now === 'function' ? now() : now ?? Date.now()).toISOString(); });
      state = await store.read();
    }
    return { ...config, naturalDecayStartedAt: state.naturalDecayStartedAt, now: typeof now === 'function' ? now() : now };
  }
  function serialize(fn) {
    scheduled++;
    const run = chain.then(fn, fn).finally(() => { scheduled--; });
    chain = run.catch(warn);
    return run;
  }
  function runner(id) {
    const own = runners.get(id) || (id ? findAgent?.(id) : null);
    if (own) {
      if (!available(own)) return null;
      runners.set(own.session.id, own);
      return own;
    }
    // Same personal project, still gated by a currently mounted Basic Memory scope.
    return [...runners.values()].reverse().find(available);
  }
  async function pendingStatus() {
    const s = await store.read();
    const owners = new Map();
    for (const p of s.pending) for (const o of p.owners) {
      if (!owners.has(o.sessionId)) owners.set(o.sessionId, []);
      owners.get(o.sessionId).push(p);
    }
    for (const [id, pending] of owners) await status.pending(id, pending);
  }
  async function runCapture(job, agent) {
    await status.set(job.sessionId, job.turn, { state: 'processing', retryAttempt: job.attempts || 0, nextRetryAt: null });
    const state = await store.read();
    const result = await captureTurn({
      ...job, agent, config: { ...await getConfig(), captureProvider: job.target?.provider || '', captureModel: job.target?.model || '' },
      tools, llm, logger, now,
      recovery: {
        id: job.id, actions: job.actions, completed: job.completed,
        externalEdits: Object.fromEntries(Object.entries(state.observed).map(([k, v]) => [k, v.externalEditedAt || 0])),
        prepare: (actions) => store.prepare(job.id, actions),
        checkpoint: (index, value) => store.checkpoint(job.id, index, value),
      },
    });
    const success = !result.partial && (result.persisted || ['no-durable-actions', 'superseded'].includes(result.reason));
    const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
    const completed = Object.values(fresh?.completed || {});
    const count = completed.filter((r) => !r.skipped && !r.duplicate && !r.metadataOnly).length;
    const reinforcedCount = completed.filter(r => r.reinforced).length;
    if (!success) await store.fail(job.id, result.reason || 'capture-failed');
    const retry = (await store.read()).jobs.find((j) => j.id === job.id);
    await status.set(job.sessionId, job.turn, {
      state: success ? result.persisted ? 'saved' : result.reason : 'failed',
      reason: result.reason || (result.error ? 'capture-failed' : ''), count, reinforcedCount,
      retryAttempt: retry?.attempts || job.attempts || 0, nextRetryAt: success ? null : retry?.nextAttemptAt,
    });
    if (success) {
      const requestedTopic = requestedIndexTopic(job.userText);
      if (requestedTopic) await store.update(s => {
        const permalink = 'index-request:' + job.id;
        if (!s.pending.some(p=>p.permalink===permalink)) mergePending(s, {permalink,action:'INDEX_REQUEST',requestedTopic,sessionId:job.sessionId,turn:job.turn});
      });
      await store.finish(job.id);
    }
  }
  async function syncPending(agent, force, trigger) {
    const before = await store.read();
    const old = before.indexMaintenance;
    const candidates = old
      ? old.changes.map(c=>before.pending.find(p=>p.permalink===c.permalink)).filter(Boolean)
      : before.pending.filter((p) => force || p.nextAttemptAt <= Date.now()).slice(0, 10);
    // One named topic per plan; leave other explicit requests in the outbox.
    const request = candidates.find(p=>p.requestedTopic);
    const batch = candidates.filter(p=>!p.requestedTopic || p===request);
    if (!batch.length) return;
    if (old && !force && batch.every(p=>p.nextAttemptAt>Date.now())) return;
    const key = batch.map(p=>p.revision).join(':');
    const saved = old?.key === key ? old.bundle : null;
    await store.update(s=>{s.indexMaintenance={key,changes:batch,bundle:saved};});
    const owners = [...new Map(batch.flatMap((p) => p.owners).map((o) => [o.sessionId + ':' + o.turn, o])).values()];
    if (trigger && !owners.some((o) => o.sessionId === trigger.sessionId && o.turn === trigger.turn)) owners.push(trigger);
    for (const o of owners) await status.set(o.sessionId, o.turn, { maintenance: 'processing' });
    try {
      const result = await maintainIndexes({ config, tools, llm, logger, agent, sessionId: agent.session.id,
        recovery:{saved,save:(bundle)=>store.update(s=>{if(s.indexMaintenance?.key!==key)throw new Error('MAINTENANCE_REPLACED');s.indexMaintenance.bundle=bundle;})},
      }, batch);
      for (const o of owners) {
        const remaining = (await store.read()).pending.filter((p) => !batch.some((b) => b.revision === p.revision) && p.owners.some((owner) => owner.sessionId === o.sessionId));
        await status.pending(o.sessionId, remaining);
        await status.set(o.sessionId, o.turn, { maintenance: remaining.length ? 'pending' : 'saved', pendingCount: remaining.length, indexesUpdated: result.updated, indexesCreated: result.created || 0, profileUpdated: result.profileUpdated });
      }
      // Remove intent only after readback and status writes both succeeded.
      await store.update((s) => { s.pending = s.pending.filter((p) => !batch.some((b) => b.revision === p.revision)); if(s.indexMaintenance?.key===key)delete s.indexMaintenance; });
    } catch (error) {
      warn(error);
      await store.update((s) => {
        // A saved semantic edit cannot be replayed against a changed anchor.
        if (s.indexMaintenance?.key === key && /^(?:INDEX_CHANGED|WRITE_CONFLICT|PROFILE_CHANGED|PROFILE_WRITE_FAILED)$/.test(error.code || error.message)) s.indexMaintenance.bundle = null;
        for (const p of s.pending) if (batch.some((b) => b.revision === p.revision)) {
          p.attempts++;
          p.nextAttemptAt = Date.now() + retryDelay(p.attempts);
          p.reason = error.code || error.message;
        }
      });
      for (const o of owners) await status.set(o.sessionId, o.turn, { maintenance: 'failed', maintenanceReason: 'sync-failed' });
    }
  }
  async function drain({ force = false, trigger } = {}) {
    if (stopped) return;
    await getConfig();
    // If persistence temporarily fails, retain new inputs in RAM for the next tick.
    for (const [id, job] of incoming) { await store.add(job); incoming.delete(id); }
    await observeLocalFacts(config, store);
    const state = await store.read();
    for (const job of state.jobs.filter((j) => force || !j.nextAttemptAt || j.nextAttemptAt <= Date.now()).sort((a, b) => a.sourceEventTime - b.sourceEventTime).slice(0, 5)) {
      const agent = runner(job.sessionId);
      if (!agent || stopped) {
        await status.set(job.sessionId, job.turn, { state: 'queued', reason: 'waiting-memory', count: null });
        continue;
      }
      try { await runCapture(job, agent); }
      catch (error) { await store.fail(job.id, 'recovery-failed'); warn(error); }
    }
    await observeLocalFacts(config, store);
    await pendingStatus();
    const remaining = await store.read();
    const agent = runner(remaining.pending[0]?.owners[0]?.sessionId || remaining.lastSessionId);
    if (agent && !stopped) await syncPending(agent, force, trigger);
  }
  // No polling of chat/model logs. This only wakes the existing local outbox.
  const timer = setInterval(() => { if (!stopped && scheduled === 0) serialize(() => drain()).catch(warn); }, 30_000);
  timer.unref?.();
  return {
    store,
    getConfig,
    accept(state, agent) {
      runners.set(state.sessionId, agent);
      const id = jobId(state.sessionId, state.turn);
      const { userText, assistantText, sourceMessageId, sourceEventSeq, priorUserMessages } = state;
      const job = {
        id, sessionId: state.sessionId, turn: state.turn, userText, assistantText,
        sourceMessageId, sourceEventSeq, priorUserMessages,
        sourceEventTime: state.sourceEventTime || Date.now(), target: resolveCaptureTarget(config, agent),
        attempts: 0, nextAttemptAt: 0, completed: {},
      };
      incoming.set(id, job);
      // Durability must not wait behind an older model call in the worker queue.
      const saved = store.add(job).then(async () => {
        incoming.delete(id);
        await status.set(state.sessionId, state.turn, { state: 'queued', count: 0 });
      });
      saved.catch(warn);
      return serialize(async () => {
        await saved;
        await drain({ force: true, trigger: { sessionId: state.sessionId, turn: state.turn } });
      });
    },
    attach: (agent) => { if (available(agent)) runners.set(agent.session.id, agent); },
    wake: (options) => serialize(() => drain(options)),
    idle: () => chain,
    dispose: () => { stopped = true; clearInterval(timer); return chain; },
  };
}
