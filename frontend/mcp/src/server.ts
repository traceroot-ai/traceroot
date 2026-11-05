import { ApiClient, REGISTRY, toMcpTool, type ToMcpToolOptions } from "@traceroot-ai/tools";
import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { QUERY_ONLY_POSTS, SURFACE_HIDDEN_PARAMS, exposedEntries } from "./exposure.js";
import { traceReadDefaults, withholdTraceContent } from "./trace-content.js";

export interface ServerConfig {
  /** Origin of the Python public API (`rest`). */
  backendUrl: string;
  /** Per-request timeout for calls to the backend. */
  timeoutMs?: number;
  /** fetch override, for tests. */
  fetchImpl?: typeof fetch;
}

/** Per-tool shaping that is specific to this surface. */
const TOOL_OPTIONS: Readonly<Record<string, Partial<ToMcpToolOptions>>> = {
  get_trace: { defaults: traceReadDefaults, transformResult: withholdTraceContent },
};

/**
 * Build the server for one request. The caller's credential is forwarded
 * unchanged as the backend's bearer; the backend validates it and scopes the
 * call to the key's project, so nothing here holds or checks a credential.
 */
export function createServer(authorization: string, config: ServerConfig): McpServer {
  const client = new ApiClient({
    baseUrl: config.backendUrl,
    headers: { Authorization: authorization },
    timeoutMs: config.timeoutMs,
    fetchImpl: config.fetchImpl,
  });
  const server = new McpServer({ name: "traceroot", version: "0.0.1" });

  for (const entry of exposedEntries(REGISTRY)) {
    const tool = toMcpTool(entry, {
      client,
      readOnly: QUERY_ONLY_POSTS.has(entry.name),
      hiddenParams: SURFACE_HIDDEN_PARAMS,
      ...TOOL_OPTIONS[entry.name],
    });
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as unknown as JsonSchemaType),
        annotations: tool.annotations,
      },
      async (args, ctx) => {
        // Rebuilt as a literal: the SDK's result type carries an index
        // signature that the adapter's structural interface does not.
        const { content, isError } = await tool.execute(args, ctx.mcpReq.signal);
        return { content, isError };
      },
    );
  }
  return server;
}
