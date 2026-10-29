import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import {
  TARGET_SESSION as TARGET_SESSION_ID,
  assistantMessage,
  directUser,
  fakeAgent,
  fakeLlm,
  fakeTools,
  mcpResult,
  mcpTextOnlyResult,
  runPreStep,
  turnEnd,
  turnStart,
  userMessage,
} from './helpers.js';

const CAPTURE_JSON = JSON.stringify({
  actions: [{
    action: 'ADD',
    kind: 'fact',
    category: 'preference',
    title: 'tea',
    subject: 'user',
    attribute: 'tea',
    value: 'The user prefers oolong tea.',
    evidence: 'I prefer oolong tea.',
  }],
});

function searchPayload() {
  return {
    results: [{
      title: 'Tea preference',
      type: 'note',
      score: 0.87,
      permalink: 'personal/chats/facts/tea',
      matched_chunk: 'The user prefers jasmine tea without sugar.',
      metadata: { memory_id: 'memory-tea', status: 'active' },
    }],
    current_page: 1,
    page_size: 3,
    total: 1,
    total_is_exact: true,
    has_more: false,
  };
}

function emptySearchPayload() {
  return { results: [], current_page: 1, page_size: 3, total: 0, total_is_exact: true, has_more: false };
}

function notePayload() {
  return {
    title: 'Tea preference',
    permalink: 'personal/chats/facts/tea',
    file_path: 'chats/facts/tea.md',
    checksum: 'tea-checksum',
    content: '# Tea preference\n\n- [preference] The user prefers jasmine tea without sugar.',
    frontmatter: { memory_id: 'memory-tea', status: 'active' },
  };
}

function writePayload() {
  return {
    title: 'tea',
    permalink: 'personal/chats/facts/tea-preference',
    file_path: 'chats/facts/tea-preference.md',
    checksum: 'abc123',
    action: 'created',
    similar_notes: [],
  };
}

test('offline end-to-end: recall and capture through DSH 0.2.1 structuredContent shapes', async () => {
  const writes = [];
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult(input.arguments.query.includes('remember') ? searchPayload() : emptySearchPayload());
    }
    if (input.name === 'mcp__basic_memory__read_note') return mcpResult(notePayload());
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__write_note') {
      writes.push(input.arguments);
      return mcpResult(writePayload());
    }
    throw new Error('unexpected tool ' + input.name);
  });
  const llm = fakeLlm(CAPTURE_JSON);
  const warnings = [];
  const session = fakeAgent(TARGET_SESSION_ID).session;
  const bridge = createBridge({
    config: resolveConfig({ personalRecall: false }),
    tools,
    llm,
    logger: { warn: (m) => warnings.push(m) },
    now: () => new Date('2026-10-24T03:00:00.000Z'),
  });

  const decision = await runPreStep(bridge, {
    turn: 3,
    step: 1,
    messages: [directUser('Do you remember what tea I like?')],
    agent: fakeAgent(TARGET_SESSION_ID),
  });
  const injected = decision.messages.find((message) => message.source.kind === 'basic-memory-context');
  assert.ok(injected);
  assert.match(injected.content[0].text, /personal\/chats\/facts\/tea/);
  assert.match(injected.content[0].text, /jasmine tea/);

  bridge.onSessionEvent(session, turnStart(3));
  bridge.onSessionEvent(session, userMessage('I prefer oolong tea.'));
  bridge.onSessionEvent(session, assistantMessage(3, 'Noted.'));
  bridge.onSessionEvent(session, turnEnd(3));
  await bridge.waitForIdle(TARGET_SESSION_ID);

  assert.ok(tools.calls.some((call) => call.name === 'mcp__basic_memory__write_note'));
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /The user prefers oolong tea\./);
  assert.equal(writes[0].metadata.memory_kind, 'fact');
  assert.equal(writes[0].metadata.status, 'active');
  assert.equal(writes[0].metadata.source_session_id, TARGET_SESSION_ID);
});

test('offline: MCP responses without structuredContent still parse from text blocks', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpTextOnlyResult(input.arguments.query.includes('live') ? searchPayload() : emptySearchPayload());
    }
    if (input.name === 'mcp__basic_memory__read_note') return mcpTextOnlyResult(notePayload());
    if (input.name === 'mcp__basic_memory__list_directory') return mcpTextOnlyResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__write_note') return mcpTextOnlyResult(writePayload());
    throw new Error('unexpected tool ' + input.name);
  });
  const bridge = createBridge({
    config: resolveConfig({}),
    tools,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const session = fakeAgent(TARGET_SESSION_ID).session;

  const decision = await runPreStep(bridge, {
    turn: 4,
    messages: [directUser('Where do I live?')],
    agent: fakeAgent(TARGET_SESSION_ID),
  });
  assert.ok(decision.messages.some((message) => message.source.kind === 'basic-memory-context'));

  bridge.onSessionEvent(session, turnStart(4));
  bridge.onSessionEvent(session, userMessage('I prefer oolong tea.'));
  bridge.onSessionEvent(session, assistantMessage(4, 'Noted.'));
  bridge.onSessionEvent(session, turnEnd(4));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(tools.calls.filter((call) => call.name === 'mcp__basic_memory__write_note').length, 1);
});

test('offline: missing MCP runtime fails open for chat and logs capture errors', async () => {
  const warnings = [];
  const bridge = createBridge({
    config: resolveConfig({}),
    tools: null,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn: (message) => warnings.push(message) },
  });
  const session = fakeAgent(TARGET_SESSION_ID).session;

  const decision = await runPreStep(bridge, {
    turn: 5,
    messages: [directUser('Remember my tea.')],
    agent: fakeAgent(TARGET_SESSION_ID),
  });
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 0);

  bridge.onSessionEvent(session, turnStart(5));
  bridge.onSessionEvent(session, userMessage('Remember my tea.'));
  bridge.onSessionEvent(session, assistantMessage(5, 'Noted.'));
  bridge.onSessionEvent(session, turnEnd(5));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /capture skipped/);
});

test('offline: the bridge never calls an alternate memory backend or tool', async () => {
  const allowed = new Set([
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__list_directory',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
  ]);
  const tools = fakeTools((input) => {
    assert.ok(allowed.has(input.name), 'unexpected tool ' + input.name);
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult(input.arguments.query.includes('tea') ? searchPayload() : emptySearchPayload());
    }
    if (input.name === 'mcp__basic_memory__read_note') return mcpResult(notePayload());
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    return mcpResult(writePayload());
  });
  const bridge = createBridge({
    config: resolveConfig({ personalRecall: false }),
    tools,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const session = fakeAgent(TARGET_SESSION_ID).session;
  await runPreStep(bridge, { turn: 6, messages: [directUser('tea')], agent: fakeAgent(TARGET_SESSION_ID) });
  bridge.onSessionEvent(session, turnStart(6));
  bridge.onSessionEvent(session, userMessage('tea'));
  bridge.onSessionEvent(session, assistantMessage(6, 'ok'));
  bridge.onSessionEvent(session, turnEnd(6));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.ok(tools.calls.length >= 3);
  assert.ok(tools.calls.every((call) => allowed.has(call.name)));
});
