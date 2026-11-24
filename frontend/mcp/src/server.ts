import {
  ApiClient,
  DEFAULT_MAX_RESULT_CHARS,
  REGISTRY,
  toMcpTool,
  type McpTool,
  type ResultNotes,
  type ToMcpToolOptions,
} from "@traceroot-ai/tools";
import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { SURFACE_HIDDEN_PARAMS, exposedEntries } from "./exposure.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { PARAM_DESCRIPTIONS } from "./param-docs.js";
import { redactCredentials } from "./redaction.js";
import type { CallRecorder } from "./telemetry.js";
import {
  LIST_TRACES_DEFAULT_LIMIT,
  compactTraceList,
  traceListDefaults,
  traceReadDefaults,
  withholdTraceContent,
} from "./trace-content.js";

const GET_TRACE_NOTE =
  " On this surface the default is fields=skeleton, and the trace-level input, output and metadata are left out unless fields asks for io, metadata or full.";
const LIST_TRACES_NOTE =
  " Each row is a summary without the trace's input, output or metadata; read those for one trace with get_trace.";

/**
 * run_sql rows on this surface: a small default and a hard cap, so one query
 * cannot push a large result through the shared server process. The CLI and
 * the API keep their own limits.
 */
export const SQL_DEFAULT_ROWS = 100;
export const SQL_MAX_ROWS = 1_000;

/**
 * Client-specific _meta on every listed tool. Claude Code saves a tool result
 * over its own default length to a file instead of showing it to the model;
 * declaring this server's limit keeps results up to that length inline.
 */
export function toolMeta(maxResultChars: number): Record<string, unknown> {
  return { "anthropic/maxResultSizeChars": maxResultChars };
}

export interface ServerConfig {
  /** Origin of the Python public API (`rest`). */
  backendUrl: string;
  /** Per-request timeout for calls to the backend. */
  timeoutMs?: number;
  /** fetch override, for tests. */
  fetchImpl?: typeof fetch;
  /** Longest tool result text; a longer one is shrunk, as valid JSON, with a note on how to narrow the call. */
  maxResultChars?: number;
  /** Receives one record per tool call (no arguments, no content); unset records nothing. */
  recorder?: CallRecorder;
}

/** Per-request hooks around the caller's credential. */
export interface RequestHooks {
  /** Called when the backend answers a tool call 401: the credential stopped working. */
  onUnauthorized?: () => void;
  /** The request's User-Agent, for telemetry when the client names itself nowhere else. */
  userAgent?: string;
}

/**
 * `MCP_MAX_RESULT_CHARS` as a positive integer; unset or blank keeps the
 * adapter's default. Anything else fails at startup rather than serving
 * uncapped or empty results.
 */
export function parseMaxResultChars(raw: string | undefined): number | undefined {
  const value = (raw ?? "").trim();
  if (value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MCP_MAX_RESULT_CHARS must be a positive integer, got "${value}"`);
  }
  return parsed;
}

const registryDescription = (name: string) =>
  REGISTRY.find((entry) => entry.name === name)!.description;

/** Per-tool shaping that is specific to this surface. */
const TOOL_OPTIONS: Readonly<Record<string, Partial<ToMcpToolOptions>>> = {
  list_traces: {
    defaults: traceListDefaults,
    paramOverrides: {
      limit: {
        default: LIST_TRACES_DEFAULT_LIMIT,
        description: `Most traces to return, newest first (${LIST_TRACES_DEFAULT_LIMIT} when left out)`,
      },
    },
    transformResult: compactTraceList,
    description: registryDescription("list_traces") + LIST_TRACES_NOTE,
  },
  run_sql: {
    defaults: () => ({ max_rows: SQL_DEFAULT_ROWS }),
    paramOverrides: {
      max_rows: {
        maximum: SQL_MAX_ROWS,
        default: SQL_DEFAULT_ROWS,
        description: `Rows to return: ${SQL_DEFAULT_ROWS} when left out, at most ${SQL_MAX_ROWS.toLocaleString("en-US")}. Aggregate in the query rather than reading many rows.`,
      },
    },
  },
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

/**
 * Every result passes through credential redaction last, after any per-tool
 * shaping, so no `fields` value and no tool (run_sql can select any span
 * attribute) returns a credential. See redaction.ts for the rule.
 */
function withRedaction(
  transform: ToMcpToolOptions["transformResult"],
): NonNullable<ToMcpToolOptions["transformResult"]> {
  return (result, args, notes: ResultNotes) =>
    redactCredentials(transform ? transform(result, args, notes) : result, notes);
}

/** The exposed tools, built against `client`. What a connected assistant is offered. */
export function buildTools(client: ApiClient, maxResultChars?: number): McpTool[] {
  return exposedEntries(REGISTRY).map((entry) => {
    const options = TOOL_OPTIONS[entry.name] ?? {};
    return toMcpTool(entry, {
      client,
      maxResultChars,
      hiddenParams: SURFACE_HIDDEN_PARAMS,
      paramDescriptions: PARAM_DESCRIPTIONS,
      ...options,
      transformResult: withRedaction(options.transformResult),
    });
  });
}

/**
 * The SDK validates arguments before a handler runs and answers with its own
 * terse message. Each tool validates its arguments itself (toMcpTool), with an
 * error that names the bad paths and the accepted shape, so the SDK is handed
 * a validator that accepts anything. The advertised schema is unchanged.
 */
const VALIDATED_BY_TOOL: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/**
 * Build the server for one request. The caller's credential is forwarded
 * unchanged as the backend's bearer; the backend validates it and scopes the
 * call to the key's project, so nothing here holds or checks a credential.
 */
export function createServer(
  authorization: string,
  config: ServerConfig,
  hooks: RequestHooks = {},
): McpServer {
  const client = new ApiClient({
    baseUrl: config.backendUrl,
    headers: { Authorization: authorization },
    timeoutMs: config.timeoutMs,
    fetchImpl: watchUnauthorized(config.fetchImpl, hooks.onUnauthorized),
  });
  const server = new McpServer(
    { name: "traceroot", version: "0.0.1" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const maxResultChars = config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const _meta = toolMeta(maxResultChars);
  for (const tool of buildTools(client, maxResultChars)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(
          tool.inputSchema as unknown as JsonSchemaType,
          VALIDATED_BY_TOOL,
        ),
        annotations: tool.annotations,
        _meta,
      },
      async (args, ctx) => {
        const started = Date.now();
        const { content, structuredContent, isError, report } = await tool.execute(
          args,
          ctx.mcpReq.signal,
        );
        if (config.recorder) {
          const client = server.server.getClientVersion();
          config.recorder.record({
            tool: tool.name,
            clientName: client?.name,
            clientVersion: client?.version,
            userAgent: client ? undefined : hooks.userAgent?.slice(0, 200),
            startTimeMs: started,
            durationMs: Date.now() - started,
            isError: isError === true,
            errorKind: report.errorKind,
            httpStatus: report.httpStatus,
            resultChars: report.resultChars,
            truncated: report.truncated,
            redactions: report.redactions,
            unwrappedArguments: report.unwrappedFrom !== undefined,
          });
        }
        // Rebuilt as a literal: the SDK's result type carries an index
        // signature that the adapter's structural interface does not, and the
        // report stays on this side.
        return { content, isError, ...(structuredContent ? { structuredContent } : {}) };
      },
    );
  }
  return server;
}

/**
 * Wrap fetch to report a 401 from the backend. The tool result is already on
 * its way as an error by then (the response status is committed before a tool
 * runs), so the report is what turns the next request into a 401.
 */
function watchUnauthorized(
  fetchImpl: typeof fetch | undefined,
  onUnauthorized: (() => void) | undefined,
): typeof fetch | undefined {
  if (!onUnauthorized) return fetchImpl;
  return async (input, init) => {
    const response = await (fetchImpl ?? fetch)(input, init);
    if (response.status === 401) onUnauthorized();
    return response;
  };
}
