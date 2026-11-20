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
  /**
   * Descriptions for params the registry leaves undescribed, by param name. A
   * description the registry already carries wins. A model picks arguments from
   * these, so a bare `trace_id` that does not say where the id comes from is a
   * guess waiting to happen.
   */
  paramDescriptions?: Readonly<Record<string, string>>;
  /**
   * Longest result text returned. A longer one is cut and says so, so the model
   * narrows the request instead of reasoning over a silently partial answer or
   * overflowing its context. Defaults to DEFAULT_MAX_RESULT_CHARS.
   */
  maxResultChars?: number;
}

/** About 20k tokens of JSON: under the limit clients such as Claude Code apply to a tool result. */
export const DEFAULT_MAX_RESULT_CHARS = 80_000;

/** Cut text to `limit` characters, appending what happened and what to do about it. */
export function truncateResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[Result truncated: it was ${text.length} characters and the limit is ${limit}. ` +
    "Narrow the request (a shorter time window, a smaller limit, or specific fields) and call again.]"
  );
}

/**
 * Adapt a registry entry to an MCP tool: hide the entry's agentHiddenParams
 * and the surface's hiddenParams from the schema and drop them from calls,
 * apply defaults, pass the entry's annotations through, dispatch through the
 * shared engine, and return failures as `isError` results carrying the
 * backend's own detail so the model can read it and adapt.
 */
export function toMcpTool(entry: RegistryEntry, options: ToMcpToolOptions): McpTool {
  const {
    client,
    hiddenParams = [],
    description,
    defaults,
    transformResult,
    paramDescriptions = {},
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
  } = options;

  const hidden = new Set([...(entry.agentHiddenParams ?? []), ...hiddenParams]);
  const properties: InputSchema["properties"] = {};
  for (const [name, schema] of Object.entries(entry.inputSchema.properties)) {
    if (!hidden.has(name)) {
      const described = stripOversizedNumericBounds(schema);
      const fallback = paramDescriptions[name];
      properties[name] =
        fallback && !("description" in described)
          ? { ...described, description: fallback }
          : described;
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
        // Compact: the model reads it as well as indented JSON, in about a third fewer tokens.
        const text = truncateResult(JSON.stringify(shaped), maxResultChars);
        return { content: [{ type: "text", text }] };
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
