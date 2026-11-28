/**
 * Per-call telemetry for tool calls.
 *
 * Every call logs one JSON line to stdout (tool, duration, outcome). When
 * MCP_TELEMETRY_OTLP_ENDPOINT is set, every call is also exported as one span
 * over OTLP/HTTP (protobuf), so it can be sent to a TraceRoot project's own
 * ingest (`POST /api/v1/public/traces` with that project's API key) or to any
 * OpenTelemetry collector.
 *
 * A record holds what the call did, never what it carried: no argument values,
 * no result content and no credential. The tool name, the client's
 * self-reported name and version, timing, outcome and sizes are all it has.
 */
import { randomBytes } from "node:crypto";
import type { McpErrorKind } from "@traceroot-ai/tools";

/** One finished tool call. */
export interface ToolCallRecord {
  tool: string;
  /** The client's name and version from its MCP handshake, when it sent one. */
  clientName?: string;
  clientVersion?: string;
  /** The HTTP User-Agent, when the handshake named no client. */
  userAgent?: string;
  startTimeMs: number;
  durationMs: number;
  isError: boolean;
  errorKind?: McpErrorKind;
  httpStatus?: number;
  resultChars: number;
  truncated: boolean;
  redactions: number;
  unwrappedArguments: boolean;
}

/** Where finished calls go. */
export interface CallRecorder {
  record(call: ToolCallRecord): void;
}

/** The stdout line: enough to grep a failing tool, nothing a call carried. */
export function logLine(call: ToolCallRecord): string {
  return JSON.stringify({
    event: "mcp_tool_call",
    tool: call.tool,
    duration_ms: Math.round(call.durationMs),
    is_error: call.isError,
    ...(call.errorKind ? { error_kind: call.errorKind } : {}),
    ...(call.clientName ? { client: call.clientName } : {}),
  });
}

/** Logs each call to stdout, then hands it to the exporter, if one is set. */
export function callRecorder(
  exporter: CallRecorder | undefined,
  log: (line: string) => void = console.log,
): CallRecorder {
  return {
    record(call) {
      log(logLine(call));
      exporter?.record(call);
    },
  };
}

export interface TelemetryConfig {
  /** Full OTLP/HTTP traces URL, e.g. https://api.traceroot.ai/api/v1/public/traces. */
  endpoint: string;
  /** Sent with every export, e.g. Authorization. */
  headers: Record<string, string>;
  serviceName: string;
}

/**
 * MCP_TELEMETRY_OTLP_ENDPOINT, MCP_TELEMETRY_OTLP_HEADERS and
 * MCP_TELEMETRY_SERVICE_NAME. Off (undefined) unless the endpoint is set.
 * Headers are `name=value` pairs separated by commas, values URL-decoded, as
 * OTEL_EXPORTER_OTLP_HEADERS writes them.
 */
export function parseTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
): TelemetryConfig | undefined {
  const endpoint = (env.MCP_TELEMETRY_OTLP_ENDPOINT ?? "").trim();
  if (endpoint === "") return undefined;
  let protocol: string | undefined;
  try {
    protocol = new URL(endpoint).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`MCP_TELEMETRY_OTLP_ENDPOINT must be an http(s) URL, got "${endpoint}"`);
  }
  const headers: Record<string, string> = {};
  for (const pair of (env.MCP_TELEMETRY_OTLP_HEADERS ?? "").split(",")) {
    if (pair.trim() === "") continue;
    const at = pair.indexOf("=");
    if (at <= 0) {
      // Never echo the pair: it is probably a credential.
      throw new Error("MCP_TELEMETRY_OTLP_HEADERS must be comma-separated name=value pairs");
    }
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  const serviceName = (env.MCP_TELEMETRY_SERVICE_NAME ?? "").trim() || "traceroot-mcp";
  return { endpoint, headers, serviceName };
}

export interface OtlpExporterOptions extends TelemetryConfig {
  fetchImpl?: typeof fetch;
  /** Export when this many spans are waiting. */
  maxBatch?: number;
  /** Export waiting spans at least this often. */
  flushIntervalMs?: number;
  /** Spans kept while the endpoint is unreachable; older ones are dropped. */
  maxQueue?: number;
  /** Where export failures are reported (status only, never the payload). */
  warn?: (message: string) => void;
}

/**
 * Batches tool-call spans and posts them as an OTLP ExportTraceServiceRequest.
 * Fire and forget: a failed export is logged and dropped, and never slows or
 * fails a tool call.
 */
export class OtlpCallExporter implements CallRecorder {
  private readonly options: Required<Omit<OtlpExporterOptions, "fetchImpl">> & {
    fetchImpl?: typeof fetch;
  };
  private queue: ToolCallRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> = Promise.resolve();

  constructor(options: OtlpExporterOptions) {
    this.options = {
      maxBatch: 50,
      flushIntervalMs: 5_000,
      maxQueue: 2_000,
      warn: (message) => console.warn(message),
      ...options,
    };
  }

  record(call: ToolCallRecord): void {
    this.queue.push(call);
    if (this.queue.length > this.options.maxQueue) {
      this.queue.splice(0, this.queue.length - this.options.maxQueue);
    }
    if (this.queue.length >= this.options.maxBatch) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Export everything waiting; resolves when the export finished or failed. */
  flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) {
      if (this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return this.inflight;
    }
    this.inflight = this.inflight.then(() => this.send(batch));
    return this.inflight;
  }

  private async send(batch: ToolCallRecord[]): Promise<void> {
    const { endpoint, headers, serviceName, fetchImpl = fetch, warn } = this.options;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-protobuf" },
        body: encodeExportRequest(batch, serviceName),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        warn(`MCP telemetry export failed: HTTP ${response.status}`);
      }
    } catch (error) {
      warn(`MCP telemetry export failed: ${error instanceof Error ? error.name : "error"}`);
    }
  }
}

/** The span attributes of a call; the only fields that leave the process. */
export function spanAttributes(call: ToolCallRecord): [string, string | number | boolean][] {
  const attributes: [string, string | number | boolean | undefined][] = [
    // Shown as a tool span when the endpoint is a TraceRoot project.
    ["traceroot.span.type", "TOOL"],
    ["mcp.tool.name", call.tool],
    ["mcp.client.name", call.clientName],
    ["mcp.client.version", call.clientVersion],
    ["user_agent.original", call.userAgent],
    ["mcp.tool.is_error", call.isError],
    ["error.type", call.errorKind],
    ["http.response.status_code", call.httpStatus],
    ["mcp.tool.duration_ms", Math.round(call.durationMs)],
    ["mcp.tool.result_chars", call.resultChars],
    ["mcp.tool.truncated", call.truncated],
    ["mcp.tool.redactions", call.redactions],
    ["mcp.tool.unwrapped_arguments", call.unwrappedArguments],
  ];
  return attributes.filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  );
}

// --- OTLP protobuf encoding -------------------------------------------------
//
// Just the fields of opentelemetry/proto/collector/trace/v1 a span of ours
// uses, written by hand so the service needs no OpenTelemetry dependency.

/** Protobuf writer for the handful of wire types OTLP spans need. */
class ProtoWriter {
  private readonly chunks: number[] = [];

  varint(value: number | bigint): this {
    let rest = BigInt(value);
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest > 0n) byte |= 0x80;
      this.chunks.push(byte);
    } while (rest > 0n);
    return this;
  }

  private tag(field: number, wireType: number): this {
    return this.varint((field << 3) | wireType);
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, 2).varint(value.length);
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  message(field: number, write: (inner: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    write(inner);
    return this.bytes(field, inner.finish());
  }

  uint(field: number, value: number | bigint): this {
    return this.tag(field, 0).varint(value);
  }

  fixed64(field: number, value: bigint): this {
    this.tag(field, 1);
    for (let i = 0n; i < 8n; i++) this.chunks.push(Number((value >> (8n * i)) & 0xffn));
    return this;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.chunks);
  }
}

function writeAnyValue(writer: ProtoWriter, value: string | number | boolean): void {
  // AnyValue: string_value = 1, bool_value = 2, int_value = 3.
  if (typeof value === "string") writer.string(1, value);
  else if (typeof value === "boolean") writer.uint(2, value ? 1 : 0);
  else writer.uint(3, BigInt.asUintN(64, BigInt(Math.trunc(value))));
}

function writeKeyValue(
  writer: ProtoWriter,
  field: number,
  key: string,
  value: string | number | boolean,
): void {
  // KeyValue: key = 1, value = 2.
  writer.message(field, (kv) => {
    kv.string(1, key);
    kv.message(2, (any) => writeAnyValue(any, value));
  });
}

const nanos = (ms: number) => BigInt(Math.round(ms * 1_000)) * 1_000n;

/** Encode tool calls as an ExportTraceServiceRequest, one trace and one root span per call. */
export function encodeExportRequest(
  calls: ToolCallRecord[],
  serviceName: string,
): Uint8Array<ArrayBuffer> {
  const request = new ProtoWriter();
  // ExportTraceServiceRequest.resource_spans = 1
  request.message(1, (resourceSpans) => {
    // ResourceSpans.resource = 1 → Resource.attributes = 1
    resourceSpans.message(1, (resource) => {
      writeKeyValue(resource, 1, "service.name", serviceName);
    });
    // ResourceSpans.scope_spans = 2
    resourceSpans.message(2, (scopeSpans) => {
      // ScopeSpans.scope = 1 → InstrumentationScope.name = 1
      scopeSpans.message(1, (scope) => scope.string(1, "traceroot-mcp"));
      for (const call of calls) {
        // ScopeSpans.spans = 2
        scopeSpans.message(2, (span) => {
          span.bytes(1, randomBytes(16)); // trace_id
          span.bytes(2, randomBytes(8)); // span_id
          span.string(5, `tools/call ${call.tool}`); // name
          span.uint(6, 2); // kind = SPAN_KIND_SERVER
          span.fixed64(7, nanos(call.startTimeMs)); // start_time_unix_nano
          span.fixed64(8, nanos(call.startTimeMs + call.durationMs)); // end_time_unix_nano
          for (const [key, value] of spanAttributes(call)) {
            writeKeyValue(span, 9, key, value); // attributes
          }
          // status = 15 → Status.code = 3 (1 OK, 2 ERROR)
          span.message(15, (status) => status.uint(3, call.isError ? 2 : 1));
        });
      }
    });
  });
  return request.finish();
}
