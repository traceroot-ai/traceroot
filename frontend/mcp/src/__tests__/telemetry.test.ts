import { describe, expect, it, vi } from "vitest";
import {
  OtlpCallExporter,
  callRecorder,
  encodeExportRequest,
  logLine,
  parseTelemetryConfig,
  type ToolCallRecord,
} from "../telemetry.js";

const call: ToolCallRecord = {
  tool: "get_trace",
  clientName: "claude-code",
  clientVersion: "2.1.0",
  startTimeMs: 1_763_000_000_000,
  durationMs: 42.4,
  isError: true,
  errorKind: "api_error",
  httpStatus: 404,
  resultChars: 61,
  truncated: false,
  redactions: 3,
  unwrappedArguments: false,
};

// --- a minimal protobuf reader, enough to check what the exporter wrote ------

type Field = { field: number; wire: number; value: bigint | Uint8Array };

function readFields(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let at = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[at++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) fields.push({ field, wire, value: varint() });
    else if (wire === 1) {
      let value = 0n;
      for (let i = 0n; i < 8n; i++) value |= BigInt(bytes[at++]!) << (8n * i);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      const length = Number(varint());
      fields.push({ field, wire, value: bytes.slice(at, at + length) });
      at += length;
    } else throw new Error(`unexpected wire type ${wire}`);
  }
  return fields;
}

const sub = (fields: Field[], number: number) =>
  fields.filter((f) => f.field === number).map((f) => readFields(f.value as Uint8Array));
const text = (value: Field["value"]) => new TextDecoder().decode(value as Uint8Array);

/** The spans of an encoded request, each as its name, times, status and attributes. */
function decodeSpans(body: Uint8Array) {
  const [resourceSpans] = sub(readFields(body), 1);
  const [resource] = sub(resourceSpans!, 1);
  const serviceName = text(sub(sub(resource!, 1)[0]!, 2)[0]![0]!.value);
  const [scopeSpans] = sub(resourceSpans!, 2);
  const spans = sub(scopeSpans!, 2).map((span) => {
    const attributes: Record<string, unknown> = {};
    for (const kv of sub(span, 9)) {
      const key = text(kv.find((f) => f.field === 1)!.value);
      const any = readFields(kv.find((f) => f.field === 2)!.value as Uint8Array)[0]!;
      attributes[key] =
        any.field === 1 ? text(any.value) : any.field === 2 ? any.value === 1n : Number(any.value);
    }
    const one = (n: number) => span.find((f) => f.field === n)!.value;
    return {
      traceIdBytes: (one(1) as Uint8Array).length,
      spanIdBytes: (one(2) as Uint8Array).length,
      name: text(one(5)),
      kind: Number(one(6)),
      start: one(7) as bigint,
      end: one(8) as bigint,
      statusCode: Number(sub(span, 15)[0]![0]!.value),
      attributes,
    };
  });
  return { serviceName, spans };
}

describe("encodeExportRequest", () => {
  it("writes one server span per call with the call's attributes and nothing else", () => {
    const { serviceName, spans } = decodeSpans(encodeExportRequest([call], "traceroot-mcp"));
    expect(serviceName).toBe("traceroot-mcp");
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span).toMatchObject({
      traceIdBytes: 16,
      spanIdBytes: 8,
      name: "tools/call get_trace",
      kind: 2,
      statusCode: 2,
    });
    expect(span!.end - span!.start).toBe(42_400_000n);
    expect(span!.start).toBe(1_763_000_000_000_000_000n);
    expect(span!.attributes).toEqual({
      "traceroot.span.type": "TOOL",
      "mcp.tool.name": "get_trace",
      "mcp.client.name": "claude-code",
      "mcp.client.version": "2.1.0",
      "mcp.tool.is_error": true,
      "error.type": "api_error",
      "http.response.status_code": 404,
      "mcp.tool.duration_ms": 42,
      "mcp.tool.result_chars": 61,
      "mcp.tool.truncated": false,
      "mcp.tool.redactions": 3,
      "mcp.tool.unwrapped_arguments": false,
    });
  });

  it("marks a successful call OK", () => {
    const { spans } = decodeSpans(
      encodeExportRequest([{ ...call, isError: false, errorKind: undefined }], "s"),
    );
    expect(spans[0]!.statusCode).toBe(1);
    expect(spans[0]!.attributes).not.toHaveProperty("error.type");
  });
});

describe("OtlpCallExporter", () => {
  const exporterWith = (status = 200) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    const warn = vi.fn();
    const exporter = new OtlpCallExporter({
      endpoint: "https://traceroot.test/api/v1/public/traces",
      headers: { Authorization: "Bearer tr-telemetry" },
      serviceName: "traceroot-mcp",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBatch: 2,
      warn,
    });
    return { exporter, fetchImpl, warn };
  };

  it("posts protobuf to the endpoint with the configured headers, in batches", async () => {
    const { exporter, fetchImpl } = exporterWith();
    exporter.record(call);
    expect(fetchImpl).not.toHaveBeenCalled();
    exporter.record({ ...call, tool: "list_traces" });
    await exporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://traceroot.test/api/v1/public/traces");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tr-telemetry",
      "content-type": "application/x-protobuf",
    });
    const { spans } = decodeSpans(init.body as Uint8Array);
    expect(spans.map((span) => span.attributes["mcp.tool.name"])).toEqual([
      "get_trace",
      "list_traces",
    ]);
  });

  it("exports what is waiting on flush and reports a failed export without throwing", async () => {
    const { exporter, fetchImpl, warn } = exporterWith(500);
    exporter.record(call);
    await exporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("MCP telemetry export failed: HTTP 500");
    await exporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("callRecorder", () => {
  it("logs one line per call with the tool, duration and outcome, then exports it", () => {
    const lines: string[] = [];
    const exporter = { record: vi.fn() };
    callRecorder(exporter, (line) => lines.push(line)).record(call);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: "mcp_tool_call",
        tool: "get_trace",
        duration_ms: 42,
        is_error: true,
        error_kind: "api_error",
        client: "claude-code",
      },
    ]);
    expect(exporter.record).toHaveBeenCalledWith(call);
    expect(logLine({ ...call, isError: false, errorKind: undefined, clientName: undefined })).toBe(
      '{"event":"mcp_tool_call","tool":"get_trace","duration_ms":42,"is_error":false}',
    );
  });
});

describe("parseTelemetryConfig", () => {
  it("is off unless the endpoint is set", () => {
    expect(parseTelemetryConfig({})).toBeUndefined();
    expect(parseTelemetryConfig({ MCP_TELEMETRY_OTLP_HEADERS: "a=b" })).toBeUndefined();
    expect(parseTelemetryConfig({ MCP_TELEMETRY_OTLP_ENDPOINT: "  " })).toBeUndefined();
  });

  it("reads the endpoint, URL-decoded headers and a service name", () => {
    expect(
      parseTelemetryConfig({
        MCP_TELEMETRY_OTLP_ENDPOINT: "http://rest:8000/api/v1/public/traces",
        MCP_TELEMETRY_OTLP_HEADERS: "Authorization=Bearer%20tr-x, x-extra = 1",
      }),
    ).toEqual({
      endpoint: "http://rest:8000/api/v1/public/traces",
      headers: { Authorization: "Bearer tr-x", "x-extra": "1" },
      serviceName: "traceroot-mcp",
    });
    expect(
      parseTelemetryConfig({
        MCP_TELEMETRY_OTLP_ENDPOINT: "http://collector:4318/v1/traces",
        MCP_TELEMETRY_SERVICE_NAME: "mcp-staging",
      })?.serviceName,
    ).toBe("mcp-staging");
  });

  it("fails at startup on a malformed value without echoing a header", () => {
    expect(() => parseTelemetryConfig({ MCP_TELEMETRY_OTLP_ENDPOINT: "rest:8000" })).toThrow(
      /MCP_TELEMETRY_OTLP_ENDPOINT/,
    );
    try {
      parseTelemetryConfig({
        MCP_TELEMETRY_OTLP_ENDPOINT: "http://rest:8000/x",
        MCP_TELEMETRY_OTLP_HEADERS: "Bearer tr-secret-value",
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("MCP_TELEMETRY_OTLP_HEADERS");
      expect(String(error)).not.toContain("tr-secret-value");
    }
  });
});
