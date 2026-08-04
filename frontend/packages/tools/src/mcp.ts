import type { InputSchema, RegistryEntry } from "./types.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

/** Adapt a registry entry to the MCP tool-listing shape (inert; the server dispatches). */
export function toMcpTool(entry: RegistryEntry): McpTool {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
  };
}
