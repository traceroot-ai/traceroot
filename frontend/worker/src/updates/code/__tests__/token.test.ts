import { describe, expect, it, vi } from "vitest";
import { internalTokenProvider } from "../token.js";

describe("internalTokenProvider", () => {
  it("asks the internal route for the repository, with the secret and the workspace, and nothing else", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" })),
    );
    const token = await internalTokenProvider({
      appBaseUrl: "http://app",
      internalSecret: "s3cret",
      fetchImpl,
    })("acme/app", "w1");
    expect(token).toBe("ghs_abc");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("http://app/api/github/token?repo=acme%2Fapp");
    expect(init.headers).toEqual({ "X-Internal-Secret": "s3cret", "x-workspace-id": "w1" });
  });

  it("fails without leaking anything when the route refuses", async () => {
    const provider = internalTokenProvider({
      appBaseUrl: "http://app",
      internalSecret: "s3cret",
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    await expect(provider("acme/app", "w1")).rejects.toThrow("answered 404");
  });

  it("fails when the answer has no token", async () => {
    const provider = internalTokenProvider({
      appBaseUrl: "http://app",
      internalSecret: "s",
      fetchImpl: async () => new Response(JSON.stringify({})),
    });
    await expect(provider("acme/app", "w1")).rejects.toThrow("no token");
  });
});
