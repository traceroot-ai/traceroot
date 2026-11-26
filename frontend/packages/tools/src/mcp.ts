import { ApiError, type ApiClient } from "./client.js";
import { dispatch } from "./dispatch.js";
import { fitToBudget } from "./fit.js";
import { stripOversizedNumericBounds } from "./sanitize.js";
import type { InputSchema, RegistryEntry, ToolAnnotations } from "./types.js";
import { checkArguments } from "./validate.js";

/** One text block of an MCP tool result. */
export interface McpToolResultContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolResultContent[];
  /**
   * The result object the text encodes, for clients that read structured
   * output. Present only when the result is a JSON object.
   */
  structuredContent?: Record<string, unknown>;
  /** Set when the call failed; the text then carries the backend's detail. */
  isError?: boolean;
  /** How the call went, for the server's own telemetry. Never sent to the client. */
  report: McpCallReport;
}

/** Why a call failed, coarse enough to count. */
export type McpErrorKind =
  | "invalid_arguments"
  | "api_error"
  | "timeout"
  | "aborted"
  | "network"
  | "internal";

/** What a call did, without its arguments or result content. */
export interface McpCallReport {
  errorKind?: McpErrorKind;
  /** The backend's status when it answered with an error. */
  httpStatus?: number;
  /** Length of the text returned to the client. */
  resultChars: number;
  /** The result was shrunk to fit the character budget. */
  truncated: boolean;
  /** Values withheld as credentials by transformResult. */
  redactions: number;
  /** The wrapper key the arguments were unwrapped from, if any. */
  unwrappedFrom?: string;
}

/** Counters a transformResult may add to; they end up in the call's report. */
export interface ResultNotes {
  redactions: number;
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
  transformResult?: (
    result: unknown,
    args: Readonly<Record<string, unknown>>,
    notes: ResultNotes,
  ) => unknown;
  /**
   * Descriptions for params the registry leaves undescribed, by param name. A
   * description the registry already carries wins. A model picks arguments from
   * these, so a bare `trace_id` that does not say where the id comes from is a
   * guess waiting to happen.
   */
  paramDescriptions?: Readonly<Record<string, string>>;
  /**
   * Schema keywords this surface sets on a param, by param name, over the
   * registry's (e.g. a lower `maximum` and a `default` that `defaults` applies).
   * Arguments are checked against the result, so a value outside it is refused
   * with the usual argument error.
   */
  paramOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Longest result text returned. A longer result is shrunk structurally (long
   * strings cut, then list tails dropped) so it stays valid JSON, and says what
   * went and how to ask for less, so the model narrows the request instead of
   * reasoning over a silently partial answer or overflowing its context.
   * Defaults to DEFAULT_MAX_RESULT_CHARS.
   */
  maxResultChars?: number;
}

/** About 20k tokens of JSON: under the limit clients such as Claude Code apply to a tool result. */
export const DEFAULT_MAX_RESULT_CHARS = 80_000;

/**
 * How to ask for less, from the params the tool actually takes; stored as the
 * shrunk result's `_hint`.
 */
export function narrowingHint(schema: InputSchema, limit: number): string {
  const has = (name: string) => name in schema.properties;
  const ways: string[] = [];
  if (has("limit")) ways.push("a smaller limit");
  if (has("max_rows")) ways.push("a lower max_rows");
  if (has("start_after") && has("end_before")) {
    ways.push("a shorter time window (start_after, end_before)");
  } else if (has("start_time") && has("end_time")) {
    ways.push("a shorter time window (start_time, end_time)");
  }
  if (has("fields")) ways.push("a lighter fields value");
  const paging = ["cursor", "page"].filter(has);
  const narrow = ways.length > 0 ? `Ask for less (${ways.join(", ")})` : "Narrow the request";
  const page = paging.length > 0 ? `, or page through with ${paging.join("/")}` : "";
  return (
    `This result was over the ${limit}-character limit and was shortened: a cut value ends ` +
    `in "…[truncated N chars]" and dropped list items are counted in _truncated, by path. ` +
    `${narrow}${page} and call again.`
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
    paramOverrides = {},
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
  } = options;

  const hidden = new Set([...(entry.agentHiddenParams ?? []), ...hiddenParams]);
  const properties: InputSchema["properties"] = {};
  for (const [name, schema] of Object.entries(entry.inputSchema.properties)) {
    if (!hidden.has(name)) {
      const described = stripOversizedNumericBounds(schema);
      const fallback = paramDescriptions[name];
      properties[name] = {
        ...(fallback && !("description" in described)
          ? { ...described, description: fallback }
          : described),
        ...paramOverrides[name],
      };
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
  const hint = narrowingHint(inputSchema, maxResultChars);
  return {
    name: entry.name,
    title: annotations.title,
    description: description ?? entry.description,
    inputSchema,
    annotations,
    execute: async (rawParams, signal): Promise<McpToolResult> => {
      // Checked here rather than by the server's SDK so the message can teach:
      // it names each bad path, unknown keys and the accepted shape.
      const checked = checkArguments(entry.name, inputSchema, rawParams, { hidden });
      if (!checked.ok) {
        return failure(checked.message, { errorKind: "invalid_arguments" });
      }
      const params = { ...checked.args };
      // The schema says these fields do not exist, so a value for one is never
      // the caller's.
      for (const name of hidden) {
        delete params[name];
      }
      const supplied = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      );
      try {
        const args: Record<string, unknown> = { ...(defaults?.(supplied) ?? {}), ...supplied };
        // A default must not bring a hidden field back.
        for (const name of hidden) {
          delete args[name];
        }
        const result = await dispatch(entry, args, client, { signal });
        const notes: ResultNotes = { redactions: 0 };
        const shaped = transformResult ? transformResult(result, args, notes) : result;
        // Compact: the model reads it as well as indented JSON, in about a third fewer tokens.
        const fitted = fitToBudget(shaped, maxResultChars, { hint });
        return {
          content: [{ type: "text", text: fitted.text }],
          ...(isPlainObject(fitted.value) ? { structuredContent: fitted.value } : {}),
          report: {
            resultChars: fitted.text.length,
            truncated: fitted.truncated,
            redactions: notes.redactions,
            ...(checked.unwrappedFrom ? { unwrappedFrom: checked.unwrappedFrom } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`Error calling ${entry.name}: ${message}`, classify(error, signal));
      }
    },
  };
}

function failure(text: string, report: Partial<McpCallReport>): McpToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    report: { resultChars: text.length, truncated: false, redactions: 0, ...report },
  };
}

/** The error kind of a failed dispatch, from the error's class. */
function classify(error: unknown, signal: AbortSignal | undefined): Partial<McpCallReport> {
  if (error instanceof ApiError) {
    return { errorKind: "api_error", httpStatus: error.status };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { errorKind: "timeout" };
  }
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { errorKind: "aborted" };
  }
  if (error instanceof TypeError) {
    // fetch reports an unreachable backend as a TypeError.
    return { errorKind: "network" };
  }
  return { errorKind: "internal" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
