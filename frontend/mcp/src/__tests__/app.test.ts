import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, parseAllowedHosts, parseListenPort } from "../app.js";
import { PROBE_PATH } from "../credential-check.js";
import { EXPOSED_TOOLS } from "../exposure.js";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { parseMaxResultChars } from "../server.js";

type Backend = (url: URL, init: RequestInit) => { status: number; body: unknown };

/** The app wired to a fake backend; returns the app and the backend's call log. */
function appWith(backend: Backend, options: { maxResultChars?: number } = {}) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const { status, body } = backend(new URL(String(input)), init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const app = createApp({
    backendUrl: "http://rest:8000",
    allowedHosts: ["localhost"],
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...options,
  });
  return { app, fetchImpl };
}

/** The backend calls tools made, without the credential probes ahead of them. */
function toolCalls(fetchImpl: ReturnType<typeof appWith>["fetchImpl"]) {
  return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(
    ([url]) => new URL(url).pathname !== PROBE_PATH,
  );
}

/** A Request as the node server builds it, with the Host header a real socket carries. */
function request(url: string | URL, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);
  return new Request(url, { ...init, headers });
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  app: ReturnType<typeof createApp>,
  key = "tr-test-key",
  options: { modern?: boolean; wire?: string[] } = {},
) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: async (url, init) => {
      const response = await app.fetch(request(url, init));
      if (options.wire) {
        options.wire.push(await response.clone().text());
      }
      return response;
    },
  });
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    options.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe("MCP app", () => {
  it("answers the health probe", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const response = await app.fetch(request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses a request without a bearer credential", async () => {
    const { app, fetchImpl } = appWith(() => ({ status: 200, body: {} }));
    const response = await app.fetch(
      request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells a connecting client what the server is and how to use it", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("refuses a Host it is not configured for", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const response = await app.fetch(
      request("http://evil.example/mcp", {
        method: "POST",
        headers: { authorization: "Bearer tr-x", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lists the exposed tools with their annotations and hides project_id", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPOSED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.annotations?.title).toBeTruthy();
    }
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("project_id");
    }
  });

  it("calls get_trace end to end with the caller's key and withholds content", async () => {
    const { app, fetchImpl } = appWith((url) => ({
      status: 200,
      body: {
        trace_id: url.pathname.split("/").pop(),
        input: "secret prompt",
        output: "secret answer",
        metadata: { user: "u" },
        git_repo: "org/repo",
        spans: [{ span_id: "s1", git_source_file: "app.py", git_source_line: 12 }],
      },
    }));
    const client = await connect(app, "tr-abc");
    const result = await client.callTool({ name: "get_trace", arguments: { trace_id: "t-1" } });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    const payload = JSON.parse(content[0].text);
    expect(payload).toEqual({
      trace_id: "t-1",
      git_repo: "org/repo",
      spans: [{ span_id: "s1", git_source_file: "app.py", git_source_line: 12 }],
    });

    const [url, init] = toolCalls(fetchImpl)[0];
    expect(url).toBe("http://rest:8000/api/v1/public/traces/t-1?fields=skeleton");
    expect(init.headers).toEqual({ Authorization: "Bearer tr-abc" });
  });

  it("returns the trace content when asked for it", async () => {
    const { app } = appWith(() => ({ status: 200, body: { trace_id: "t", input: "x" } }));
    const client = await connect(app);
    const result = await client.callTool({
      name: "get_trace",
      arguments: { trace_id: "t", fields: "full" },
    });
    const content = result.content as { text: string }[];
    expect(JSON.parse(content[0].text)).toEqual({ trace_id: "t", input: "x" });
  });

  it("sends run_sql as a JSON body", async () => {
    const { app, fetchImpl } = appWith(() => ({ status: 200, body: { rows: [[1]] } }));
    const client = await connect(app);
    const result = await client.callTool({ name: "run_sql", arguments: { query: "SELECT 1" } });
    expect(result.isError).toBeFalsy();
    const [url, init] = toolCalls(fetchImpl)[0];
    expect(new URL(url).pathname).toBe("/api/v1/public/sql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "SELECT 1" });
  });

  it("serves a 2025-era client on the same endpoint", async () => {
    const { app, fetchImpl } = appWith(() => ({ status: 200, body: { traces: [] } }));
    const response = await app.fetch(
      request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer tr-legacy",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_traces", arguments: {} },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('{\\"traces\\":[]}');
    const [, init] = toolCalls(fetchImpl)[0];
    expect(init.headers).toEqual({ Authorization: "Bearer tr-legacy" });
  });

  it("answers a key the backend refuses with 401 invalid_token before the SDK", async () => {
    const { app, fetchImpl } = appWith(() => ({
      status: 401,
      body: { detail: "Invalid API key" },
    }));
    const response = await app.fetch(
      request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer tr-wrong",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", error_description="Invalid API key"',
    );
    expect(await response.json()).toEqual({ error: "Invalid API key" });
    expect(toolCalls(fetchImpl)).toHaveLength(0);
  });

  it("answers the request after a tool call's 401 with 401", async () => {
    let revoked = false;
    const { app } = appWith((url) =>
      url.pathname === PROBE_PATH || !revoked
        ? { status: 200, body: { traces: [] } }
        : { status: 401, body: { detail: "Invalid token" } },
    );
    const client = await connect(app, "tr-revoked-later");
    revoked = true;
    // The status of this exchange is committed before the tool runs, so the
    // refusal arrives as a tool error...
    const result = await client.callTool({ name: "list_traces", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("API error 401");
    // ...and the next request, within the cache window, gets the 401.
    const next = await app.fetch(
      request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer tr-revoked-later",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    expect(next.status).toBe(401);
    expect(next.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("serves a 2026-07-28 client with resultType, ttlMs and cacheScope from the handler", async () => {
    const { app } = appWith(() => ({ status: 200, body: { traces: [] } }));
    const wire: string[] = [];
    const client = await connect(app, "tr-modern", { modern: true, wire });
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(EXPOSED_TOOLS.length);
    expect(listed).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    await client.callTool({ name: "list_traces", arguments: {} });

    const replies = wire.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
    const discover = replies.find((reply) => reply.result?.supportedVersions);
    expect(discover.result).toMatchObject({
      supportedVersions: ["2026-07-28"],
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
    });
    const call = replies.find((reply) => reply.result?.content);
    expect(call.result.resultType).toBe("complete");
  });

  it("tells the model what get_trace withholds", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const client = await connect(app);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_trace")?.description).toContain(
      "fields=skeleton",
    );
  });

  it("returns the backend's 400 for a bearer that is not a TraceRoot key as a tool error", async () => {
    const { app } = appWith(() => ({
      status: 400,
      body: { detail: "project_id query parameter is required" },
    }));
    const client = await connect(app, "not-a-traceroot-key");
    expect((await client.listTools()).tools).toHaveLength(EXPOSED_TOOLS.length);
    const result = await client.callTool({ name: "list_traces", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as { text: string }[];
    expect(content[0].text).toContain("API error 400");
    expect(content[0].text).toContain("project_id");
  });

  it.each([
    ["no header", undefined],
    ["an empty bearer", "Bearer "],
    ["a bare scheme", "Bearer"],
    ["another scheme", "Basic dHI6eA=="],
    ["a bare token", "tr-abc"],
  ])("refuses %s without reaching the backend", async (_name, authorization) => {
    const { app, fetchImpl } = appWith(() => ({ status: 200, body: {} }));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization !== undefined) {
      headers.authorization = authorization;
    }
    for (const method of ["POST", "GET"]) {
      const response = await app.fetch(
        request("http://localhost/mcp", {
          method,
          headers,
          body:
            method === "POST"
              ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
              : undefined,
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves a Host header that carries a port, and still refuses a foreign one", async () => {
    const { app } = appWith(() => ({ status: 200, body: {} }));
    const call = (host: string) =>
      app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            host,
            authorization: "Bearer tr-x",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    expect((await call("localhost:8200")).status).toBe(200);
    expect((await call("evil.example:8200")).status).toBe(403);
  });

  it("refuses an unauthenticated request through a real listener", async () => {
    const fetchImpl = vi.fn();
    const app = createApp({
      backendUrl: "http://rest:8000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/mcp`;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const headers = { "content-type": "application/json", accept: "application/json" };
      const refused = await fetch(url, { method: "POST", headers, body });
      expect(refused.status).toBe(401);
      const wrong = await fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: "Basic eDp5" },
        body,
      });
      expect(wrong.status).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("tool result size", () => {
  it("cuts a long result at the configured length and says how to narrow it", async () => {
    const { app } = appWith(() => ({ status: 200, body: { traces: ["x".repeat(500)] } }), {
      maxResultChars: 100,
    });
    const client = await connect(app);
    const result = await client.callTool({ name: "list_traces", arguments: {} });
    const text = (result.content as { text: string }[])[0].text;
    expect(text.startsWith('{"traces":["' + "x".repeat(88))).toBe(true);
    expect(text).toContain("[Result truncated");
    expect(text).toContain("the limit is 100");
    expect(text).toContain("Narrow the request");
  });

  it("reads MCP_MAX_RESULT_CHARS as a positive integer, unset keeping the default", () => {
    expect(parseMaxResultChars(undefined)).toBeUndefined();
    expect(parseMaxResultChars(" ")).toBeUndefined();
    expect(parseMaxResultChars("150000")).toBe(150_000);
    for (const raw of ["0", "-5", "1.5", "lots"]) {
      expect(() => parseMaxResultChars(raw)).toThrow(/MCP_MAX_RESULT_CHARS/);
    }
  });
});

describe("parseAllowedHosts", () => {
  it("trims entries and drops blanks", () => {
    expect(parseAllowedHosts(" a.example , ,b.example,")).toEqual(["a.example", "b.example"]);
  });

  it("treats unset, empty and all-blank values as no restriction", () => {
    for (const raw of [undefined, "", " , ,"]) {
      expect(parseAllowedHosts(raw)).toBeUndefined();
    }
  });
});

describe("parseListenPort", () => {
  it("reads the URL's port", () => {
    expect(parseListenPort("http://localhost:8200")).toBe(8200);
    expect(parseListenPort("http://mcp:9000/mcp")).toBe(9000);
  });

  it("keeps an explicit default port", () => {
    expect(parseListenPort("http://0.0.0.0:80")).toBe(80);
    expect(parseListenPort("https://user:pw@mcp.example:443/mcp")).toBe(443);
    expect(parseListenPort("http://[::1]:80")).toBe(80);
  });

  it("falls back to 8200 when the URL names no port", () => {
    expect(parseListenPort("http://mcp")).toBe(8200);
    expect(parseListenPort("https://user:pw@mcp.example/a:1")).toBe(8200);
    expect(parseListenPort("http://[::1]")).toBe(8200);
  });
});
