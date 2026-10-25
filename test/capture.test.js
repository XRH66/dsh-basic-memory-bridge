import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { captureTurn, MEMORY_CAPTURE_SYSTEM_PROMPT, resolveCaptureTarget } from '../lib/capture.js';
import { resolveConfig } from '../lib/config.js';
import { applyMemoryActions, softenMemory } from '../lib/memory.js';
import { TARGET_SESSION, fakeAgent, fakeLlm, fakeTools, mcpResult } from './helpers.js';
import { memoryStore, makeVault } from './fake-memory.js';

const SESSION = TARGET_SESSION;

function emptyTools(writes) {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') return mcpResult({ results: [] });
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__write_note') {
      writes.push(input.arguments);
      return mcpResult({ action: 'created', permalink: 'personal/chats/facts/x', checksum: 'c1', file_path: '/fixture-vault/chats/facts/x.md' });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

function runCapture(llm, writes) {
  return captureTurn({
    sessionId: SESSION,
    turn: 3,
    userText: '我平时喝白茶，不加糖。',
    assistantText: '记住了。',
    agent: fakeAgent(SESSION),
    config: resolveConfig({ captureTimeoutMs: 2000, captureMaxTokens: 512 }),
    tools: emptyTools(writes),
    llm,
    logger: { warn() {} },
  });
}

test('capture prompt requires user-only evidence and supports explicit effective dates', () => {
  assert.match(MEMORY_CAPTURE_SYSTEM_PROMPT, /exact contiguous quote from FINAL USER MESSAGE/);
  assert.match(MEMORY_CAPTURE_SYSTEM_PROMPT, /Never derive facts from the assistant answer/);
  assert.match(MEMORY_CAPTURE_SYSTEM_PROMPT, /effective_at/);
  assert.match(MEMORY_CAPTURE_SYSTEM_PROMPT, /Zero actions is a normal result/);
});

test('capture drops actions whose evidence is not in the user message', async () => {
  const writes = [];
  const llm = fakeLlm(JSON.stringify({ actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '饮品偏好', attribute: '茶', value: '喝红茶加糖',
    evidence: '我平时喝红茶加糖。', occurred_at: '日期未明',
  }] }));
  const result = await runCapture(llm, writes);
  assert.equal(result.persisted, false);
  assert.equal(result.reason, 'actions-not-grounded');
  assert.equal(writes.length, 0);
});

test('capture distinguishes truncated or invalid output from a legal empty action list', async () => {
  const truncated = await runCapture(fakeLlm('{"actions":[{"action":"UPDATE"', { kind: 'max-tokens' }), []);
  assert.equal(truncated.persisted, false);
  assert.equal(truncated.reason, 'truncated-output');
  assert.equal(truncated.parse, 'invalid');

  const invalid = await runCapture(fakeLlm('not json', { kind: 'stop' }), []);
  assert.equal(invalid.persisted, false);
  assert.equal(invalid.reason, 'invalid-capture-json');
  assert.equal(invalid.parse, 'invalid');

  const empty = await runCapture(fakeLlm(JSON.stringify({ actions: [] }), { kind: 'stop' }), []);
  assert.equal(empty.persisted, false);
  assert.equal(empty.reason, 'no-durable-actions');
  assert.equal(empty.parse, 'empty');
});

test('capture persists a grounded action and zero actions is normal', async () => {
  const writes = [];
  const llm = fakeLlm(JSON.stringify({ actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '饮品偏好', attribute: '茶', value: '喝白茶不加糖',
    evidence: '我平时喝白茶，不加糖。', occurred_at: '日期未明',
  }] }));
  const result = await runCapture(llm, writes);
  assert.equal(result.persisted, true);
  assert.equal(writes.length, 1);

  const emptyWrites = [];
  const empty = await runCapture(fakeLlm(JSON.stringify({ actions: [] })), emptyWrites);
  assert.equal(empty.persisted, false);
  assert.equal(emptyWrites.length, 0);
});

test('capture target prefers explicit config over the agent session', () => {
  const agent = fakeAgent(SESSION);
  assert.deepEqual(resolveCaptureTarget({ captureProvider: 'p', captureModel: 'm' }, agent), { provider: 'p', model: 'm' });
});

test('max-token truncation warns and writes no facts', async () => {
  const store = memoryStore();
  const warnings = [];
  const result = await captureTurn({
    sessionId: SESSION,
    turn: 3,
    userText: '我平时喝白茶，不加糖。',
    assistantText: '记住了。',
    agent: fakeAgent(SESSION),
    config: resolveConfig({ captureTimeoutMs: 2000, captureMaxTokens: 1024 }),
    tools: store.tools,
    llm: fakeLlm('{"actions":[{"action":"UPDATE","target_memory_id":"missing","value":"白茶"', { kind: 'max-tokens' }),
    logger: { warn(message) { warnings.push(String(message)); } },
  });
  assert.equal(result.persisted, false);
  assert.equal(result.reason, 'truncated-output');
  assert.equal(result.finish, 'max-tokens');
  assert.equal(store.notes.size, 0);
  assert.ok(warnings.some((line) => /max token budget/.test(line)));
  assert.ok(warnings.some((line) => /no memory was written/.test(line)));
});

test('capture commits paired UPDATE and CORRECT actions and keeps ids and softened priority', async () => {
  const vault = await makeVault();
  const store = memoryStore({ vault });
  const config = resolveConfig({ captureTimeoutMs: 2000, captureMaxTokens: 1024, vaultPath: vault });
  const now = () => new Date('2026-10-24T04:00:00.000Z');
  const warnings = [];
  const logger = { warn(message) { warnings.push(String(message)); } };
  const ctx = {
    tools: store.tools,
    agent: fakeAgent(SESSION),
    sessionId: SESSION,
    project: 'personal',
    config,
    now,
    logger,
  };
  try {
    const seeded = await applyMemoryActions(ctx, [
      {
        action: 'ADD', kind: 'fact', category: 'preference', subject: '示例人物', attribute: '常喝饮品',
        value: '常温玄米茶，不加糖', occurredAt: '日期未明', evidence: '常温玄米茶，不加糖',
      },
      {
        action: 'ADD', kind: 'fact', category: 'fact', subject: '示例人物', attribute: '陶艺课安排',
        value: '固定在每周三晚上', occurredAt: '日期未明', evidence: '固定在每周三晚上',
      },
    ], { sessionId: SESSION, turn: 1, messageId: 'm1', eventSeq: 1, now });
    assert.equal(seeded.committed, true);

    const active = () => [...store.notes.values()].filter((note) => note.frontmatter?.memory_kind === 'fact' && note.frontmatter?.status === 'active');
    const tea = active().find((note) => note.frontmatter?.attribute === '常喝饮品');
    const pottery = active().find((note) => note.frontmatter?.attribute === '陶艺课安排');
    assert.ok(tea);
    assert.ok(pottery);
    const teaId = tea.frontmatter.memory_id;
    const potteryId = pottery.frontmatter.memory_id;

    const softened = await softenMemory(ctx, { memoryId: potteryId, reason: 'test fixture' });
    assert.equal(softened.ok, true);
    assert.equal(softened.basePriority, 0.5);
    const softenedAt = softened.softenedAt;
    assert.ok(softenedAt);

    const userText = '示例人物：我最近口味变了，从2026-10-24起长期改喝温玄米茶，仍然不加糖。另外，陶艺课一直都是周四晚上，之前说周三是我说错了，不是最近才改时间。';
    const payload = {
      actions: [
        {
          action: 'UPDATE', kind: 'fact', category: 'preference', subject: '示例人物', attribute: '常喝饮品',
          value: '温玄米茶，不加糖', target_memory_id: teaId,
          evidence: '从2026-10-24起长期改喝温玄米茶，仍然不加糖', effective_at: '2026-10-24',
        },
        {
          action: 'CORRECT', kind: 'fact', category: 'fact', subject: '示例人物', attribute: '陶艺课安排',
          value: '固定每周四晚上', target_memory_id: potteryId,
          evidence: '陶艺课一直都是周四晚上',
        },
      ],
    };
    const result = await captureTurn({
      sessionId: SESSION,
      turn: 3,
      userText,
      assistantText: '好的，记住了。',
      agent: fakeAgent(SESSION),
      config,
      tools: store.tools,
      llm: fakeLlm(JSON.stringify(payload)),
      logger,
      now,
    });
    assert.equal(result.persisted, true);
    assert.equal(result.actions, 2);
    assert.equal(warnings.length, 0);

    const teaAfter = active().find((note) => note.frontmatter?.memory_id === teaId);
    const potteryAfter = active().find((note) => note.frontmatter?.memory_id === potteryId);
    assert.ok(teaAfter);
    assert.ok(potteryAfter);
    assert.equal(teaAfter.frontmatter.value, '温玄米茶，不加糖');
    assert.match(teaAfter.content, /温玄米茶/);
    assert.equal(potteryAfter.frontmatter.value, '固定每周四晚上');
    assert.match(potteryAfter.content, /每周四晚上/);
    assert.equal(potteryAfter.frontmatter.base_priority, 0.5);
    assert.equal(potteryAfter.frontmatter.softened_at, softenedAt);

    const history = [...store.notes.values()].filter((note) => note.frontmatter?.memory_kind === 'history');
    assert.equal(history.length, 2);
    assert.ok(history.some((note) => note.frontmatter.status === 'revoked'));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
test('capture keeps a grounded relative time and its real source anchor', async () => {
  const writes = [];
  const userText = '上周我在河边市集买了一个黄铜书签。';
  const llm = fakeLlm(JSON.stringify({ actions: [{
    action: 'ADD', kind: 'event', category: 'event', subject: '市集', attribute: '购买',
    value: '在河边市集买黄铜书签', event_summary: '河边市集买黄铜书签',
    occurred_at: '日期未明', time_expression: '上周', evidence: '上周我在河边市集买了一个黄铜书签',
  }] }));
  const result = await captureTurn({
    sessionId: SESSION,
    turn: 3,
    userText,
    assistantText: '记住了。',
    sourceEventTime: Date.parse('2026-10-24T04:00:00.000Z'),
    priorUserMessages: ['这是一句旧话，只用于指代，不应成为新事实。'],
    agent: fakeAgent(SESSION),
    config: resolveConfig({ captureTimeoutMs: 2000, captureMaxTokens: 1024 }),
    tools: emptyTools(writes),
    llm,
    logger: { warn() {} },
  });
  assert.equal(result.persisted, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /- time_expression: 上周/);
  assert.match(writes[0].content, /- time_anchor: 2026-10-24 12:00 Asia\/Shanghai/);
  assert.match(writes[0].content, /- source_event_time: 2026-10-24T04:00:00.000Z/);
  assert.equal(writes[0].metadata.time_expression, '上周');
  assert.equal(writes[0].metadata.time_anchor, '2026-10-24 12:00 Asia/Shanghai');
  assert.equal(writes[0].metadata.source_event_time, '2026-10-24T04:00:00.000Z');
  assert.equal(writes[0].metadata.occurred_at, '日期未明');
});

test('capture drops a relative-time phrase that is not in the final user message', async () => {
  const writes = [];
  const userText = '我今天喝了白茶，不加糖。';
  const llm = fakeLlm(JSON.stringify({ actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '饮品偏好', attribute: '茶',
    value: '喝白茶不加糖', occurred_at: '日期未明', time_expression: '上周', evidence: '我今天喝了白茶，不加糖',
  }] }));
  const result = await captureTurn({
    sessionId: SESSION,
    turn: 3,
    userText,
    assistantText: '记住了。',
    sourceEventTime: Date.parse('2026-10-24T04:00:00.000Z'),
    agent: fakeAgent(SESSION),
    config: resolveConfig({ captureTimeoutMs: 2000, captureMaxTokens: 1024 }),
    tools: emptyTools(writes),
    llm,
    logger: { warn() {} },
  });
  assert.equal(result.persisted, true);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].content, /time_expression/);
  assert.equal(writes[0].metadata.time_expression, undefined);
});

