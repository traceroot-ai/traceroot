import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route and its rate limiter keep their budgets in module state, so each
// test loads fresh copies.
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

// The same violation as report-to sends it: a batch of reports, each with its
// fields in camelCase under body.
const REPORT_TO_VIOLATION = {
  type: "csp-violation",
  age: 10,
  url: "https://app.example.com/auth/github/callback?code=secret-oauth-code",
  user_agent: "Mozilla/5.0",
  body: {
    documentURL: "https://app.example.com/auth/github/callback?code=secret-oauth-code",
    effectiveDirective: "script-src-elem",
    blockedURL: "https://cdn.example.net/widget.js?key=abc",
    sourceFile: "https://app.example.com/_next/static/chunks/app.js",
    lineNumber: 12,
    columnNumber: 3,
    disposition: "enforce",
    sample: "user typed text",
    statusCode: 200,
  },
};
const REPORT_TO = { "content-type": "application/reports+json" };

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

  it("logs each violation in a report-to batch the same way, skipping other report types", async () => {
    const { POST } = await loadRoute();
    const batch = [
      REPORT_TO_VIOLATION,
      { type: "deprecation", url: "https://app.example.com/", body: { id: "x" } },
      {
        ...REPORT_TO_VIOLATION,
        body: { ...REPORT_TO_VIOLATION.body, sourceFile: "chrome-extension://abcdef/inject.js" },
      },
      {
        ...REPORT_TO_VIOLATION,
        body: { ...REPORT_TO_VIOLATION.body, effectiveDirective: "script-src", blockedURL: "eval" },
      },
    ];
    const res = await POST(reportRequest(JSON.stringify(batch), REPORT_TO));

    expect(res.status).toBe(204);
    const logged = warn.mock.calls.map((call: unknown[]) => JSON.parse(String(call[1])));
    expect(logged).toEqual([
      {
        directive: "script-src-elem",
        blocked: "https://cdn.example.net/widget.js",
        document: "https://app.example.com/auth/github/callback",
        source: "https://app.example.com/_next/static/chunks/app.js",
        line: 12,
        disposition: "enforce",
      },
      expect.objectContaining({ directive: "script-src", blocked: "eval" }),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-oauth-code");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("user typed text");
  });

  it("counts every report in a batch against the client's budget", async () => {
    const { POST } = await loadRoute();
    const batch = Array.from({ length: 25 }, () => REPORT_TO_VIOLATION);

    expect((await POST(reportRequest(JSON.stringify(batch), REPORT_TO))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(20);
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
    expect((await POST(reportRequest("null"))).status).toBe(400);
    expect((await POST(reportRequest(JSON.stringify({ other: 1 })))).status).toBe(400);
  });

  it("gives each client its own budget, so one sender cannot hide another's reports", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
      const { POST } = await loadRoute();
      const flooder = { "x-forwarded-for": "203.0.113.7" };
      for (let i = 0; i < 25; i++) {
        expect((await POST(reportRequest(JSON.stringify(VIOLATION), flooder))).status).toBe(204);
      }
      expect(warn).toHaveBeenCalledTimes(20);

      await POST(reportRequest(JSON.stringify(VIOLATION), { "x-forwarded-for": "198.51.100.9" }));
      expect(warn).toHaveBeenCalledTimes(21);

      vi.setSystemTime(new Date("2026-10-10T00:01:00Z"));
      await POST(reportRequest(JSON.stringify(VIOLATION), flooder));
      expect(warn).toHaveBeenCalledTimes(22);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs at most 300 reports a minute across all clients", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
      const { POST } = await loadRoute();
      for (let i = 0; i < 301; i++) {
        const client = { "x-forwarded-for": `10.0.${Math.floor(i / 200)}.${i % 200}` };
        await POST(reportRequest(JSON.stringify(VIOLATION), client));
      }
      expect(warn).toHaveBeenCalledTimes(300);
    } finally {
      vi.useRealTimers();
    }
  });
});
