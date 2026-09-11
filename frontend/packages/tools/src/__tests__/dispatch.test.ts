import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, bearerAuth, internalAuth } from "../client.js";
import { dispatch, fillPath } from "../dispatch.js";
import type { RegistryEntry } from "../types.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "get_trace",
    description: "Fetch one trace.",
    method: "get",
    path: "/api/v1/public/traces/{trace_id}",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: { type: "string" },
        fields: { type: "string" },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

describe("fillPath", () => {
  it("substitutes and URI-encodes path params", () => {
    expect(fillPath("/api/v1/public/traces/{trace_id}", { trace_id: "a/b c" })).toBe(
      "/api/v1/public/traces/a%2Fb%20c",
    );
  });

  it("throws when a path param is missing", () => {
    expect(() => fillPath("/api/v1/public/traces/{trace_id}", {})).toThrow(
      /path parameter "trace_id"/,
    );
  });

  it("throws when a path param is an empty string", () => {
    // `/traces/` would slash-redirect to the list route and return the wrong
    // resource, so an empty segment must fail loudly instead.
    expect(() => fillPath("/api/v1/public/traces/{trace_id}", { trace_id: "" })).toThrow(
      /path parameter "trace_id"/,
    );
  });
});

describe("dispatch", () => {
  it("routes schema params to the query string and ignores unknown args", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    await dispatch(makeEntry(), { trace_id: "t1", fields: "full", bogus: "nope" }, client);
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/public/traces/t1");
    expect(parsed.searchParams.get("fields")).toBe("full");
    expect(parsed.searchParams.has("bogus")).toBe(false);
    expect(parsed.searchParams.has("trace_id")).toBe(false);
  });

  it("honors pathOverride with extra path params supplied as args", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    await dispatch(makeEntry(), { trace_id: "t1", project_id: "p9", fields: "core" }, client, {
      pathOverride: "/api/v1/projects/{project_id}/traces/{trace_id}",
    });
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/projects/p9/traces/t1");
    expect(parsed.searchParams.get("fields")).toBe("core");
    expect(parsed.searchParams.has("project_id")).toBe(false);
  });

  it("JSON-serializes non-scalar args into the query string", async () => {
    const fetchImpl = fakeFetch(200, { data: [] });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const listEntry: RegistryEntry = {
      name: "list_traces",
      description: "List traces.",
      method: "get",
      path: "/api/v1/public/traces",
      inputSchema: {
        type: "object",
        properties: { filters: { type: "array" }, limit: { type: "integer" } },
        required: [],
        additionalProperties: false,
      },
    };
    const filters = [{ field: "model_name", op: "in", value: ["gpt-4o"] }];
    await dispatch(listEntry, { filters, limit: 5 }, client);
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(JSON.parse(parsed.searchParams.get("filters")!)).toEqual(filters);
    expect(parsed.searchParams.get("limit")).toBe("5");
  });

  it("forwards the caller's abort signal to fetch", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const controller = new AbortController();
    await dispatch(makeEntry(), { trace_id: "t1" }, client, { signal: controller.signal });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the parsed response body", async () => {
    const fetchImpl = fakeFetch(200, { data: { trace_id: "t1" } });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const result = await dispatch(makeEntry(), { trace_id: "t1" }, client);
    expect(result).toEqual({ data: { trace_id: "t1" } });
  });

  it("throws ApiError carrying the backend detail on non-2xx responses", async () => {
    const fetchImpl = fakeFetch(404, { detail: "Trace not found" });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const promise = dispatch(makeEntry(), { trace_id: "t1" }, client);
    await expect(promise).rejects.toThrow(ApiError);
    await expect(dispatch(makeEntry(), { trace_id: "t1" }, client)).rejects.toMatchObject({
      status: 404,
      detail: "Trace not found",
    });
  });
});

describe("dispatch body routing", () => {
  function makeWriteEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
      name: "create_detector",
      description: "Create a detector.",
      method: "post",
      path: "/api/v1/public/projects/{project_id}/detectors",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          dry_run: { type: "boolean" },
          name: { type: "string" },
          template: { type: "object" },
        },
        required: ["project_id", "name"],
        additionalProperties: false,
      },
      bodyParams: ["name", "template"],
      policy: { approvalClass: "approval", minRole: "MEMBER", tenancy: "project" },
      ...overrides,
    };
  }

  it("routes bodyParams into the JSON body and keeps them out of the query string", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const requestSpy = vi.spyOn(client, "request");
    await dispatch(
      makeWriteEntry(),
      { project_id: "p1", dry_run: true, name: "latency", template: { kind: "llm" } },
      client,
    );
    const [method, path, opts] = requestSpy.mock.calls[0]!;
    expect(method).toBe("post");
    expect(path).toBe("/api/v1/public/projects/p1/detectors");
    expect(opts!.body).toEqual({ name: "latency", template: { kind: "llm" } });
    expect(opts!.params).toEqual({ dry_run: "true" });
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.has("name")).toBe(false);
    expect(parsed.searchParams.has("template")).toBe(false);
  });

  it("omits body params absent from args instead of sending undefined values", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const requestSpy = vi.spyOn(client, "request");
    await dispatch(makeWriteEntry(), { project_id: "p1", name: "latency" }, client);
    const [, , opts] = requestSpy.mock.calls[0]!;
    expect(opts!.body).toStrictEqual({ name: "latency" });
    expect("template" in (opts!.body as Record<string, unknown>)).toBe(false);
  });

  it("keeps GET dispatch byte-identical: same params, no body key", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const requestSpy = vi.spyOn(client, "request");
    await dispatch(makeEntry(), { trace_id: "t1", fields: "full" }, client);
    const [method, path, opts] = requestSpy.mock.calls[0]!;
    expect(method).toBe("get");
    expect(path).toBe("/api/v1/public/traces/t1");
    expect(opts).toStrictEqual({ params: { fields: "full" }, signal: undefined });
    expect("body" in opts!).toBe(false);
  });

  it("sends no body for a post entry without body params", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const requestSpy = vi.spyOn(client, "request");
    await dispatch(
      makeWriteEntry({
        bodyParams: [],
        inputSchema: {
          type: "object",
          properties: { project_id: { type: "string" }, dry_run: { type: "boolean" } },
          required: ["project_id"],
          additionalProperties: false,
        },
      }),
      { project_id: "p1", dry_run: false },
      client,
    );
    const [, , opts] = requestSpy.mock.calls[0]!;
    expect("body" in opts!).toBe(false);
    expect(opts!.params).toEqual({ dry_run: "false" });
  });

  it("passes object and array body values through unstringified", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const requestSpy = vi.spyOn(client, "request");
    const template = { kind: "llm", thresholds: [0.5, 0.9] };
    const rules = [{ field: "model_name", op: "eq", value: "gpt" }];
    await dispatch(
      makeWriteEntry({
        bodyParams: ["name", "template", "rules"],
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            name: { type: "string" },
            template: { type: "object" },
            rules: { type: "array" },
          },
          required: ["project_id", "name"],
          additionalProperties: false,
        },
      }),
      { project_id: "p1", name: "latency", template, rules },
      client,
    );
    const [, , opts] = requestSpy.mock.calls[0]!;
    const body = opts!.body as Record<string, unknown>;
    expect(body.template).toBe(template);
    expect(body.rules).toBe(rules);
  });
});

describe("ApiClient", () => {
  it("sends the configured headers", async () => {
    const fetchImpl = fakeFetch(200, {});
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: bearerAuth("sk-test"),
      fetchImpl,
      timeoutMs: 5_000,
    });
    await client.request("get", "/api/v1/public/whoami", {});
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the raw body when the error payload is not JSON detail", async () => {
    const fetchImpl = vi.fn(async () => new Response("gateway timeout", { status: 504 }));
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    await expect(client.request("get", "/whoami", {})).rejects.toMatchObject({
      status: 504,
      detail: "gateway timeout",
    });
  });
});

describe("auth header helpers", () => {
  it("builds bearer and internal auth headers", () => {
    expect(bearerAuth("sk-1")).toEqual({ Authorization: "Bearer sk-1" });
    expect(internalAuth("secret", "u1")).toEqual({
      "X-Internal-Secret": "secret",
      "x-user-id": "u1",
    });
  });
});
