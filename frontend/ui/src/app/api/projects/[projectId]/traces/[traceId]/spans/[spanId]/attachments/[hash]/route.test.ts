import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
}));

import { GET, dynamic } from "./route";

const HASH = "ab".repeat(32);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Ids = { projectId: string; traceId: string; spanId: string; hash: string };

function call(ids: Partial<Ids> = {}, cookie: string | null = "better-auth.session_token=signed") {
  const params: Ids = { projectId: "p", traceId: "t", spanId: "s", hash: HASH, ...ids };
  const request = new NextRequest(
    `http://localhost/api/projects/p/traces/t/spans/s/attachments/${params.hash}`,
    { headers: cookie === null ? {} : { cookie } },
  );
  return { request, response: GET(request, { params: Promise.resolve(params) }) };
}

function image(type = "image/png", length: string | null = String(PNG.length)) {
  const headers: Record<string, string> = { "content-type": type };
  if (length) headers["content-length"] = length;
  return new Response(PNG, { headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockReset().mockResolvedValue({});
  fetchMock = vi.fn(async () => image());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET .../spans/[spanId]/attachments/[hash]", () => {
  it("forwards the signed browser cookie and streams the image back", async () => {
    const { request, response } = call();
    const res = await response;

    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:8000/api/v1/projects/p/traces/t/spans/s/attachments/${HASH}`,
      {
        headers: { cookie: "better-auth.session_token=signed", "accept-encoding": "identity" },
        signal: request.signal,
        cache: "no-store",
      },
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is never cached", async () => {
    expect(dynamic).toBe("force-dynamic");
    const res = await call().response;
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("encodes the ids into the backend path", async () => {
    await call({ projectId: "p 1", traceId: "t/1", spanId: "s?1" }).response;
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://localhost:8000/api/v1/projects/p%201/traces/t%2F1/spans/s%3F1/attachments/${HASH}`,
    );
  });

  it("sends an empty cookie when the request has none", async () => {
    await call({}, null).response;
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe("");
  });

  it("leaves Content-Length out when the backend sends none", async () => {
    fetchMock.mockResolvedValue(image("image/webp", null));
    const res = await call().response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBeNull();
  });

  it.each([
    ["uppercase", HASH.toUpperCase()],
    ["too short", HASH.slice(1)],
    ["too long", `${HASH}0`],
    ["not hex", "g".repeat(64)],
    ["a dot segment", ".."],
  ])("rejects a malformed hash (%s) without calling the backend", async (_name, hash) => {
    const res = await call({ hash }).response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid attachment hash" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["trace", { traceId: "." }],
    ["trace", { traceId: ".." }],
    ["span", { spanId: "." }],
    ["span", { spanId: ".." }],
  ])("rejects a dot-segment %s id", async (_name, ids) => {
    const res = await call(ids).response;
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the auth error before checking project access", async () => {
    const authError = new Response(null, { status: 401 });
    requireAuthMock.mockResolvedValue({ error: authError });

    const res = await call().response;

    expect(res).toBe(authError);
    expect(requireProjectAccessMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the access error and never calls the backend", async () => {
    const accessError = new Response(null, { status: 403 });
    requireProjectAccessMock.mockResolvedValue({ error: accessError });

    const res = await call().response;

    expect(res).toBe(accessError);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "p");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])("passes a backend %i through without its body", async (status) => {
    const upstream = Response.json({ detail: "Attachment not found" }, { status });
    fetchMock.mockResolvedValue(upstream);

    const res = await call().response;

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: "Attachment unavailable" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // Released, not left holding the backend connection.
    expect(upstream.bodyUsed).toBe(true);
  });

  it("refuses a response that is not an allowed image type", async () => {
    fetchMock.mockResolvedValue(
      new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }),
    );

    const res = await call().response;

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).not.toBe("text/html");
    expect(await res.text()).not.toContain("script");
  });

  it("refuses a success with no body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await call().response;
    expect(res.status).toBe(502);
  });

  it("returns 502 when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call().response;

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to reach backend" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
