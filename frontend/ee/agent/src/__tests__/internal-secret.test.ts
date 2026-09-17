import { afterEach, describe, expect, it, vi } from "vitest";

// Every internal call the agent makes must carry INTERNAL_API_SECRET_AGENT and
// nothing else: with only the platform secret set, the tools send no secret.
// This is what lets the agent secret be rotated alone and keeps a compromised
// agent from stamping traces as the platform.
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
  it("send the agent secret, never the platform one", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "platform");
    vi.stubEnv("INTERNAL_API_SECRET_AGENT", "agent");
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://rest.test");
    vi.stubEnv("TRACEROOT_UI_URL", "http://web.test");
    const { downloadOneTrace } = await import("../tools/download-traces.js");
    const { createCheckGitHubAccessTool } = await import("../tools/github-access.js");
    expect(await secretSentBy(() => download(downloadOneTrace))).toBe("agent");
    const tool = createCheckGitHubAccessTool("w1", "http://web.test");
    expect(
      await secretSentBy(() =>
        tool.execute("call-1", { repo: "o/r" }, undefined as never, undefined as never),
      ),
    ).toBe("agent");
  });

  it("send no secret at all when only the platform one is configured", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "platform");
    vi.stubEnv("INTERNAL_API_SECRET_AGENT", "");
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://rest.test");
    const { downloadOneTrace } = await import("../tools/download-traces.js");
    expect(await secretSentBy(() => download(downloadOneTrace))).toBe("");
  });
});

function download(fn: typeof import("../tools/download-traces.js").downloadOneTrace) {
  const executor = { writeFile: async () => {} } as never;
  return fn("t".repeat(32), "/workspace/traces", "p1", "u1", executor).catch(() => {});
}
