import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client.js";
import { toMcpTool } from "../mcp.js";
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

  it("drops a hidden param the caller sends anyway", async () => {
    const fetchImpl = fakeFetch(200, { ok: true });
    const tool = toMcpTool(listTraces, {
      client: clientWith(fetchImpl),
      hiddenParams: ["project_id"],
    });
    await tool.execute({ project_id: "other", limit: 3 });
    const url = requestedUrl(fetchImpl);
    expect(url.searchParams.has("project_id")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("3");
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

  it("returns an API failure as an isError result carrying the detail", async () => {
    const tool = toMcpTool(listTraces, {
      client: clientWith(fakeFetch(401, { detail: "bad key" })),
    });
    const result = await tool.execute({ project_id: "p" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("API error 401");
    expect(result.content[0]!.text).toContain("bad key");
  });
});
