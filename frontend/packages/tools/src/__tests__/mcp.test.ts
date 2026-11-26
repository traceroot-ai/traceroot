import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client.js";
import { DEFAULT_MAX_RESULT_CHARS, narrowingHint, toMcpTool } from "../mcp.js";
import type { RegistryEntry, ToolAnnotations } from "../types.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function clientWith(fetchImpl: ReturnType<typeof fakeFetch>) {
  return new ApiClient({ baseUrl: "https://api.test", headers: {}, fetchImpl });
}

const annotations: ToolAnnotations = {
  title: "List traces",
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const listTraces: RegistryEntry = {
  name: "list_traces",
  description: "List traces.",
  method: "get",
  path: "/api/v1/public/traces",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project" },
      limit: { type: "integer", description: "Items per page", maximum: 9e18 },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  annotations,
};

const requestedUrl = (fetchImpl: ReturnType<typeof fakeFetch>) =>
  new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);

describe("toMcpTool", () => {
  it("drops hidden params from the schema and the required list", () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(200, {})),
      hiddenParams: ["project_id"],
    });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["limit"]);
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("strips oversized numeric bounds from the schema", () => {
    const tool = toMcpTool(listTraces, { client: clientWith(fakeFetch(200, {})) });
    expect(tool.inputSchema.properties.limit).not.toHaveProperty("maximum");
  });

  it("hides the entry's agentHiddenParams too", () => {
    const tool = toMcpTool(
      { ...listTraces, agentHiddenParams: ["limit"] },
      { client: clientWith(fakeFetch(200, {})) },
    );
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["project_id"]);
  });

  it("refuses a hidden param the caller sends anyway, without calling the API", async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      hiddenParams: ["project_id"],
    });
    const result = await tool.execute({ project_id: "other", limit: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('argument "project_id" is not accepted here');
    expect(result.report.errorKind).toBe("invalid_arguments");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("teaches on bad arguments as an isError result, naming the path and the shape", async () => {
    const fetchImpl = fakeFetch(200, {});
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      hiddenParams: ["project_id"],
    });
    const result = await tool.execute({ limit: "abc", limitt: 1 });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("Invalid arguments for list_traces:");
    expect(text).toContain('- limit: expected integer, got string "abc"');
    expect(text).toContain('- unknown argument "limitt" (did you mean "limit"?)');
    expect(text).toContain('list_traces takes one flat JSON object: {"limit": integer}');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unwraps arguments sent inside an arguments object and calls the API", async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      hiddenParams: ["project_id"],
    });
    const result = await tool.execute({ arguments: { limit: 4 } });
    expect(result.isError).toBeUndefined();
    expect(result.report.unwrappedFrom).toBe("arguments");
    expect(requestedUrl(fetchImpl).searchParams.get("limit")).toBe("4");
  });

  it("drops a hidden param a default supplies", async () => {
    const fetchImpl = fakeFetch(200, {});
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      hiddenParams: ["project_id"],
      defaults: () => ({ project_id: "other", limit: 10 }),
    });
    await tool.execute({});
    const url = requestedUrl(fetchImpl);
    expect(url.searchParams.has("project_id")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("applies defaults but lets the caller's value win", async () => {
    const fetchImpl = fakeFetch(200, {});
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      defaults: () => ({ limit: 10 }),
    });
    await tool.execute({ project_id: "p", limit: 5 });
    expect(requestedUrl(fetchImpl).searchParams.get("limit")).toBe("5");
    await tool.execute({ project_id: "p" });
    expect(
      new URL((fetchImpl.mock.calls[1] as unknown as [string])[0]).searchParams.get("limit"),
    ).toBe("10");
  });

  it("passes the entry's annotations through and titles the tool from them", () => {
    const tool = toMcpTool(listTraces, { client: clientWith(fakeFetch(200, {})) });
    expect(tool.annotations).toEqual(annotations);
    expect(tool.title).toBe("List traces");
  });

  it("refuses an entry without annotations", () => {
    const { annotations: _omitted, ...bare } = listTraces;
    expect(() => toMcpTool(bare, { client: clientWith(fakeFetch(200, {})) })).toThrow(
      "has no annotations",
    );
  });

  it("renders a result as JSON text, after transformResult", async () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(200, { a: 1, secret: 2 })),
      transformResult: (result) => ({ ...(result as object), secret: undefined }),
    });
    const result = await tool.execute({ project_id: "p" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1 });
  });

  it("renders an undefined result as JSON null text", async () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(200, {})),
      transformResult: () => undefined,
    });
    const result = await tool.execute({ project_id: "p" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("null");
  });

  it("returns an API failure as an isError result carrying the detail", async () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(401, { detail: "bad key" })),
    });
    const result = await tool.execute({ project_id: "p" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("API error 401");
    expect(result.content[0]!.text).toContain("bad key");
    expect(result.report).toMatchObject({ errorKind: "api_error", httpStatus: 401 });
    expect(result.structuredContent).toBeUndefined();
  });

  it("classifies a network failure and a timeout", async () => {
    const down = new ApiClient({
      baseUrl: "https://api.test",
      headers: {},
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const network = await toMcpTool(listTraces, { client: down }).execute({ project_id: "p" });
    expect(network.report.errorKind).toBe("network");
    const slow = new ApiClient({
      baseUrl: "https://api.test",
      headers: {},
      fetchImpl: (async () => {
        throw new DOMException("timed out", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    const timeout = await toMcpTool(listTraces, { client: slow }).execute({ project_id: "p" });
    expect(timeout.report.errorKind).toBe("timeout");
  });

  it("passes transformResult a notes object whose redaction count reaches the report", async () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(200, { a: 1 })),
      transformResult: (result, _args, notes) => {
        notes.redactions += 2;
        return result;
      },
    });
    const result = await tool.execute({ project_id: "p" });
    expect(result.report).toEqual({ resultChars: 7, truncated: false, redactions: 2 });
  });

  describe("paramDescriptions", () => {
    const entry: RegistryEntry = {
      ...listTraces,
      inputSchema: {
        ...listTraces.inputSchema,
        properties: {
          project_id: { type: "string", description: "Project" },
          trace_id: { type: "string" },
          limit: { type: "integer", description: "Items per page" },
        },
      },
    };
    const options = { client: clientWith(fakeFetch(200, {})), hiddenParams: ["project_id"] };

    it("describes a param the registry leaves bare", () => {
      const tool = toMcpTool(entry, {
        ...options,
        paramDescriptions: { trace_id: "Id of the trace, from list_traces." },
      });
      expect(tool.inputSchema.properties.trace_id).toEqual({
        type: "string",
        description: "Id of the trace, from list_traces.",
      });
    });

    it("never replaces a description the registry already has", () => {
      const tool = toMcpTool(entry, { ...options, paramDescriptions: { limit: "something else" } });
      expect(tool.inputSchema.properties.limit).toMatchObject({ description: "Items per page" });
    });
  });

  describe("the result text", () => {
    it("is compact JSON", async () => {
      const tool = toMcpTool(listTraces, {
        client: clientWith(fakeFetch(200, { data: [{ a: 1 }] })),
      });
      const { content } = await tool.execute({ project_id: "p" });
      expect(content[0]?.text).toBe('{"data":[{"a":1}]}');
    });

    it("comes with the same object as structuredContent", async () => {
      const tool = toMcpTool(listTraces, {
        client: clientWith(fakeFetch(200, { data: [{ a: 1 }] })),
      });
      const { content, structuredContent } = await tool.execute({ project_id: "p" });
      expect(structuredContent).toEqual(JSON.parse(content[0]!.text));
    });

    it("has no structuredContent when the result is not an object", async () => {
      const tool = toMcpTool(listTraces, { client: clientWith(fakeFetch(200, [1, 2])) });
      const result = await tool.execute({ project_id: "p" });
      expect(result.content[0]!.text).toBe("[1,2]");
      expect(result.structuredContent).toBeUndefined();
    });

    it("is shrunk to the limit as valid JSON, saying what went and how to ask for less", async () => {
      const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, text: "x".repeat(100) }));
      const tool = toMcpTool(listTraces, {
        client: clientWith(fakeFetch(200, { data: rows, next_cursor: "c2" })),
        hiddenParams: ["project_id"],
        maxResultChars: 1_500,
      });
      const { content, isError, structuredContent, report } = await tool.execute({});
      const text = content[0]?.text ?? "";
      expect(isError).toBeUndefined();
      expect(text.length).toBeLessThanOrEqual(1_500);
      const parsed = JSON.parse(text);
      expect(parsed.next_cursor).toBe("c2");
      expect(parsed._truncated.data).toBe(40 - parsed.data.length);
      expect(parsed._hint).toContain("over the 1500-character limit");
      expect(parsed._hint).toContain("a smaller limit");
      expect(structuredContent).toEqual(parsed);
      expect(report).toMatchObject({ truncated: true, resultChars: text.length });
    });

    it("is left alone under the limit", async () => {
      const tool = toMcpTool(listTraces, { client: clientWith(fakeFetch(200, { a: "short" })) });
      const { content, report } = await tool.execute({ project_id: "p" });
      expect(content[0]!.text).toBe('{"a":"short"}');
      expect(report.truncated).toBe(false);
      expect(DEFAULT_MAX_RESULT_CHARS).toBeGreaterThan(10_000);
    });
  });

  describe("narrowingHint", () => {
    const withParams = (...names: string[]) => ({
      type: "object" as const,
      properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
      required: [],
      additionalProperties: false as const,
    });

    it("names only the params the tool takes", () => {
      const hint = narrowingHint(
        withParams("limit", "start_after", "end_before", "cursor"),
        80_000,
      );
      expect(hint).toContain("a smaller limit, a shorter time window (start_after, end_before)");
      expect(hint).toContain("page through with cursor");
      expect(hint).not.toContain("fields");
    });

    it("falls back to a general instruction", () => {
      expect(narrowingHint(withParams("trace_id"), 100)).toContain(
        "Narrow the request and call again.",
      );
    });
  });
});
