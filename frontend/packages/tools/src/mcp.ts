import type { ApiClient } from "./client.js";
import { dispatch } from "./dispatch.js";
import { stripOversizedNumericBounds } from "./sanitize.js";
import type { InputSchema, RegistryEntry, ToolAnnotations } from "./types.js";

/** One text block of an MCP tool result. */
export interface McpToolResultContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolResultContent[];
  /** Set when the call failed; the text then carries the backend's detail. */
  isError?: boolean;
}

/**
 * The MCP server's tool shape, matched structurally so this package needs no
 * dependency on the MCP SDK. `inputSchema` is plain JSON Schema; the server
 * wraps it for its SDK.
 */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  execute: (rawParams: unknown, signal?: AbortSignal) => Promise<McpToolResult>;
}

export interface ToMcpToolOptions {
  client: ApiClient;
  /**
   * Params this surface hides on top of the entry's agentHiddenParams, e.g.
   * the project id an API key already fixes. Dropped from calls the same way.
   */
  hiddenParams?: readonly string[];
  /** Replaces the entry's description for this surface. */
  description?: string;
  /**
   * Values for params the caller omits. Unlike the pi adapter's they stay in
   * the schema and lose to a value the caller supplies.
   */
  defaults?: (supplied: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /**
   * Shapes the API result before it is rendered, given the args the call was
   * made with (defaults applied). The content-withholding default of a trace
   * read is the motivating case.
   */
  transformResult?: (result: unknown, args: Readonly<Record<string, unknown>>) => unknown;
}

/**
 * Adapt a registry entry to an MCP tool: hide the entry's agentHiddenParams
 * and the surface's hiddenParams from the schema and drop them from calls,
 * apply defaults, pass the entry's annotations through, dispatch through the
 * shared engine, and return failures as `isError` results carrying the
 * backend's own detail so the model can read it and adapt.
 */
export function toMcpTool(entry: RegistryEntry, options: ToMcpToolOptions): McpTool {
  const { client, hiddenParams = [], description, defaults, transformResult } = options;

  const hidden = new Set([...(entry.agentHiddenParams ?? []), ...hiddenParams]);
  const properties: InputSchema["properties"] = {};
  for (const [name, schema] of Object.entries(entry.inputSchema.properties)) {
    if (!hidden.has(name)) {
      properties[name] = stripOversizedNumericBounds(schema);
    }
  }
  const inputSchema: InputSchema = {
    type: "object",
    properties,
    required: entry.inputSchema.required.filter((name) => !hidden.has(name)),
    additionalProperties: false,
  };

  // Generated entries always carry their hints; a hand-written entry without
  // them would reach a client unannotated, so refuse it here.
  const annotations = entry.annotations;
  if (annotations === undefined) {
    throw new Error(`Registry entry ${entry.name} has no annotations; regenerate the registry`);
  }
  return {
    name: entry.name,
    title: annotations.title,
    description: description ?? entry.description,
    inputSchema,
    annotations,
    execute: async (rawParams, signal): Promise<McpToolResult> => {
      const params = { ...((rawParams ?? {}) as Record<string, unknown>) };
      // The schema says these fields do not exist, so a value for one is never
      // the caller's.
      for (const name of hidden) {
        delete params[name];
      }
      const supplied = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      );
      try {
        const args = { ...(defaults?.(supplied) ?? {}), ...supplied };
        const result = await dispatch(entry, args, client, { signal });
        const shaped = transformResult ? transformResult(result, args) : result;
        return { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error calling ${entry.name}: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
