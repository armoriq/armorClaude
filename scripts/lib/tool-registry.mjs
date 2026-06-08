/**
 * Tool identity parser and MCP registry helpers.
 *
 * Tool name taxonomy:
 *   Read, Edit, Bash                           → builtin
 *   mcp__armorclaude-policy__*                  → armorclaude-own
 *   mcp__plugin_armorclaude_armorclaude-policy__* → armorclaude-own
 *   mcp__<server>__<tool>                       → external-mcp
 *   mcp__plugin_<plugin>_<server>__<tool>       → plugin-mcp
 *   Skill (with skill name in input)            → skill
 */

const MCP_PATTERN = /^mcp__([^_]+(?:__[^_]+)*)__([^_]+.*)$/i;
const PLUGIN_MCP_PATTERN = /^mcp__plugin_([^_]+)_([^_]+(?:__[^_]+)*)__([^_]+.*)$/i;

export function parseToolIdentity(toolName) {
  if (!toolName || typeof toolName !== "string") {
    return { category: "unknown", toolName: "", serverName: "" };
  }

  const norm = toolName.toLowerCase();

  if (norm === "skill") {
    return { category: "skill", toolName, serverName: "" };
  }

  const pluginMatch = toolName.match(PLUGIN_MCP_PATTERN);
  if (pluginMatch) {
    const [, pluginName, serverName, tool] = pluginMatch;
    const armorOwn =
      serverName.toLowerCase() === "armorclaude-policy" &&
      pluginName.toLowerCase() === "armorclaude";
    return {
      category: armorOwn ? "armorclaude-own" : "plugin-mcp",
      toolName: tool,
      serverName,
      pluginName
    };
  }

  const mcpMatch = toolName.match(MCP_PATTERN);
  if (mcpMatch) {
    const [, serverName, tool] = mcpMatch;
    const armorOwn = serverName.toLowerCase() === "armorclaude-policy";
    return {
      category: armorOwn ? "armorclaude-own" : "external-mcp",
      toolName: tool,
      serverName
    };
  }

  return { category: "builtin", toolName, serverName: "" };
}

export function getMcpRegistry(runtimeState) {
  if (!runtimeState.mcpRegistry || typeof runtimeState.mcpRegistry !== "object") {
    runtimeState.mcpRegistry = {};
  }
  return runtimeState.mcpRegistry;
}

export function getMcpServerStatus(runtimeState, serverName) {
  const registry = getMcpRegistry(runtimeState);
  return registry[serverName] || null;
}

export function setMcpServerStatus(runtimeState, serverName, status) {
  const registry = getMcpRegistry(runtimeState);
  registry[serverName] = {
    serverName,
    status,
    updatedAt: Math.floor(Date.now() / 1000),
    ...(registry[serverName] || {})
  };
  registry[serverName].status = status;
  registry[serverName].updatedAt = Math.floor(Date.now() / 1000);
}

export function listMcpServers(runtimeState) {
  const registry = getMcpRegistry(runtimeState);
  return Object.values(registry);
}
