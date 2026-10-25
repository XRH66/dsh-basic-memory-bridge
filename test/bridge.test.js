import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, createBridge, inject, name } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import {
  OTHER_SESSION,
  TARGET_SESSION as TARGET_SESSION_ID,
  assistantMessage,
  directUser,
  fakeAgent,
  fakeLlm,
  fakeTools,
  mcpError,
  mcpResult,
  runPreStep,
  syntheticMessage,
  turnEnd,
  turnStart,
  userMessage,
} from './helpers.js';
import { memoryStore } from './fake-memory.js';

const applyRoot=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-apply-test-'));
test.after(async()=>{
  assert.ok(path.resolve(applyRoot).startsWith(path.resolve(os.tmpdir())+path.sep+'dafeiyu-apply-test-'));
  await fs.rm(applyRoot,{recursive:true,force:true});
});

function recallTools() {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult({
        results: [{
          title: 'Tea preference',
          permalink: 'personal/chats/facts/tea',
          score: 0.9,
          matched_chunk: 'The user prefers jasmine tea.',
          metadata: { memory_id: 'memory-tea', status: 'active' },
        }],
      });
    }
    if (input.name === 'mcp__basic_memory__read_note') {
      return mcpResult({
        title: 'Tea preference',
        permalink: 'personal/chats/facts/tea',
        checksum: 'c1',
        content: '# Tea preference\n\n- [preference] The user prefers jasmine tea.',
        frontmatter: { memory_id: 'memory-tea', status: 'active', memory_kind: 'fact' },
      });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

function searchCount(tools) {
  return tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes').length;
}

function captureTools(writes) {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') return mcpResult({ results: [] });
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__read_note') {
      return mcpResult({ title: 'Tea preference', permalink: 'personal/chats/facts/tea', checksum: 'c1', content: '# Tea preference\n\n- [preference] The user prefers jasmine tea.', frontmatter: { memory_id: 'memory-tea', status: 'active', memory_kind: 'fact' } });
    }
    if (input.name === 'mcp__basic_memory__write_note') {
      writes.push(input.arguments);
      return mcpResult({ action: 'created', permalink: 'personal/' + String(input.arguments.directory) + '/note', checksum: 'c1', file_path: '/fixture-vault/' + String(input.arguments.directory) + '/note.md' });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

const CAPTURE_JSON = JSON.stringify({
  actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '用户', attribute: '茶',
    value: '喜欢茉莉花茶', occurred_at: '日期未明', evidence: 'I prefer jasmine tea.',
  }],
});

function makeBridge(overrides = {}) {
  const writes = [];
  const tools = overrides.tools ?? captureTools(writes);
  const llm = overrides.llm ?? fakeLlm(CAPTURE_JSON);
  const warnings = [];
  const bridge = createBridge({
    config: resolveConfig(overrides.config ?? {}),
    tools,
    llm,
    logger: { warn: (message) => warnings.push(message) },
    now: () => new Date('2026-10-24T03:00:00.000Z'),
  });
  return { bridge, writes, tools, llm, warnings };
}

async function emitTurn(bridge, { turn, userText = 'I prefer jasmine tea.', answer = 'Noted.', reason = 'completed', interrupted = false, messageId, eventSeq }) {
  const agent = fakeAgent(TARGET_SESSION_ID);
  bridge.onSessionEvent(agent.session, turnStart(turn));
  const user = userMessage(userText);
  if (messageId) user.data.id = messageId;
  if (eventSeq !== undefined) user.seq = eventSeq;
  bridge.onSessionEvent(agent.session, user);
  // Associate the real per-turn agent without asking for a recall on empty input.
  await runPreStep(bridge, { turn, agent, messages: [] });
  bridge.onSessionEvent(agent.session, assistantMessage(turn, answer, interrupted));
  bridge.onSessionEvent(agent.session, turnEnd(turn, reason));
  await bridge.waitForIdle(TARGET_SESSION_ID);
}

test('plugin metadata targets the Cordis runtime', () => {
  assert.equal(name, 'basic-memory-bridge');
  assert.deepEqual(inject, ['tools', 'llm', 'agents']);
});

test('apply registers both hooks and persists runtime status outside its Vault', async () => {
  const registered = [];
  const ctx = {
    tools: { execute() {}, register: (definition) => { registered.push({ event: 'register', definition }); return () => {}; } },
    llm: { stream() {} },
    logger: { warn() {} },
    on(event, handler, options) {
      registered.push({ event, handler, options });
    },
  };
  const bridge = apply(ctx, {vaultPath:path.join(applyRoot,'vault')});
  await bridge.getMemoryStatus(TARGET_SESSION_ID);
  assert.ok(JSON.parse(await fs.readFile(path.join(applyRoot,'management','memory-status','runtime.json'),'utf8')).runId);
  assert.equal(typeof bridge.onPreStep, 'function');
  assert.deepEqual(registered.map((item) => item.event), ['register', 'dispose', 'register', 'dispose', 'agent/pre-step', 'session/event', 'tools/change', 'dispose']);
  const preStep = registered.find((item) => item.event === 'agent/pre-step');
  assert.deepEqual(preStep.options, { prepend: true });
  const toolDefinitions = registered.filter((item) => item.event === 'register').map((item) => item.definition);
  assert.deepEqual(toolDefinitions.map((item) => item.name), ['dafeiyu_records', 'soften_memory']);
  assert.deepEqual(toolDefinitions[0].parameters.required.sort(), ['action', 'kind']);
  assert.equal(toolDefinitions[1].parameters.required, undefined);
});

test('permanent delete is hidden per agent while other Basic Memory tools stay available', async () => {
  const definitions = new Map();
  const hidden = new Set();
  const guards = [];
  const makeDefinition = (toolName) => ({ name: toolName, execute() {} });
  for (const toolName of [
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
    'mcp__basic_memory__move_note',
  ]) definitions.set(toolName, makeDefinition(toolName));

  const tools = {
    get(toolName) {
      return hidden.has(toolName) ? undefined : definitions.get(toolName);
    },
  };
  const agent = {
    session: { id: TARGET_SESSION_ID },
    ctx: {
      tools: {
        guard(guard) { guards.push(guard); return () => {}; },
        restrict({ deny }) {
          for (const toolName of deny) hidden.add(toolName);
          return () => {};
        },
      },
    },
  };
  const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });
  assert.equal(tools.get('mcp__basic_memory__delete_note', agent), undefined);
  assert.equal(tools.get('mcp__basic_memory__delete_project', agent), undefined);

  // Async MCP registration: the turn starts before the delete tools exist. The
  // guard is installed immediately, then tools/change/refresh hides later tools.
  await runPreStep(bridge, { turn: 1, agent, messages: [] });
  assert.equal(guards.length, 1);
  assert.equal(guards[0]({ name: 'mcp__basic_memory__read_note' }), undefined);
  assert.match(guards[0]({ name: 'mcp__basic_memory__delete_note' }), /Permanent deletion is disabled/);
  assert.match(guards[0]({ name: 'mcp__basic_memory__delete_project' }), /Permanent deletion is disabled/);

  definitions.set('mcp__basic_memory__delete_note', makeDefinition('mcp__basic_memory__delete_note'));
  definitions.set('mcp__basic_memory__delete_project', makeDefinition('mcp__basic_memory__delete_project'));
  assert.ok(tools.get('mcp__basic_memory__delete_note', agent));
  assert.ok(tools.get('mcp__basic_memory__delete_project', agent));
  bridge.refreshPermanentDeleteProtection();
  assert.equal(tools.get('mcp__basic_memory__delete_note', agent), undefined);
  assert.equal(tools.get('mcp__basic_memory__delete_project', agent), undefined);
  for (const toolName of [
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
    'mcp__basic_memory__move_note',
  ]) assert.ok(tools.get(toolName, agent), toolName);
});

const THIRD_SESSION = 'session-11111111-1111-1111-1111-111111111111';

test('non-target sessions without basic memory never recall or capture', async () => {
  const tools = { get: () => undefined, calls: [] };
  const { bridge } = makeBridge({ tools, config: { autoCapture: false } });
  await runPreStep(bridge, { sessionId: OTHER_SESSION, messages: [directUser('tea')] });
  assert.equal(tools.calls.length, 0);

  bridge.onSessionEvent({ id: OTHER_SESSION }, turnStart(1));
  bridge.onSessionEvent({ id: OTHER_SESSION }, userMessage('I prefer jasmine tea.'));
  bridge.onSessionEvent({ id: OTHER_SESSION }, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent({ id: OTHER_SESSION }, turnEnd(1));
  await bridge.waitForIdle(OTHER_SESSION);
  assert.equal(tools.calls.length, 0);
});

test('personal recall serves any session with basic memory, without turning on fact recall or capture', async () => {
  for (const sessionId of [OTHER_SESSION, THIRD_SESSION]) {
    const tools = fakeTools((input) => {
      if (input.name === 'mcp__basic_memory__search_notes') {
        return mcpResult({
          results: [{ title: 'Thought', permalink: 'dafeiyu/thoughts/x', score: 1, matched_chunk: '老大更喜欢先看结论。' }],
        });
      }
      if (input.name === 'mcp__basic_memory__read_note') return mcpResult({ content: '老大更喜欢先看结论。', frontmatter: { status: 'active' } });
      throw new Error('unexpected tool ' + input.name);
    });
    const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });

    const decision = await runPreStep(bridge, {
      sessionId,
      messages: [directUser('老大喜欢先看结论还是过程？')],
    });
    const personal = (decision.messages ?? []).find((message) => message.source.kind === 'dafeiyu-personal-recall');
    assert.ok(personal, sessionId);
    assert.match(personal.content[0].text, /dafeiyu\/thoughts/);
    assert.equal(tools.calls.length, 2, sessionId);
    assert.equal(tools.calls[1].name, 'mcp__basic_memory__read_note');
    assert.deepEqual(tools.calls[0].arguments.tags, ['subjective'], sessionId);

    bridge.onSessionEvent({ id: sessionId }, turnStart(1));
    bridge.onSessionEvent({ id: sessionId }, userMessage('老大喜欢先看结论还是过程？'));
    bridge.onSessionEvent({ id: sessionId }, assistantMessage(1, 'Noted.'));
    bridge.onSessionEvent({ id: sessionId }, turnEnd(1));
    await bridge.waitForIdle(sessionId);
    assert.equal(tools.calls.length, 2, sessionId + ' must not capture');
  }
});

test('a successful soften turn is not captured, while the next ordinary turn still is', async () => {
  const store = memoryStore();
  store.notes.set('personal/chats/facts/tea', {
    title: '茶饮偏好 - 茶',
    permalink: 'personal/chats/facts/tea',
    directory: 'chats/facts',
    content: '<!-- dsh-fact-memory -->\n# 茶饮偏好 - 茶\n\n- [preference] 喜欢乌龙茶\n- subject: 用户\n- attribute: 茶\n- 发生日期: 日期未明\n',
    frontmatter: {
      memory_id: 'memory-tea',
      memory_kind: 'fact',
      status: 'active',
      subject: '用户',
      attribute: '茶',
      value: '喜欢乌龙茶',
      category: 'preference',
      occurred_at: '日期未明',
      recorded_at: '2026-10-01T00:00:00.000Z',
      source_session_id: TARGET_SESSION_ID,
    },
    tags: ['dsh-memory', 'dsh-fact'],
    checksum: 'tea-checksum',
    updated: '2026-10-24T03:00:00.000Z',
    filePath: '',
  });

  const definitions = new Map();
  const ctx = {
    tools: {
      get: store.tools.get,
      execute: store.tools.execute,
      register(definition) {
        definitions.set(definition.name, definition);
        return () => {};
      },
    },
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
    on() {},
  };
  const bridge = apply(ctx, { autoRecall: false, personalRecall: false, vaultPath:path.join(applyRoot,'vault') });
  const agent = fakeAgent(TARGET_SESSION_ID);

  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, userMessage('以后少提茶。'));
  await runPreStep(bridge, { turn: 1, agent, messages: [] });
  const softened = await definitions.get('soften_memory').execute(
    { identifier: 'personal/chats/facts/tea', reason: '少提' },
    { agent },
  );
  assert.equal(softened.ok, true);
  assert.equal(store.notes.get('personal/chats/facts/tea').frontmatter.base_priority, 0.5);
  bridge.onSessionEvent(agent.session, assistantMessage(1, '好。'));
  bridge.onSessionEvent(agent.session, turnEnd(1));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(ctx.llm.calls.length, 0);
  assert.equal(store.notes.size, 1);

  bridge.onSessionEvent(agent.session, turnStart(2));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  await runPreStep(bridge, { turn: 2, agent, messages: [] });
  bridge.onSessionEvent(agent.session, assistantMessage(2, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(2));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(ctx.llm.calls.length, 1);
  assert.ok([...store.notes.values()].some((note) => note.permalink.includes('/history/')));
});

test('personal recall is skipped when the found notes are unrelated to the turn', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult({
        results: [{ title: 'Thought', permalink: 'dafeiyu/thoughts/x', score: 1, matched_chunk: '今天想吃白米饭。' }],
      });
    }
    throw new Error('unexpected tool ' + input.name);
  });
  const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });
  const decision = await runPreStep(bridge, {
    sessionId: OTHER_SESSION,
    messages: [directUser('这段 Node 代码为什么报错？')],
  });
  const messages = decision.messages ?? [];
  assert.equal(messages.some((message) => message.source.kind === 'dafeiyu-personal-recall'), false);
  assert.equal(messages.some((message) => message.source.kind === 'basic-memory-recall'), false);
  assert.ok(messages.some((message) => message.source.kind === 'dafeiyu-memory-control'));
});

test('fact and index searches each run once per direct-user turn, never later steps', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const byChannel = (index) => tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes' && Boolean(call.arguments.tags?.includes('index')) === index).length;

  const first = await runPreStep(bridge, { turn: 5, step: 1, messages: [directUser('What tea do I like?')] });
  assert.equal(byChannel(false), 1);
  assert.equal(byChannel(true), 1);
  assert.ok((first.messages ?? []).some((message) => message.source.kind === 'basic-memory-recall'));
  assert.ok((first.messages ?? []).some((message) => message.source.kind === 'dafeiyu-memory-control'));

  await runPreStep(bridge, { turn: 5, step: 1, messages: [directUser('What tea do I like?')] });
  await runPreStep(bridge, { turn: 5, step: 2, messages: [] });
  await runPreStep(bridge, { turn: 5, step: 3, messages: [syntheticMessage('runtime context')] });
  assert.equal(byChannel(false), 1);
  assert.equal(byChannel(true), 1);

  await runPreStep(bridge, { turn: 6, step: 1, messages: [directUser('Anything else?')] });
  assert.equal(byChannel(false), 2);
  assert.equal(byChannel(true), 2);
});

test('recall is skipped for synthetic-only steps, disabled config, and rejected decisions', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const agent = fakeAgent(TARGET_SESSION_ID);

  await runPreStep(bridge, { messages: [syntheticMessage('only context')], agent });
  assert.equal(tools.calls.length, 0);

  const disabled = makeBridge({ tools, config: { autoRecall: false, autoCapture: false, personalRecall: false } }).bridge;
  await runPreStep(disabled, { messages: [directUser('tea')] });
  assert.equal(tools.calls.length, 0);

  const decision = await bridge.onPreStep(
    { agent, messages: [directUser('tea')], turn: 9, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'reject', reason: 'blocked' }),
  );
  assert.equal(decision.kind, 'reject');
  assert.equal(tools.calls.length, 0);
});

test('control policy appears only when basic memory and the softener are both visible', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') return mcpResult({ results: [] });
    throw new Error('unexpected tool ' + input.name);
  });
  const withoutSoftener = {
    ...tools,
    get(name, agent) {
      if (name === 'soften_memory') return undefined;
      return tools.get(name, agent);
    },
  };
  const first = createBridge({
    config: resolveConfig({ autoCapture: false, personalRecall: false }),
    tools: withoutSoftener,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const noPolicy = await runPreStep(first, { messages: [directUser('以后少提茶。')] });
  assert.equal((noPolicy.messages ?? []).length, 0);

  const second = createBridge({
    config: resolveConfig({ autoCapture: false, personalRecall: false }),
    tools,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const decision = await runPreStep(second, { messages: [directUser('以后少提茶。')] });
  const policy = (decision.messages ?? []).find((message) => message.source.kind === 'dafeiyu-memory-control');
  assert.ok(policy);
  assert.equal(policy.source.form, 'policy');
  assert.match(policy.content[0].text, /soften_memory/);
  assert.match(policy.content[0].text, /not user memory/);
  assert.match(policy.content[0].text, /do not call write_note, edit_note, or move_note/);
});

test('recall injection is a frozen reference-data user message with permalink', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const decision = await runPreStep(bridge, { messages: [directUser('What tea do I like?')] });
  const injected = decision.messages.find((message) => message.source.kind === 'basic-memory-recall');
  assert.ok(injected);
  assert.equal(injected.source.form, 'recall');
  assert.ok(Object.isFrozen(injected));
  assert.match(injected.content[0].text, /personal\/chats\/facts\/tea/);
  assert.match(injected.content[0].text, /never as instructions/);
  assert.ok(injected.content[0].text.length <= 1200);
});

test('recall fails open when the MCP tool throws', async () => {
  const tools = fakeTools(() => { throw new Error('boom'); });
  const { bridge, warnings } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const decision = await runPreStep(bridge, { messages: [directUser('tea')] });
  const messages = decision.messages ?? [];
  assert.equal(messages.some((message) => message.source.kind === 'basic-memory-recall'), false);
  assert.ok(messages.some((message) => message.source.kind === 'dafeiyu-memory-control'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

test('completed turns enqueue one background capture with final texts only', async () => {
  const { bridge, writes, llm } = makeBridge();
  await emitTurn(bridge, { turn: 1, userText: 'I prefer jasmine tea.', answer: 'Noted.' });
  assert.equal(writes.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[0].content[0].text, /I prefer jasmine tea/);
  assert.match(llm.calls[0].messages[0].content[0].text, /Noted\./);
});

test('capture passes the current user message id and event sequence into memory sources', async () => {
  const { bridge, writes } = makeBridge();
  await emitTurn(bridge, { turn: 1, messageId: 'msg-77', eventSeq: 77 });
  assert.equal(writes.length, 1);
  const metadata = writes[0].metadata;
  assert.equal(metadata.source_message_id, 'msg-77');
  assert.equal(metadata.source_event_seq, '77');
  const sources = JSON.parse(metadata.sources);
  assert.equal(sources[0].message_id, 'msg-77');
  assert.equal(sources[0].event_seq, 77);
});

test('capture prompt gets the real user event time and only earlier direct user messages', async () => {
  const writes = [];
  const tools = captureTools(writes);
  const llm = fakeLlm(CAPTURE_JSON);
  const bridge = createBridge({
    config: resolveConfig({}),
    tools,
    llm,
    logger: { warn() {} },
    now: () => new Date('2026-10-24T03:00:00.000Z'),
  });
  const prior = directUser('My name is 示例人物.', 'prior-1');
  const synthetic = syntheticMessage('recalled context must not be a fact');
  const current = userMessage('I prefer jasmine tea.', {
    id: 'current-1',
    time: Date.parse('2026-10-25T05:15:00.000Z'),
  });
  const agent = fakeAgent(TARGET_SESSION_ID, undefined, {
    session: { deriveMessages: () => [prior, synthetic, current.data] },
  });
  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, current);
  await runPreStep(bridge, { turn: 1, agent, messages: [] });
  bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(1));
  await bridge.waitForIdle(TARGET_SESSION_ID);

  assert.equal(writes.length, 1);
  const prompt = llm.calls[0].messages[0].content[0].text;
  assert.match(prompt, /CURRENT USER MESSAGE TIME \(Asia\/Shanghai\):\n2026-10-25 13:15 Asia\/Shanghai/);
  const earlier = prompt.split('EARLIER DIRECT USER MESSAGES')[1].split('EARLIER>>>')[0];
  assert.match(earlier, /My name is 示例人物\./);
  assert.doesNotMatch(earlier, /recalled context must not be a fact/);
  assert.doesNotMatch(earlier, /I prefer jasmine tea\./);
});

test('duplicate turn/end events persist at most once', async () => {
  const { bridge, writes, llm } = makeBridge();
  const agent = fakeAgent(TARGET_SESSION_ID);
  await runPreStep(bridge, { turn: 2, agent, messages: [] });
  bridge.onSessionEvent(agent.session, turnStart(2));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  bridge.onSessionEvent(agent.session, assistantMessage(2, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(2));
  bridge.onSessionEvent(agent.session, turnEnd(2));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(writes.length, 1);
  assert.equal(llm.calls.length, 1);
});

test('aborted, errored, interrupted, and empty turns are never captured', async () => {
  const { bridge, writes, llm } = makeBridge();
  await emitTurn(bridge, { turn: 1, reason: 'aborted' });
  await emitTurn(bridge, { turn: 2, reason: 'error' });
  await emitTurn(bridge, { turn: 3, reason: 'completed', interrupted: true });
  await emitTurn(bridge, { turn: 4, userText: '', answer: 'Noted.' });
  await emitTurn(bridge, { turn: 5, userText: 'I prefer jasmine tea.', answer: '' });
  assert.equal(writes.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('autoCapture false leaves completed turns untouched', async () => {
  const { bridge, writes, llm } = makeBridge({ config: { autoCapture: false } });
  await emitTurn(bridge, { turn: 1 });
  assert.equal(writes.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('events without a matching turn/start are ignored', async () => {
  const { bridge, writes } = makeBridge();
  bridge.onSessionEvent({ id: TARGET_SESSION_ID }, userMessage('I prefer jasmine tea.'));
  bridge.onSessionEvent({ id: TARGET_SESSION_ID }, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent({ id: TARGET_SESSION_ID }, turnEnd(1));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(writes.length, 0);
});

test('capture failures stay in logs and never reject the queue', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__write_note') return mcpError('write failed');
    return mcpResult({ results: [], nodes: [] });
  });
  const { bridge, warnings } = makeBridge({ tools });
  await emitTurn(bridge, { turn: 1 });
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /write failed/);
});

test('capture uses the same per-turn agent observed by pre-step', async () => {
  const agent = fakeAgent(TARGET_SESSION_ID);
  const { bridge, tools } = makeBridge({ config: { autoRecall: false, personalRecall: false } });
  await runPreStep(bridge, { turn: 1, agent, messages: [directUser('I prefer jasmine tea.')] });
  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(1));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.ok(tools.calls.length >= 2);
  assert.ok(tools.calls.every((call) => call.agent === agent));
  assert.ok(tools.getCalls.every((call) => call.agent === agent));
});

function memoryTools(writes) {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({nodes:[]});
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult({
        results: [{
          title: 'Tea preference',
          permalink: 'personal/chats/facts/tea',
          score: 0.9,
          matched_chunk: 'The user prefers jasmine tea.',
          metadata: { memory_id: 'memory-tea', status: 'active' },
        }],
      });
    }
    if (input.name === 'mcp__basic_memory__read_note') {
      return mcpResult({ title: 'Tea preference', permalink: 'personal/chats/facts/tea', checksum: 'tea-checksum', content: '# Tea preference\n\n- [preference] The user prefers jasmine tea.', frontmatter: { memory_id: 'memory-tea', status: 'active' }, file_path: 'chats/facts/Tea preference.md' });
    }
    if (input.name === 'mcp__basic_memory__write_note') {
      writes.push(input.arguments);
      return mcpResult({ action: 'created', permalink: 'personal/chats/facts/note', checksum: 'c1' });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

async function runMemoryTurn(bridge, { sessionId, agent, turn }) {
  bridge.onSessionEvent(agent.session, turnStart(turn));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  const decision = await runPreStep(bridge, {
    sessionId,
    agent,
    turn,
    messages: [directUser('What tea do I like?')],
  });
  bridge.onSessionEvent(agent.session, assistantMessage(turn, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(turn));
  await bridge.waitForIdle(sessionId);
  return decision;
}

test('any session with basic memory gets fact recall and capture without a session allowlist', async () => {
  const writes = [];
  const tools = memoryTools(writes);
  const { bridge, llm } = makeBridge({ tools, config: { personalRecall: false } });
  const agent = fakeAgent(OTHER_SESSION);

  const decision = await runMemoryTurn(bridge, { sessionId: OTHER_SESSION, agent, turn: 1 });
  const fact = (decision.messages ?? []).find((message) => message.source.kind === 'basic-memory-recall');
  assert.ok(fact);
  assert.match(fact.content[0].text, /personal\/chats\/facts\/tea/);
  assert.equal(writes.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.ok(tools.getCalls.length >= 3);
  assert.ok(tools.getCalls.every((call) => call.agent?.session?.id === OTHER_SESSION));
});

test('sessions without basic memory stay untouched even when autoCapture is on', async () => {
  const tools = { get: () => undefined, calls: [] };
  const { bridge, writes, llm } = makeBridge({ tools, config: { autoCapture: true } });
  const agent = fakeAgent(OTHER_SESSION);
  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  const decision = await runPreStep(bridge, {
    sessionId: OTHER_SESSION,
    agent,
    messages: [directUser('What tea do I like?')],
  });
  bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(1));
  await bridge.waitForIdle(OTHER_SESSION);
  assert.equal((decision.messages ?? []).length, 0);
  assert.equal(tools.calls.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('turning basic memory off and on takes effect on the next turn', async () => {
  let visible = true;
  const writes = [];
  const base = memoryTools(writes);
  const tools = {
    calls: base.calls,
    getCalls: base.getCalls,
    execute: base.execute,
    get(name, agent) {
      return visible ? base.get(name, agent) : undefined;
    },
  };
  const { bridge, llm } = makeBridge({ tools, config: { personalRecall: false } });
  const agent = fakeAgent(OTHER_SESSION);

  const on = await runMemoryTurn(bridge, { sessionId: OTHER_SESSION, agent, turn: 1 });
  assert.ok((on.messages ?? []).some((message) => message.source.kind === 'basic-memory-recall'));
  assert.equal(writes.length, 1);

  visible = false;
  const off = await runMemoryTurn(bridge, { sessionId: OTHER_SESSION, agent, turn: 2 });
  assert.equal((off.messages ?? []).length, 0);
  assert.equal(writes.length, 1);

  visible = true;
  const back = await runMemoryTurn(bridge, { sessionId: OTHER_SESSION, agent, turn: 3 });
  assert.ok((back.messages ?? []).some((message) => message.source.kind === 'basic-memory-recall'));
  assert.equal(writes.length, 2);
  assert.equal(llm.calls.length, 2);
});

test('a queued capture pauses after tools disappear and resumes when enabled', async () => {
  let visible = true;
  const writes = [];
  const base = memoryTools(writes);
  const tools = {
    calls: base.calls,
    getCalls: base.getCalls,
    execute: base.execute,
    get(name, agent) {
      return visible ? base.get(name, agent) : undefined;
    },
  };
  const { bridge, llm, warnings } = makeBridge({ tools, config: { personalRecall: false } });
  const agent = fakeAgent(OTHER_SESSION);

  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  await runPreStep(bridge, {
    sessionId: OTHER_SESSION,
    agent,
    messages: [directUser('What tea do I like?')],
  });
  bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent(agent.session, turnEnd(1));
  visible = false;
  await bridge.waitForIdle(OTHER_SESSION);
  assert.equal(writes.length, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal((await bridge.getRecoveryState()).jobs.length, 1);
  visible = true;
  await bridge.retryPending({force:true});
  assert.equal(writes.length, 1);
  assert.equal((await bridge.getRecoveryState()).jobs.length, 0);
  bridge.dispose();
});

test('a turn that ends while basic memory is off stays uncaptured even if it returns before the queue runs', async () => {
  let visible = true;
  const writes = [];
  const base = memoryTools(writes);
  const tools = {
    calls: base.calls,
    getCalls: base.getCalls,
    execute: base.execute,
    get(name, agent) {
      return visible ? base.get(name, agent) : undefined;
    },
  };
  const { bridge, llm } = makeBridge({ tools, config: { personalRecall: false } });
  const agent = fakeAgent(OTHER_SESSION);

  bridge.onSessionEvent(agent.session, turnStart(1));
  bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  await runPreStep(bridge, {
    sessionId: OTHER_SESSION,
    agent,
    messages: [directUser('What tea do I like?')],
  });
  bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));

  visible = false;
  bridge.onSessionEvent(agent.session, turnEnd(1));
  visible = true;
  await bridge.waitForIdle(OTHER_SESSION);

  assert.equal(writes.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('missing pre-step agent and thrown tool lookups skip capture safely', async () => {
  const missing = makeBridge();
  const session = { id: TARGET_SESSION_ID };
  missing.bridge.onSessionEvent(session, turnStart(1));
  missing.bridge.onSessionEvent(session, userMessage('I prefer jasmine tea.'));
  missing.bridge.onSessionEvent(session, assistantMessage(1, 'Noted.'));
  missing.bridge.onSessionEvent(session, turnEnd(1));
  await missing.bridge.waitForIdle(TARGET_SESSION_ID);
  assert.equal(missing.writes.length, 0);
  assert.equal(missing.llm.calls.length, 0);
  assert.ok(missing.warnings.some((message) => /no agent/.test(message)));

  const thrown = {
    get() { throw new Error('lookup failed'); },
  };
  const broken = makeBridge({ tools: thrown });
  const agent = fakeAgent(OTHER_SESSION);
  broken.bridge.onSessionEvent(agent.session, turnStart(1));
  broken.bridge.onSessionEvent(agent.session, userMessage('I prefer jasmine tea.'));
  const decision = await runPreStep(broken.bridge, {
    sessionId: OTHER_SESSION,
    agent,
    messages: [directUser('What tea do I like?')],
  });
  broken.bridge.onSessionEvent(agent.session, assistantMessage(1, 'Noted.'));
  broken.bridge.onSessionEvent(agent.session, turnEnd(1));
  await broken.bridge.waitForIdle(OTHER_SESSION);
  assert.equal((decision.messages ?? []).length, 0);
  assert.equal(broken.writes.length, 0);
  assert.equal(broken.llm.calls.length, 0);
});

test('two sessions keep their own source association in the shared background worker', async () => {
  const writes = [];
  const tools = captureTools(writes);
  const { bridge } = makeBridge({ tools });
  await emitTurn(bridge, { turn: 1 });
  assert.equal(writes.length, 1);
  assert.equal(await bridge.waitForIdle(OTHER_SESSION), undefined);
});
