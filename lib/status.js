import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { managementDirectory } from './review.js';

export const statusKey = (id) => createHash('sha256').update(id).digest('hex');
export function createMemoryStatus(config, logger) {
  const dir = config.vaultPath ? path.join(managementDirectory(config), 'memory-status') : '';
  const cache = new Map();
  let chain = Promise.resolve();
  const runId = randomUUID();
  let ready = Promise.resolve();
  if (dir) ready = (async () => {
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, 'runtime.' + runId + '.tmp');
    await fs.writeFile(temp, JSON.stringify({ runId, startedAt: new Date().toISOString(), features: ['durable-capture-retry', 'correction-sync-readback', 'local-edit-observation', 'automatic-topic-indexes', 'natural-decay-reinforcement', 'personal-entry-decay-reinforcement'] }));
    await fs.rename(temp, path.join(dir, 'runtime.json'));
  })();
  ready.catch((error) => logger?.warn?.('[basic-memory-bridge] status initialization failed: ' + error.code));
  async function load(id) {
    await ready;
    if (cache.has(id)) return cache.get(id);
    let value = { version: 1, sessionId: id, jobs: [], pending: [] };
    if (dir) {
      try { value = JSON.parse(await fs.readFile(path.join(dir, statusKey(id) + '.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const job of value.jobs) {
      if (['queued', 'processing'].includes(job.state)) {
        job.state = 'failed'; job.reason = 'interrupted';
      }
      if (job.maintenance === 'processing') job.maintenance = 'failed';
    }
    value.runId = runId;
    cache.set(id, value);
    return value;
  }
  async function persist(value) {
    value.updatedAt = new Date().toISOString();
    if (!dir) return;
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, statusKey(value.sessionId) + '.json');
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  }
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch((error) => logger?.warn?.('[basic-memory-bridge] status persistence failed: ' + error.code));
    return run;
  }
  return {
    get: (id) => serialize(async () => structuredClone(await load(id))),
    set: (id, turn, patch) => serialize(async () => {
      const value = await load(id);
      let job = value.jobs.find((item) => item.turn === turn);
      if (!job) { job = { turn, at: new Date().toISOString() }; value.jobs.push(job); }
      Object.assign(job, patch);
      value.jobs = value.jobs.sort((a, b) => a.turn - b.turn).slice(-20);
      await persist(value);
    }),
    pending: (id, changes) => serialize(async () => {
      const value = await load(id);
      value.pending = changes.map(({ permalink, action, memoryId }) => ({ permalink, action, memoryId }));
      await persist(value);
    }),
  };
}

