/**
 * Hide Basic Memory's permanent-delete tools from agent scopes.
 *
 * The host exposes MCP tools asynchronously: an agent may start its first turn
 * before basic_memory has registered anything, and a later tools/change then
 * makes delete_note or delete_project visible. A per-agent guard covers that
 * window, while a scoped restriction removes each definition once it is known.
 */
export const PERMANENT_DELETE_TOOL = 'mcp__basic_memory__delete_note';
export const PERMANENT_DELETE_TOOLS = Object.freeze([
  PERMANENT_DELETE_TOOL,
  'mcp__basic_memory__delete_project',
]);
export const PERMANENT_DELETE_REASON =
  'Permanent deletion is disabled for agents. Submit the item for human review instead '
  + '(dafeiyu_records action=delete/archive); nothing will be deleted, disabled, or downgraded.';

function hasExecute(definition) {
  return Boolean(definition && typeof definition.execute === 'function');
}

export function createPermanentDeleteGuard({ tools, logger } = {}) {
  const tracked = new Set();
  const guarded = new WeakSet();
  const restrictedByAgent = new WeakMap();

  function visible(agent, toolName) {
    if (!agent || typeof tools?.get !== 'function') return false;
    try {
      return hasExecute(tools.get(toolName, agent));
    } catch {
      return false;
    }
  }

  function installGuard(agent) {
    const scoped = agent?.ctx?.tools;
    if (!scoped || typeof scoped.guard !== 'function' || guarded.has(agent)) return;
    try {
      scoped.guard((exec) => (
        exec && PERMANENT_DELETE_TOOLS.includes(exec.name) ? PERMANENT_DELETE_REASON : undefined
      ));
      guarded.add(agent);
    } catch (error) {
      logger?.warn?.(
        '[basic-memory-bridge] could not install permanent-delete guard: '
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  function installRestriction(agent) {
    const scoped = agent?.ctx?.tools;
    if (!scoped || typeof scoped.restrict !== 'function') return;
    let restricted = restrictedByAgent.get(agent);
    if (!restricted) {
      restricted = new Set();
      restrictedByAgent.set(agent, restricted);
    }
    for (const toolName of PERMANENT_DELETE_TOOLS) {
      if (restricted.has(toolName) || !visible(agent, toolName)) continue;
      try {
        scoped.restrict({ deny: [toolName] });
        restricted.add(toolName);
      } catch (error) {
        // Unknown names mean the MCP registration is not settled yet; the guard
        // still denies execution and a later tools/change retries the restriction.
        const message = error instanceof Error ? error.message : String(error);
        if (/unknown global tool/i.test(message)) continue;
        logger?.warn?.('[basic-memory-bridge] could not hide ' + toolName + ': ' + message);
      }
    }
  }

  function protect(agent) {
    if (!agent || typeof agent !== 'object') return;
    tracked.add(agent);
    installGuard(agent);
    installRestriction(agent);
  }

  function refresh() {
    for (const agent of [...tracked]) protect(agent);
  }

  return { protect, refresh };
}
