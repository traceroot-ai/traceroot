import {
  ApiClient,
  REGISTRY,
  toMcpTool,
  type McpTool,
  type ToMcpToolOptions,
} from "@traceroot-ai/tools";
import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { SURFACE_HIDDEN_PARAMS, exposedEntries } from "./exposure.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { PARAM_DESCRIPTIONS } from "./param-docs.js";
import { traceReadDefaults, withholdTraceContent } from "./trace-content.js";

const GET_TRACE_NOTE =
  " On this surface the default is fields=skeleton, and the trace-level input, output and metadata are left out unless fields asks for io, metadata or full.";

export interface ServerConfig {
  /** Origin of the Python public API (`rest`). */
  backendUrl: string;
  /** Per-request timeout for calls to the backend. */
  timeoutMs?: number;
  /** fetch override, for tests. */
  fetchImpl?: typeof fetch;
}

const registryDescription = (name: string) =>
  REGISTRY.find((entry) => entry.name === name)!.description;

/** Per-tool shaping that is specific to this surface. */
const TOOL_OPTIONS: Readonly<Record<string, Partial<ToMcpToolOptions>>> = {
  get_trace: {
    defaults: traceReadDefaults,
    transformResult: withholdTraceContent,
    description: registryDescription("get_trace") + GET_TRACE_NOTE,
  },
  run_widget_query: {
    // The registry's wording points at create_widget, which this surface does not
    // offer; the spec parameter carries the shape.
    description: registryDescription("run_widget_query").replace(
      "the same spec shape as create_widget",
      "a widget spec",
    ),
  },
};

/** The exposed tools, built against `client`. What a connected assistant is offered. */
export function buildTools(client: ApiClient): McpTool[] {
  return exposedEntries(REGISTRY).map((entry) =>
    toMcpTool(entry, {
      client,
      hiddenParams: SURFACE_HIDDEN_PARAMS,
      paramDescriptions: PARAM_DESCRIPTIONS,
      ...TOOL_OPTIONS[entry.name],
    }),
  );
}

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
  const server = new McpServer(
    { name: "traceroot", version: "0.0.1" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of buildTools(client)) {
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
