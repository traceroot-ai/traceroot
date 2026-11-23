import { beforeEach, describe, expect, it, vi } from "vitest";

const { WebClient } = vi.hoisted(() => ({
  WebClient: vi.fn(function (this: unknown, _token: string, _options: unknown) {}),
}));

vi.mock("@slack/web-api", () => ({ WebClient }));
// The installer is built from Slack env vars at import; nothing here needs it.
vi.mock("../installer.ts", () => ({ installer: {} }));

const { createSlackClient } = await import("../client.ts");

beforeEach(() => {
  WebClient.mockClear();
});

describe("createSlackClient", () => {
  it("rides out an outage by default, and waits out a rate limit rather than rejecting it", () => {
    createSlackClient("xoxb-token");

    expect(WebClient).toHaveBeenCalledWith("xoxb-token", {
      retryConfig: { retries: 3, maxRetryTime: 90_000 },
    });
  });

  it("holds a bounded caller to its bound, and rejects a rate-limited call at once", () => {
    createSlackClient("xoxb-token", { timeoutMs: 3_000, retries: 0 });

    // Without the flag a 429 sleeps for its Retry-After before throwing, which the
    // timeout does not cover.
    expect(WebClient).toHaveBeenCalledWith("xoxb-token", {
      timeout: 3_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  });
});
