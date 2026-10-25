import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { managementDirectory } from './review.js';
import { factValue } from './navigation.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');
export const retryDelay = (attempt) => Math.min(30 * 60_000, 30_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
export const jobId = (sessionId, turn) => hash(sessionId + ':' + turn);

/** One local outbox. Payload/checkpoints and synchronization intent commit together. */
export function createRecoveryStore(config) {
  const directory = config.vaultPath ? path.join(managementDirectory(config), 'memory-status') : '';
  const file = directory ? path.join(directory, 'recovery.json') : '';
  let value;
  let chain = Promise.resolve();
  async function load() {
    if (value) return value;
    if (file) {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.version !== 1 || saved.project !== config.project || !Array.isArray(saved.jobs) || !Array.isArray(saved.pending)) throw new Error('INVALID_RECOVERY_STORE');
        value = saved;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    value ??= { version: 1, project: config.project, jobs: [], pending: [], observed: {}, initialized: false };
    if (directory && !value.legacyImported) {
      // Previous versions already persisted synchronization intent, but no capture payload.
      let names = [];
      try { names = await fs.readdir(directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
        const previous = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
        if (previous.version !== 1 || !previous.sessionId) continue;
        for (const pending of previous.pending || []) if (!value.pending.some((p) => p.permalink === pending.permalink)) mergePending(value, { ...pending, sessionId: previous.sessionId, turn: previous.jobs?.at(-1)?.turn || 0 });
      }
      value.legacyImported = true;
    }
    return value;
  }
  function serial(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }
  async function persist(next) {
    if (file) {
      await fs.mkdir(directory, { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temp, 'wx');
        try { await handle.writeFile(JSON.stringify(next, null, 2)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }); }
    }
    value = next; // Never update the cache before the durable write succeeds.
  }
  function update(fn) {
    return serial(async () => {
      const next = structuredClone(await load());
      const result = fn(next);
      await persist(next);
      return result;
    });
  }
  return {
    read: () => serial(async () => structuredClone(await load())),
    update,
    add: (job) => update((s) => {
      if (!s.jobs.some((j) => j.id === job.id)) s.jobs.push(job);
      if (job.sessionId) s.lastSessionId = job.sessionId;
    }),
    prepare: (id, actions) => update((s) => { const j = s.jobs.find((j) => j.id === id); if (j) j.actions = actions; }),
    checkpoint: (id, index, result) => update((s) => {
      const j = s.jobs.find((j) => j.id === id);
      if (!j) throw new Error('RECOVERY_JOB_MISSING');
      (j.completed ??= {})[index] = result;
      if (result.permalink && !result.skipped && !result.metadataOnly) mergePending(s, { ...result, action: result.updatedExisting ? 'UPDATE' : result.action, sessionId: j.sessionId, turn: j.turn });
    }),
    finish: (id) => update((s) => { s.jobs = s.jobs.filter((j) => j.id !== id); }),
    fail: (id, reason) => update((s) => {
      const j = s.jobs.find((j) => j.id === id);
      if (!j) return;
      j.attempts = (j.attempts ?? 0) + 1;
      j.nextAttemptAt = Date.now() + retryDelay(j.attempts);
      j.reason = reason;
    }),
  };
}

export function mergePending(state, change) {
  const previous = state.pending.find((p) => p.permalink === change.permalink);
  const owners = [...(previous?.owners ?? [])];
  if (change.sessionId && !owners.some((o) => o.sessionId === change.sessionId && o.turn === change.turn)) owners.push({ sessionId: change.sessionId, turn: change.turn });
  const next = {
    permalink: change.permalink, memoryId: change.memoryId, action: change.action || 'CORRECT',
    owners, revision: randomUUID(), attempts: 0, nextAttemptAt: 0,
    expectedValue: change.expectedValue, external: Boolean(change.external),
    requestedTopic: change.requestedTopic,
  };
  if (previous) Object.assign(previous, next);
  else state.pending.push(next);
}

// Read only managed facts/events. Metadata-only changes and subjective notes do
// not cause loops; no model calls or writes to the Vault happen in this scanner.
export async function observeLocalFacts(config, store) {
  if (!config.vaultPath) return;
  const current = {};
  for (const kind of ['facts', 'events']) {
    const directory = path.join(config.vaultPath, config.captureFolder, kind);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(directory, entry.name);
      const stat = await fs.stat(full);
      const text = await fs.readFile(full, 'utf8');
      if (!text.includes('<!-- dsh-fact-memory -->') || /^qa_fixture:\s*['"]?true/m.test(text)) continue;
      const field = (name) => new RegExp('^' + name + ':\\s*([^\\r\\n]+)', 'm').exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
      const permalink = field('permalink');
      if (!permalink.startsWith(config.project + '/' + config.captureFolder + '/' + kind + '/')) continue;
      const bodyValue = factValue({ content: text });
      if (!bodyValue) continue;
      current[permalink] = { hash: hash(bodyValue + '\n' + (field('status') || 'active')), value: bodyValue, mtime: stat.mtimeMs };
    }
  }
  await store.update((s) => {
    for (const [permalink, note] of Object.entries(current)) {
      const old = s.observed[permalink];
      const changed = old && old.hash !== note.hash;
      const fresh = s.initialized && !old;
      // A committed bridge write already has its outbox entry. Otherwise an
      // observed edit is an external correction and must survive restart.
      const internal = s.pending.some((p) => p.permalink === permalink && !p.external && p.expectedValue === note.value);
      if ((changed || fresh) && !internal) mergePending(s, { permalink, action: 'CORRECT', expectedValue: note.value, external: true });
      s.observed[permalink] = { hash: note.hash, externalEditedAt: changed && !internal ? note.mtime : old?.externalEditedAt || 0 };
    }
    s.initialized = true;
  });
}
