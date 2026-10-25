import test from 'node:test';
import assert from 'node:assert/strict';
import { executeScopedTool } from '../lib/tool-call.js';
import { fakeAgent, mcpResult, ptcTools, TARGET_SESSION } from './helpers.js';

test('executeScopedTool resolves and executes a PTC-agent scoped definition', async () => {
  const agent = fakeAgent(TARGET_SESSION);
  const tools = ptcTools(() => mcpResult({ ok: true }));
  const result = await executeScopedTool({
    tools,
    name: 'mcp__basic_memory__search_notes',
    args: { query: 'tea' },
    agent,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.value.structuredContent.result, { ok: true });
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].agent, agent);
  assert.equal(tools.getCalls[0].name, 'mcp__basic_memory__search_notes');
});

test('executeScopedTool fails closed on a missing definition without a global fallback', async () => {
  const agent = fakeAgent(TARGET_SESSION);
  let globalCalls = 0;
  const tools = {
    get: () => undefined,
    execute: async () => {
      globalCalls += 1;
      return mcpResult({ ok: true });
    },
  };
  const result = await executeScopedTool({
    tools,
    name: 'mcp__basic_memory__search_notes',
    args: {},
    agent,
  });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /not visible to agent/);
  assert.equal(globalCalls, 0);
});

test('executeScopedTool requires an agent and a scoped registry', async () => {
  const noAgent = await executeScopedTool({
    tools: ptcTools(() => mcpResult({})),
    name: 'mcp__basic_memory__search_notes',
    args: {},
  });
  assert.equal(noAgent.isError, true);
  assert.match(noAgent.error.message, /requires the target agent/);

  const noRegistry = await executeScopedTool({ tools: null, name: 'x', args: {} });
  assert.equal(noRegistry.isError, true);
  assert.match(noRegistry.error.message, /runtime unavailable/);
});
