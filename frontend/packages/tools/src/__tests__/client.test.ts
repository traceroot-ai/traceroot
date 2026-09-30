import { describe, expect, it, vi } from "vitest";
import { ApiClient, bearerAuth } from "../client.js";
import type { RegistryEntry, ToolMethod, ToolPolicy } from "../types.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("ApiClient.request with a body", () => {
  it("replaces a caller-supplied Content-Type rather than sending both", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({
      baseUrl: "http://x",
      // Different casing from the one the client sets: as plain-object keys
      // these would both survive and fetch would join their values.
      headers: { ...bearerAuth("sk-test"), "Content-Type": "text/plain" },
      fetchImpl,
    });
    await client.request("post", "/api/v1/public/annotations", { body: { a: 1 } });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(new Headers(headers).get("content-type")).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("POSTs the JSON-serialized body with a content-type header", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: bearerAuth("sk-test"),
      fetchImpl,
    });
    const body = { text: "looks wrong", trace_id: "t1" };
    await client.request("post", "/api/v1/public/annotations", { body });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(init.body).toBe(JSON.stringify(body));
  });

  it("keeps GET requests byte-identical: no content-type added, no body key", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const configuredHeaders = bearerAuth("sk-test");
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: configuredHeaders,
      fetchImpl,
    });
    await client.request("get", "/api/v1/public/traces", { params: { fields: "core" } });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("fields")).toBe("core");
    expect(init.method).toBe("GET");
    expect(init).not.toHaveProperty("body");
    expect(init.headers).toBe(configuredHeaders);
    expect(init.headers).not.toHaveProperty("content-type");
  });

  it("sends a body-less POST exactly like today: no content-type, no body key", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const configuredHeaders = bearerAuth("sk-test");
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: configuredHeaders,
      fetchImpl,
    });
    await client.request("post", "/api/v1/public/annotations", {});
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init).not.toHaveProperty("body");
    expect(init.headers).toBe(configuredHeaders);
    expect(init.headers).not.toHaveProperty("content-type");
  });
});

describe("write-capable registry entry types", () => {
  it("accepts a POST entry with bodyParams and a policy where RegistryEntry is required", () => {
    const method: ToolMethod = "post";
    const policy: ToolPolicy = {
      approvalClass: "approval",
      minRole: "MEMBER",
      tenancy: "project",
    };
    const writeEntry: RegistryEntry = {
      name: "create_annotation",
      description: "Attach an annotation to a trace.",
      method,
      path: "/api/v1/public/annotations",
      inputSchema: {
        type: "object",
        properties: {
          trace_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["trace_id", "text"],
        additionalProperties: false,
      },
      bodyParams: ["trace_id", "text"],
      policy,
    };
    const entries: RegistryEntry[] = [writeEntry];
    expect(entries[0]!.method).toBe("post");
    expect(entries[0]!.bodyParams).toEqual(["trace_id", "text"]);
    expect(entries[0]!.policy?.approvalClass).toBe("approval");
  });
});

describe("ApiClient.request edit methods", () => {
  it("accepts patch and delete and uppercases them on the wire", async () => {
    for (const method of ["patch", "delete"] as const) {
      const fetchImpl = fakeFetch(200, { data: {} });
      const client = new ApiClient({
        baseUrl: "http://x",
        headers: bearerAuth("sk-test"),
        fetchImpl,
      });
      await client.request(method, "/api/v1/public/dashboards/d1", {});
      const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
      expect(init.method).toBe(method.toUpperCase());
      expect(init).not.toHaveProperty("body");
    }
  });

  it("serializes a PATCH body, keeping an explicit null field", async () => {
    const fetchImpl = fakeFetch(200, { data: {} });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const body = { description: null, name: "ops" };
    await client.request("patch", "/api/v1/public/dashboards/d1", { body });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"description":null,"name":"ops"}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("types patch and delete registry entries", () => {
    const patch: ToolMethod = "patch";
    const remove: ToolMethod = "delete";
    const entry: RegistryEntry = {
      name: "delete_dashboard",
      description: "Delete a dashboard.",
      method: remove,
      path: "/api/v1/public/dashboards/{dashboard_id}",
      inputSchema: {
        type: "object",
        properties: { dashboard_id: { type: "string" } },
        required: ["dashboard_id"],
        additionalProperties: false,
      },
      policy: { approvalClass: "approval", minRole: "MEMBER", tenancy: "project" },
    };
    expect([patch, entry.method]).toEqual(["patch", "delete"]);
  });
});
