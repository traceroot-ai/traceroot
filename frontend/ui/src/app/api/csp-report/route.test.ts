import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route keeps its log budget in module state, so each test loads a fresh copy.
async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

function reportRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", ...headers },
    body,
  });
}

const VIOLATION = {
  "csp-report": {
    "document-uri": "https://app.example.com/auth/github/callback?code=secret-oauth-code",
    "effective-directive": "script-src-elem",
    "violated-directive": "script-src-elem",
    "blocked-uri": "https://cdn.example.net/widget.js?key=abc",
    "source-file": "https://app.example.com/_next/static/chunks/app.js",
    "line-number": 12,
    disposition: "enforce",
    "script-sample": "user typed text",
  },
};

describe("POST /api/csp-report", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs the directive and URLs without query strings or the script sample", async () => {
    const { POST } = await loadRoute();
    const res = await POST(reportRequest(JSON.stringify(VIOLATION)));

    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const [tag, line] = warn.mock.calls[0] as [string, string];
    expect(tag).toBe("[csp-report]");
    expect(JSON.parse(line)).toEqual({
      directive: "script-src-elem",
      blocked: "https://cdn.example.net/widget.js",
      document: "https://app.example.com/auth/github/callback",
      source: "https://app.example.com/_next/static/chunks/app.js",
      line: 12,
      disposition: "enforce",
    });
    expect(line).not.toContain("secret-oauth-code");
    expect(line).not.toContain("user typed text");
  });

  it("ignores reports about scripts a browser extension injected", async () => {
    const { POST } = await loadRoute();
    const report = {
      "csp-report": {
        ...VIOLATION["csp-report"],
        "source-file": "chrome-extension://abcdef/inject.js",
      },
    };
    const res = await POST(reportRequest(JSON.stringify(report)));

    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a body over 16 KB, declared or streamed", async () => {
    const { POST } = await loadRoute();
    const big = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(17 * 1024) } });

    expect((await POST(reportRequest(big))).status).toBe(413);
    expect((await POST(reportRequest("{}", { "content-length": "999999" }))).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a CSP report", async () => {
    const { POST } = await loadRoute();

    expect((await POST(reportRequest("not json"))).status).toBe(400);
    expect((await POST(reportRequest(JSON.stringify({ other: 1 })))).status).toBe(400);
  });

  it("stops logging after 100 reports in a minute and starts again in the next", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
      const { POST } = await loadRoute();
      for (let i = 0; i < 101; i++) {
        expect((await POST(reportRequest(JSON.stringify(VIOLATION)))).status).toBe(204);
      }
      expect(warn).toHaveBeenCalledTimes(100);

      vi.setSystemTime(new Date("2026-10-10T00:01:00Z"));
      await POST(reportRequest(JSON.stringify(VIOLATION)));
      expect(warn).toHaveBeenCalledTimes(101);
    } finally {
      vi.useRealTimers();
    }
  });
});
