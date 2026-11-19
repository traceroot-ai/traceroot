import { afterEach, describe, expect, it, vi } from "vitest";

// Every internal call the agent makes carries INTERNAL_API_SECRET — the one
// internal credential, shared with the worker and the Next.js server. What a
// trace is stored as is decided by the ingest path the agent posts to, not by
// which secret authenticated (design: decision 2).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function secretSentBy(run: () => Promise<unknown>): Promise<string | null> {
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchImpl);
  await run();
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  const headers = new Headers(init?.headers);
  return headers.get("X-Internal-Secret");
}

describe("the agent's internal calls", () => {
  it("send the internal secret", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret");
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://rest.test");
    vi.stubEnv("TRACEROOT_UI_URL", "http://web.test");
    const { downloadOneTrace } = await import("../tools/download-traces.js");
    const { createCheckGitHubAccessTool } = await import("../tools/github-access.js");
    expect(await secretSentBy(() => download(downloadOneTrace))).toBe("s3cret");
    const tool = createCheckGitHubAccessTool("w1", "http://web.test");
    expect(
      await secretSentBy(() =>
        tool.execute("call-1", { repo: "o/r" }, undefined as never, undefined as never),
      ),
    ).toBe("s3cret");
  });

  it("send an empty header rather than a stale value when none is configured", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://rest.test");
    const { downloadOneTrace } = await import("../tools/download-traces.js");
    expect(await secretSentBy(() => download(downloadOneTrace))).toBe("");
  });
});

function download(fn: typeof import("../tools/download-traces.js").downloadOneTrace) {
  const executor = { writeFile: async () => {} } as never;
  return fn("t".repeat(32), "/workspace/traces", "p1", "u1", executor).catch(() => {});
}
