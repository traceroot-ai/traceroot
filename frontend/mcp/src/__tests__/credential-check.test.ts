import { describe, expect, it, vi } from "vitest";
import { CredentialCheck, PROBE_PATH } from "../credential-check.js";

/** A check against a fake backend answering `status` (0 throws, like a refused connection). */
function checkWith(answer: (bearer: string) => { status: number; body?: unknown }) {
  let now = 1_000_000;
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, "");
    const { status, body } = answer(bearer);
    if (status === 0) throw new TypeError("fetch failed");
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  });
  const check = new CredentialCheck({
    backendUrl: "http://rest:8000",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ttlMs: 30_000,
    maxEntries: 3,
    now: () => now,
  });
  return {
    check,
    fetchImpl,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CredentialCheck", () => {
  it("asks the schema endpoint with the caller's bearer and no project", async () => {
    const { check, fetchImpl } = checkWith(() => ({ status: 200, body: {} }));
    expect(await check.check("tr-key")).toEqual({ status: "accepted" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://rest:8000${PROBE_PATH}`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tr-key");
  });

  it("reports a 401 as invalid with the backend's detail, or a fixed text", async () => {
    const { check } = checkWith((bearer) =>
      bearer === "with-detail"
        ? { status: 401, body: { detail: "Invalid API key" } }
        : { status: 401, body: { detail: {} } },
    );
    expect(await check.check("with-detail")).toEqual({
      status: "invalid",
      detail: "Invalid API key",
    });
    expect(await check.check("without")).toEqual({
      status: "invalid",
      detail: "The credential is invalid, expired or revoked",
    });
  });

  it.each([400, 403, 404])("accepts a credential the backend refuses with %i", async (status) => {
    const { check } = checkWith(() => ({ status, body: { detail: "x" } }));
    expect(await check.check("tok")).toEqual({ status: "accepted" });
  });

  it.each([0, 429, 500, 503])("has no verdict, and caches none, on %i", async (status) => {
    const { check, fetchImpl } = checkWith(() => ({ status }));
    expect(await check.check("tok")).toEqual({ status: "unknown" });
    expect(await check.check("tok")).toEqual({ status: "unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reuses an acceptance and a refusal until the TTL passes", async () => {
    let status = 200;
    const { check, fetchImpl, advance } = checkWith(() => ({ status }));
    expect((await check.check("tok")).status).toBe("accepted");
    status = 401;
    advance(29_000);
    expect((await check.check("tok")).status).toBe("accepted");
    advance(2_000);
    expect((await check.check("tok")).status).toBe("invalid");
    status = 200;
    advance(29_000);
    expect((await check.check("tok")).status).toBe("invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one probe between concurrent requests with one credential", async () => {
    const { check, fetchImpl } = checkWith(() => ({ status: 200 }));
    await Promise.all([check.check("tok"), check.check("tok"), check.check("tok")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("holds a bounded number of verdicts, dropping the oldest", async () => {
    const { check, fetchImpl } = checkWith(() => ({ status: 200 }));
    for (const bearer of ["a", "b", "c", "d"]) await check.check(bearer);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await check.check("d");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await check.check("a");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("turns an accepted credential invalid when a tool call is refused", async () => {
    const { check, fetchImpl } = checkWith(() => ({ status: 200 }));
    await check.check("tok");
    check.markInvalid("tok");
    expect((await check.check("tok")).status).toBe("invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never keeps the credential itself", async () => {
    const { check } = checkWith(() => ({ status: 401 }));
    const secret = "tr-very-secret-key";
    await check.check(secret);
    check.markInvalid("another-secret");
    const held = JSON.stringify([...(check as unknown as { cache: Map<string, unknown> }).cache]);
    expect(held).not.toContain(secret);
    expect(held).not.toContain("another-secret");
  });
});
