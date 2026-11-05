import type { ApiClient } from "./client.js";
import { dispatch } from "./dispatch.js";
import { stripOversizedNumericBounds } from "./sanitize.js";
import type { InputSchema, RegistryEntry } from "./types.js";

/** One text block of an MCP tool result. */
export interface McpToolResultContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolResultContent[];
  /** Set when the call failed; the text then carries the backend's detail. */
  isError?: true;
}

/** The hint set every exposed tool carries (MCP `ToolAnnotations`). */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: false;
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
  annotations: McpToolAnnotations;
  execute: (rawParams: unknown, signal?: AbortSignal) => Promise<McpToolResult>;
}

export interface ToMcpToolOptions {
  client: ApiClient;
  /** The entry runs a query rather than a mutation, though its verb is not GET. */
  readOnly?: boolean;
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

/** "list_traces" -> "List traces" for the tool's human-readable title. */
function humanizeName(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Hints derived from what the registry already knows, so every surface that
 * adapts an entry reports the same thing and none is hand-annotated: a GET is
 * read-only; a DELETE, or any write whose policy demands approval, is
 * destructive; every tool is bounded to one project, so none is open-world.
 *
 * The registry cannot yet say that a POST only runs a query (`run_sql`,
 * `run_widget_query`), so the caller declares it with `readOnly`. Moving that
 * into the generated entry is the follow-up that retires the parameter.
 */
export function mcpAnnotations(
  entry: RegistryEntry,
  options: { readOnly?: boolean } = {},
): McpToolAnnotations {
  const readOnly = entry.method === "get" || options.readOnly === true;
  return {
    title: humanizeName(entry.name),
    readOnlyHint: readOnly,
    destructiveHint:
      !readOnly && (entry.method === "delete" || entry.policy?.approvalClass === "approval"),
    openWorldHint: false,
  };
}

/**
 * Adapt a registry entry to an MCP tool: hide the entry's agentHiddenParams
 * from the schema and drop them from calls, apply defaults, dispatch through
 * the shared engine, and return failures as `isError` results carrying the
 * backend's own detail so the model can read it and adapt.
 */
export function toMcpTool(entry: RegistryEntry, options: ToMcpToolOptions): McpTool {
  const { client, readOnly, description, defaults, transformResult } = options;

  const hidden = new Set(entry.agentHiddenParams ?? []);
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

  const annotations = mcpAnnotations(entry, { readOnly });
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
