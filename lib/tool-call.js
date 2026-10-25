import { randomUUID } from 'node:crypto';

function failure(name, message) {
  return {
    isError: true,
    error: { name: 'ScopedToolCallError', code: 'SCOPED_TOOL_CALL_FAILED', message },
    content: [{ type: 'text', text: message }],
  };
}

function agentLabel(agent) {
  return agent?.session?.id ?? 'unknown-agent';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute a tool definition resolved in one agent's scope.
 *
 * DSH 0.2.1-rc.2 applies the PTC presentation collapse at the ToolRuntime.execute
 * boundary: under a PTC agent, a native tool name called without a parent token is
 * rejected as UNKNOWN_TOOL even though the definition is visible in the agent's
 * scope. This adapter resolves the already-mounted, per-agent ToolDefinition and
 * invokes its body directly, preserving the agent association without falling back
 * to a different backend or a global execution path.
 *
 * The synthesized ToolRunContext mirrors the fields a tool body receives from the
 * registry: call identity, parsed arguments, agent, cancellation signal, opaque
 * token, and the deferContext/concludeTurn callbacks. This bypasses the model-
 * facing PTC transport and its schema validation by design; callers only pass
 * bridge-owned, already-shaped arguments and fail open on any error.
 */
export async function executeScopedTool({ tools, name, args, agent, signal } = {}) {
  if (!tools || typeof tools.get !== 'function') {
    return failure(name, `scoped tool runtime unavailable for "${name}"`);
  }
  if (!agent) {
    return failure(name, `scoped tool "${name}" requires the target agent`);
  }

  let definition;
  try {
    definition = tools.get(name, agent);
  } catch (error) {
    return failure(name, `scoped tool lookup failed for "${name}": ${errorMessage(error)}`);
  }
  if (!definition || typeof definition.execute !== 'function') {
    return failure(name, `scoped tool "${name}" is not visible to agent ${agentLabel(agent)}`);
  }

  const callId = `bm-internal-${randomUUID()}`;
  const exec = {
    callId,
    rootCallId: callId,
    name,
    arguments: args,
    agent,
    signal: signal ?? new AbortController().signal,
    token: Symbol(name),
    deferContext() {},
    concludeTurn() {},
  };

  try {
    const value = await definition.execute(args, exec);
    return { isError: false, value, content: [] };
  } catch (error) {
    return failure(name, `scoped tool "${name}" failed: ${errorMessage(error)}`);
  }
}
