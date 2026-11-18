import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { PROBE_PATH } from "../credential-check.js";
import { REDACTED } from "../redaction.js";
import type { ToolCallRecord } from "../telemetry.js";

// What a connected assistant gets back from a call: errors that teach, results
// that parse, no credentials, and one telemetry record per call that carries
// nothing the call did.

type Backend = (url: URL) => { status: number; body: unknown };

function appWith(backend: Backend) {
  const records: ToolCallRecord[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const { status, body } = backend(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const app = createApp({
    backendUrl: "http://rest:8000",
    allowedHosts: ["localhost"],
    fetchImpl: fetchImpl as unknown as typeof fetch,
    recorder: { record: (call) => records.push(call) },
  });
  const toolCalls = () =>
    (fetchImpl.mock.calls as unknown as [string][]).filter(
      ([url]) => new URL(url).pathname !== PROBE_PATH,
    );
  return { app, records, toolCalls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(app: ReturnType<typeof createApp>, modern = false) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer tr-test-key", "User-Agent": "test-agent/1" } },
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost");
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client(
    { name: "quality-client", version: "9.9.9" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  clients.push(client);
  await client.connect(transport);
  return client;
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]!.text;

describe("argument errors", () => {
  it("name the bad path, the expected type and the accepted shape, as an isError result", async () => {
    const { app, toolCalls } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const result = await client.callTool({ name: "list_traces", arguments: { limit: "abc" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/^Invalid arguments for list_traces:/);
    expect(text).toContain('- limit: expected integer, got string "abc"');
    expect(text).toContain("list_traces takes one flat JSON object: {");
    expect(text).toContain('"limit": integer');
    expect(text).not.toContain("must NOT have additional properties");
    expect(toolCalls()).toHaveLength(0);
  });

  it("name an unknown key and the one probably meant", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const result = await client.callTool({ name: "list_traces", arguments: { limitt: 5 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('- unknown argument "limitt" (did you mean "limit"?)');
  });

  it("explain project_id instead of calling it unknown", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const result = await client.callTool({
      name: "list_traces",
      arguments: { project_id: "other" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('argument "project_id" is not accepted here');
  });

  it("are avoided for arguments wrapped in an arguments object: the call goes through", async () => {
    const { app, toolCalls, records } = appWith((url) => ({
      status: 200,
      body: { trace_id: url.pathname.split("/").pop(), spans: [] },
    }));
    const client = await connect(app);
    const result = await client.callTool({
      name: "get_trace",
      arguments: { arguments: { trace_id: "t-9" } },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ trace_id: "t-9", spans: [] });
    expect(new URL(toolCalls()[0]![0]).pathname).toBe("/api/v1/public/traces/t-9");
    expect(records[0]!.unwrappedArguments).toBe(true);
  });
});

describe("structuredContent", () => {
  for (const modern of [false, true]) {
    it(`carries the result object next to the text (${modern ? "2026-07-28" : "2025"} client)`, async () => {
      const { app } = appWith(() => ({ status: 200, body: { data: [{ trace_id: "t1" }] } }));
      const client = await connect(app, modern);
      const result = await client.callTool({ name: "list_traces", arguments: {} });
      expect(result.structuredContent).toEqual({ data: [{ trace_id: "t1" }] });
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    });
  }

  it("is absent on an error", async () => {
    const { app } = appWith(() => ({ status: 404, body: { detail: "Trace not found" } }));
    const client = await connect(app);
    const result = await client.callTool({ name: "get_trace", arguments: { trace_id: "nope" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("is not declared: tools advertise no outputSchema", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const { tools } = await client.listTools();
    expect(tools.filter((tool) => tool.outputSchema !== undefined)).toEqual([]);
  });
});

describe("credential redaction", () => {
  const trace = {
    trace_id: "t1",
    input: "call with sk-abcdefghijklmnopqrstuv",
    metadata: { env: "prod", api_key: "k-1" },
    spans: [
      {
        span_id: "s1",
        metadata: {
          "http.request.header.authorization": "Bearer abcdefghijkl",
          "llm.usage.prompt_tokens": 410,
          "llm.usage.total_tokens": 530,
        },
      },
    ],
  };

  it("applies to get_trace even with fields=full, keeping token counts", async () => {
    const { app, records } = appWith(() => ({ status: 200, body: trace }));
    const client = await connect(app);
    const result = await client.callTool({
      name: "get_trace",
      arguments: { trace_id: "t1", fields: "full" },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.input).toBe(`call with ${REDACTED}`);
    expect(parsed._redactedKeys).toEqual(["input"]);
    expect(parsed.metadata).toEqual({ env: "prod", api_key: REDACTED, _redactedKeys: ["api_key"] });
    expect(parsed.spans[0].metadata).toEqual({
      "http.request.header.authorization": REDACTED,
      "llm.usage.prompt_tokens": 410,
      "llm.usage.total_tokens": 530,
      _redactedKeys: ["http.request.header.authorization"],
    });
    expect(textOf(result)).not.toMatch(/sk-abc|k-1|abcdefghijkl/);
    expect(records[0]!.redactions).toBe(3);
  });

  it("applies to every tool, run_sql included", async () => {
    const { app } = appWith(() => ({
      status: 200,
      body: { columns: ["attributes"], rows: [['{"password":"hunter2","model":"m"}']] },
    }));
    const client = await connect(app);
    const result = await client.callTool({ name: "run_sql", arguments: { query: "SELECT 1" } });
    expect(textOf(result)).not.toContain("hunter2");
  });
});

describe("telemetry", () => {
  it("records one call with its outcome and sizes, and nothing it carried", async () => {
    const { app, records } = appWith(() => ({
      status: 200,
      body: { data: [{ trace_id: "result-value-xyz" }] },
    }));
    const client = await connect(app);
    const result = await client.callTool({
      name: "list_traces",
      arguments: { limit: 7, search_query: "argument-value-abc" },
    });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      tool: "list_traces",
      isError: false,
      resultChars: textOf(result).length,
      truncated: false,
      redactions: 0,
      unwrappedArguments: false,
    });
    expect(record!.durationMs).toBeGreaterThanOrEqual(0);
    // A 2025-era stateless call has no handshake on its request; the User-Agent stands in.
    expect(record!.clientName ?? record!.userAgent).toBeTruthy();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("argument-value-abc");
    expect(serialized).not.toContain("result-value-xyz");
    expect(serialized).not.toContain("tr-test-key");
  });

  it("names the client from its handshake on a 2026-07-28 call", async () => {
    const { app, records } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app, true);
    await client.callTool({ name: "list_traces", arguments: {} });
    expect(records[0]).toMatchObject({ clientName: "quality-client", clientVersion: "9.9.9" });
  });

  it("records an argument error with its kind", async () => {
    const { app, records } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    await client.callTool({ name: "list_traces", arguments: { limit: "secret-ish-value" } });
    expect(records[0]).toMatchObject({ isError: true, errorKind: "invalid_arguments" });
    expect(JSON.stringify(records[0])).not.toContain("secret-ish-value");
  });

  it("records an API error with its status", async () => {
    const { app, records } = appWith(() => ({ status: 404, body: { detail: "Trace not found" } }));
    const client = await connect(app);
    await client.callTool({ name: "get_trace", arguments: { trace_id: "missing" } });
    expect(records[0]).toMatchObject({ isError: true, errorKind: "api_error", httpStatus: 404 });
  });
});
