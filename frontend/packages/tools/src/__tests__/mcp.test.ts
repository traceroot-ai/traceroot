import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client.js";
import { mcpAnnotations, toMcpTool } from "../mcp.js";
import type { RegistryEntry } from "../types.js";

function clientWith(status: number, body: unknown) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = new ApiClient({
    baseUrl: "http://api",
    headers: { Authorization: "Bearer tr-key" },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

const getTrace: RegistryEntry = {
  name: "get_trace",
  description: "Fetch one trace.",
  method: "get",
  path: "/api/v1/public/traces/{trace_id}",
  inputSchema: {
    type: "object",
    properties: {
      trace_id: { type: "string" },
      fields: { type: "string" },
      project_id: { type: "string" },
    },
    required: ["trace_id"],
    additionalProperties: false,
  },
  agentHiddenParams: ["project_id"],
};

const runSql: RegistryEntry = {
  name: "run_sql",
  description: "Run SQL.",
  method: "post",
  path: "/api/v1/public/sql",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  bodyParams: ["query"],
  policy: { approvalClass: "none", minRole: "VIEWER", tenancy: "project" },
};

const deleteAlert: RegistryEntry = {
  name: "delete_alert",
  description: "Delete an alert.",
  method: "delete",
  path: "/api/v1/public/alerts/{alert_id}",
  inputSchema: {
    type: "object",
    properties: { alert_id: { type: "string" } },
    required: ["alert_id"],
    additionalProperties: false,
  },
  policy: { approvalClass: "approval", minRole: "ADMIN", tenancy: "project" },
};

describe("mcpAnnotations", () => {
  it("marks a GET read-only and non-destructive", () => {
    expect(mcpAnnotations(getTrace)).toEqual({
      title: "Get trace",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("treats a query-only POST as a write unless the caller declares it a read", () => {
    expect(mcpAnnotations(runSql).readOnlyHint).toBe(false);
    expect(mcpAnnotations(runSql, { readOnly: true })).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("marks a DELETE destructive", () => {
    expect(mcpAnnotations(deleteAlert)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

describe("toMcpTool", () => {
  it("hides agentHiddenParams from the schema", () => {
    const { client } = clientWith(200, {});
    const tool = toMcpTool(getTrace, { client });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["trace_id", "fields"]);
    expect(tool.inputSchema.required).toEqual(["trace_id"]);
    expect(tool.name).toBe("get_trace");
    expect(tool.description).toBe("Fetch one trace.");
  });

  it("dispatches with the client's credential and returns the result as JSON text", async () => {
    const { client, fetchImpl } = clientWith(200, { trace_id: "t1" });
    const result = await toMcpTool(getTrace, { client }).execute({ trace_id: "t1" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ trace_id: "t1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api/api/v1/public/traces/t1");
    expect(init.headers).toEqual({ Authorization: "Bearer tr-key" });
  });

  it("drops a hidden param the caller sent anyway", async () => {
    const { client, fetchImpl } = clientWith(200, {});
    await toMcpTool(getTrace, { client }).execute({ trace_id: "t1", project_id: "other" });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).not.toContain("project_id");
  });

  it("lets a supplied value beat a default, and a default fill an omission", async () => {
    const { client, fetchImpl } = clientWith(200, {});
    const tool = toMcpTool(getTrace, { client, defaults: () => ({ fields: "skeleton" }) });
    await tool.execute({ trace_id: "t1" });
    await tool.execute({ trace_id: "t1", fields: "full" });
    const urls = fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls[0]).toContain("fields=skeleton");
    expect(urls[1]).toContain("fields=full");
  });

  it("treats an undefined supplied value as omitted", async () => {
    const { client, fetchImpl } = clientWith(200, {});
    const tool = toMcpTool(getTrace, { client, defaults: () => ({ fields: "skeleton" }) });
    await tool.execute({ trace_id: "t1", fields: undefined });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("fields=skeleton");
  });

  it("passes the result and the effective args to transformResult", async () => {
    const { client } = clientWith(200, { a: 1, secret: 2 });
    const tool = toMcpTool(getTrace, {
      client,
      defaults: () => ({ fields: "skeleton" }),
      transformResult: (result, args) => ({
        kept: (result as { a: number }).a,
        fields: args.fields,
      }),
    });
    const result = await tool.execute({ trace_id: "t1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ kept: 1, fields: "skeleton" });
  });

  it("returns an API failure as an isError result with the backend detail", async () => {
    const { client } = clientWith(403, { detail: "this operation requires a user login" });
    const result = await toMcpTool(getTrace, { client }).execute({ trace_id: "t1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Error calling get_trace: API error 403: this operation requires a user login",
    );
  });

  it("returns a missing path param as an isError result, not a rejection", async () => {
    const { client, fetchImpl } = clientWith(200, {});
    const result = await toMcpTool(getTrace, { client }).execute({});
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a throwing defaults callback as an isError result", async () => {
    const { client } = clientWith(200, {});
    const tool = toMcpTool(getTrace, {
      client,
      defaults: () => {
        throw new Error("boom");
      },
    });
    const result = await tool.execute({ trace_id: "t1" });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("boom");
  });

  it("annotates a declared read-only POST as a read", () => {
    const { client } = clientWith(200, {});
    expect(toMcpTool(runSql, { client, readOnly: true }).annotations.readOnlyHint).toBe(true);
  });
});
