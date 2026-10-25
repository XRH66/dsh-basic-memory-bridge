import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendReviewEntry,
  readReviewList,
  reviewAbsolutePath,
  reviewLink,
  reviewListPath,
  saveReviewList,
  vaultCapacity,
  ReviewListError,
} from '../lib/review.js';

const NOW = () => new Date('2026-10-24T04:00:00.000Z');

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-list-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  return { root, vault, config: { project: 'personal', vaultPath: vault } };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('review entries live outside the vault, dedupe, survive concurrent appends, and link through Obsidian', async () => {
  const { root, vault, config } = await setup();
  try {
    const note = path.join(vault, 'chats', 'events', '2026-09-17 - 示例人物 手账 #1.md');
    await fs.mkdir(path.dirname(note), { recursive: true });
    await fs.writeFile(note, 'actual note');
    const ctx = { vaultPath: vault, project: 'personal', config };
    const entry = (scope) => ({
      kind: 'event',
      title: '示例人物 手账 #1',
      reason: scope + '：用户要求提交人工审阅',
      scope,
      filePath: 'chats/events/2026-09-17 - 示例人物 手账 #1.md',
      bytes: 11,
      now: NOW,
    });

    const first = await appendReviewEntry(ctx, entry('整篇'));
    assert.equal(first.updated, true);
    const results = await Promise.all([
      appendReviewEntry(ctx, entry('第 1 条')),
      appendReviewEntry(ctx, entry('第 2 条')),
      appendReviewEntry(ctx, entry('第 3 条')),
      appendReviewEntry(ctx, entry('第 4 条')),
    ]);
    assert.equal(results.every((item) => item.updated), true);

    const list = await readReviewList(config);
    assert.equal(list.exists, true);
    assert.equal(list.path, reviewListPath(config));
    assert.equal(list.path.startsWith(vault + path.sep), false, 'the review list is outside the vault');
    assert.equal(await fs.stat(path.join(vault, 'chats', 'review', '待审清单.md')).catch(() => null), null);
    const lines = list.content.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 5);
    assert.equal(new Set(lines).size, 5);

    await appendReviewEntry(ctx, entry('第 1 条'));
    const again = await readReviewList(config);
    assert.equal(again.content, list.content, 'a duplicate entry does not rewrite the list');
    assert.equal((await fs.readdir(path.dirname(list.path))).filter((name) => name.endsWith('.tmp')).length, 0);

    const linkMatch = again.content.match(/\[打开原文\]\(obsidian:\/\/open\?path=([^)]+)\)/);
    assert.ok(linkMatch);
    const decoded = decodeURIComponent(linkMatch[1]);
    assert.equal(decoded, path.resolve(note).replace(/\\/g, '/'));
    assert.equal(path.isAbsolute(decoded), true);
    assert.match(linkMatch[1], /%23/);
    assert.match(linkMatch[1], /%20/);
    assert.ok(linkMatch[1].includes(encodeURIComponent('示例人物')));
    assert.match(again.content, /本清单保存在 Vault 外的本地管理目录/);
  } finally {
    await cleanup(root);
  }
});

test('the same note can be submitted by scope without duplicate lines, and a changed target is not deduped', async () => {
  const { root, vault, config } = await setup();
  try {
    await fs.mkdir(path.join(vault, 'chats', 'facts'), { recursive: true });
    await fs.writeFile(path.join(vault, 'chats', 'facts', 'a.md'), 'a');
    await fs.writeFile(path.join(vault, 'chats', 'facts', 'b.md'), 'b');
    const ctx = { vaultPath: vault, project: 'personal', config };
    const base = { kind: 'fact', title: 'A', filePath: 'chats/facts/a.md', bytes: 1, now: NOW };
    const add = (scope, reason = scope + '：用户要求提交人工审阅', filePath = base.filePath) => appendReviewEntry(ctx, { ...base, scope, reason, filePath });
    assert.equal((await add('整篇')).updated, true);
    assert.equal((await add('第 1 条')).updated, true);
    assert.equal((await add('第 1 条')).updated, false);
    assert.equal((await add('第 1 条', '第 1 条：另一个理由')).updated, false, 'same scope and target is the same submission even if the reason text changed');
    assert.equal((await add('第 2 条')).updated, true);
    assert.equal((await add('整篇', '整篇：用户要求提交人工审阅', 'chats/facts/b.md')).updated, true);
    const lines = (await readReviewList(config)).content.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 4);
  } finally {
    await cleanup(root);
  }
});

test('write and read failures are errors, never an empty list that is overwritten', async () => {
  const { root, vault, config } = await setup();
  try {
    const listPath = reviewListPath(config);
    await fs.mkdir(listPath, { recursive: true });
    await assert.rejects(
      () => appendReviewEntry({ vaultPath: vault, project: 'personal', config }, {
        kind: 'fact', title: 'A', reason: '整篇：用户要求提交人工审阅', scope: '整篇', filePath: 'a.md', bytes: 1, now: NOW,
      }),
      (error) => error instanceof ReviewListError && error.code === 'REVIEW_READ_FAILED',
    );
    await assert.rejects(
      () => saveReviewList(config, 'replacement'),
      (error) => error instanceof ReviewListError && error.code === 'REVIEW_WRITE_FAILED',
    );
    assert.equal((await fs.stat(listPath)).isDirectory(), true, 'the failed write must not replace the directory');
  } finally {
    await cleanup(root);
  }
});

test('capacity reads the real volume and low/free thresholds only report status', async () => {
  const { root, vault, config } = await setup();
  try {
    const enough = await vaultCapacity(vault, { vaultMinFreeBytes: 1, vaultMinFreeRatio: 0.0001 }, async () => ({ blocks: 1000, bsize: 1024, bavail: 500 }));
    assert.equal(enough.total, 1024000);
    assert.equal(enough.free, 512000);
    assert.equal(enough.low, false);
    const low = await vaultCapacity(vault, { vaultMinFreeBytes: 1024 * 1024, vaultMinFreeRatio: 0.01 }, async () => ({ blocks: 1000, bsize: 1024, bavail: 10 }));
    assert.equal(low.low, true);
    const real = await vaultCapacity(vault, config);
    assert.ok(real.total > 0);
    assert.equal(typeof real.low, 'boolean');
  } finally {
    await cleanup(root);
  }
});

test('only real vault paths become links; traversal and outside paths are refused', async () => {
  const { root, vault, config } = await setup();
  try {
    const inside = path.join(vault, 'note.md');
    await fs.writeFile(inside, 'note');
    const link = await reviewLink(inside, { vaultPath: vault, project: 'personal' });
    assert.match(link, /^\[打开原文\]\(obsidian:\/\/open\?path=/);
    assert.equal(await reviewLink(path.join(root, 'outside.md'), { vaultPath: vault, project: 'personal' }), '');
    assert.equal(await reviewLink('../../outside.md', { vaultPath: vault, project: 'personal' }), '');
    assert.equal(await reviewAbsolutePath(inside, { vaultPath: vault, project: 'personal' }), inside);
    assert.equal(await reviewAbsolutePath('personal/../outside.md', { vaultPath: vault, project: 'personal' }), '');
    assert.equal(await reviewLink('personal/' + path.basename(inside), { vaultPath: vault, project: 'personal' }), await reviewLink(inside, { vaultPath: vault, project: 'personal' }));
  } finally {
    await cleanup(root);
  }
});
