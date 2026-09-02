import { describe, expect, it } from "vitest";
import { applyCapturePolicy, redactSecrets } from "../lib/capture-policy.ts";

describe("redactSecrets", () => {
  it.each([
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_[REDACTED]"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "gho_[REDACTED]"],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "sk-[REDACTED]"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIA[REDACTED]"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "Authorization: Bearer [REDACTED]"],
    ["OPENAI_API_KEY=abc123def456", "OPENAI_API_KEY=[REDACTED]"],
  ])("redacts %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });
  it("leaves ordinary text alone", () => {
    expect(redactSecrets("git log --oneline -10")).toBe("git log --oneline -10");
  });

  it("redacts credentials regardless of case or naming shape", () => {
    // An earlier pattern required a 3+ uppercase prefix and a capital "Bearer",
    // which let the most common shapes through: bare TOKEN=/PASSWORD= and
    // lowercase api_key= in a .env file or a printed environment, and a
    // lowercase bearer scheme in an echoed header.
    const cases: Array<[string, string]> = [
      ["bearer abcdefgh12345678", "bearer [REDACTED]"],
      ["authorization: BEARER abcdefgh12345678", "authorization: BEARER [REDACTED]"],
      ["TOKEN=supersecretvalue", "TOKEN=[REDACTED]"],
      ["PASSWORD=hunter2xx", "PASSWORD=[REDACTED]"],
      ["api_key=abc123def456", "api_key=[REDACTED]"],
      ["DB_PASSWORD=pw12345", "DB_PASSWORD=[REDACTED]"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves ordinary assignments alone", () => {
    expect(redactSecrets("count=42")).toBe("count=42");
    expect(redactSecrets("monkey=business")).toBe("monkey=business");
    expect(redactSecrets("token_count: 12")).toBe("token_count: 12");
    expect(redactSecrets("https://example.com:8080/path")).toBe("https://example.com:8080/path");
  });

  it("redacts quoted assignment values", () => {
    // .env files and shell exports quote their values; the value class used to
    // stop at the opening quote and let the whole thing through.
    const cases: Array<[string, string]> = [
      ['PASSWORD="hunter2xx"', "PASSWORD=[REDACTED]"],
      ["export DB_PASSWORD='hunter2xx'", "export DB_PASSWORD=[REDACTED]"],
      ['API_KEY = "abc123def456"', "API_KEY=[REDACTED]"],
      ['PASSWORD=""', "PASSWORD=[REDACTED]"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts the colon form: JSON, YAML and header names", () => {
    const cases: Array<[string, string]> = [
      [
        '{"password":"hunter2xx","api_key":"abc123def456","n":1}',
        '{"password":[REDACTED],"api_key":[REDACTED],"n":1}',
      ],
      ['API_KEY: "abc123def456"', "API_KEY: [REDACTED]"],
      ["db_password: hunter2xx\nhost: db", "db_password: [REDACTED]\nhost: db"],
      ["x-api-key: abc123def456", "x-api-key: [REDACTED]"],
      [
        '{"http.request.header.authorization":"Bearer abc.def.ghi"}',
        '{"http.request.header.authorization":"Bearer [REDACTED]"}',
      ],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts Stripe keys in both live and test shapes", () => {
    expect(redactSecrets("sk_live_abcdefghijklmnop")).toBe("sk_live_[REDACTED]");
    expect(redactSecrets("sk_test_abcdefghijklmnop")).toBe("sk_test_[REDACTED]");
    expect(redactSecrets("STRIPE_KEY: sk_live_abcdefghijklmnop")).toBe("STRIPE_KEY: [REDACTED]");
  });

  it("redacts the password segment of a connection URL", () => {
    expect(redactSecrets("postgres://app:hunter2xx@db.internal:5432/app")).toBe(
      "postgres://app:[REDACTED]@db.internal:5432/app",
    );
  });

  it("redacts a PEM private-key block, with or without its footer", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`cert:\n${key}\nend`)).toBe(
      "cert:\n-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----\nend",
    );
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIEow\ncut off")).toBe(
      "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",
    );
  });
});

describe("applyCapturePolicy", () => {
  it("keeps result for allowlisted tools, redacted and truncated", () => {
    const state = { spentBytes: 0 };
    const r = applyCapturePolicy(
      {
        toolName: "download_traces",
        args: { traceId: "t" },
        result: "token ghp_" + "x".repeat(40) + " " + "y".repeat(9000),
      },
      state,
    );
    expect(r.result).toContain("ghp_[REDACTED]");
    expect(r.result!.length).toBeLessThanOrEqual(8_192 + 1);
    expect(r.truncated).toBe(true);
    expect(r.withheld).toBeNull();
    expect(state.spentBytes).toBeGreaterThan(0);
  });
  it("withholds result for non-allowlisted tools but reports its size", () => {
    const r = applyCapturePolicy(
      { toolName: "bash", args: { command: "ls" }, result: "a".repeat(500) },
      { spentBytes: 0 },
    );
    expect(r.result).toBeUndefined();
    expect(r.outputBytes).toBe(500);
    expect(r.withheld).toBe("not-allowlisted");
  });
  it("degrades to size-only once the per-run budget is spent", () => {
    const state = { spentBytes: 262_144 };
    const r = applyCapturePolicy({ toolName: "download_traces", args: {}, result: "small" }, state);
    expect(r.result).toBeUndefined();
    expect(r.withheld).toBe("budget");
  });
  it("redacts a JSON-stringified result before keeping it", () => {
    // Allowlisted output is span data, which routinely carries credential-shaped
    // attributes; results are serialised before redaction so the colon form is
    // what the pattern must catch.
    const r = applyCapturePolicy(
      {
        toolName: "download_traces",
        args: {},
        result: { spans: [{ attributes: { "db.password": "hunter2xx", "db.name": "app" } }] },
      },
      { spentBytes: 0 },
    );
    expect(r.result).not.toContain("hunter2xx");
    expect(r.result).toBe('{"spans":[{"attributes":{"db.password":[REDACTED],"db.name":"app"}}]}');
  });

  it("redacts inside args too", () => {
    const r = applyCapturePolicy(
      {
        toolName: "bash",
        args: { command: "curl -H 'Authorization: Bearer abc.def.ghi'" },
        result: "",
      },
      { spentBytes: 0 },
    );
    expect(JSON.stringify(r.args)).toContain("Bearer [REDACTED]");
  });

  it("bounds and charges captured args, not just output", () => {
    // A `write` call carries its file body in args. Leaving args unbounded made
    // the budgets govern only the smaller half of what a step persists.
    const state = { spentBytes: 0 };
    const out = applyCapturePolicy(
      { toolName: "write", args: { path: "/a", contents: "x".repeat(50_000) }, result: "ok" },
      state,
      { perStepBytes: 1_000, perRunBytes: 10_000 },
    );
    const contents = (out.args as { contents: string }).contents;
    expect(contents.length).toBeLessThanOrEqual(1_001); // cap + ellipsis
    expect(state.spentBytes).toBeGreaterThan(0);
    expect(state.spentBytes).toBeLessThanOrEqual(10_000);
  });

  it("never spends past the run budget on the last step", () => {
    // Previously a step near the limit still captured a full perStepBytes,
    // pushing the run total over the cap it exists to enforce.
    const state = { spentBytes: 9_800 };
    applyCapturePolicy(
      { toolName: "download_traces", args: {}, result: "y".repeat(50_000) },
      state,
      { perStepBytes: 1_000, perRunBytes: 10_000 },
    );
    expect(state.spentBytes).toBeLessThanOrEqual(10_000);
  });

  it("shares one step allowance across every args leaf and the result", () => {
    // A per-leaf cap let an args object exceed perStepBytes by a multiple of
    // its leaf count — five 1 KB leaves under a 1 KB step cap kept all 5 KB.
    const state = { spentBytes: 0 };
    const out = applyCapturePolicy(
      {
        toolName: "download_traces",
        args: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, "x".repeat(5_000)])),
        result: "y".repeat(5_000),
      },
      state,
      { perStepBytes: 1_000, perRunBytes: 100_000 },
    );
    // Captured content only — a "[withheld: budget]" placeholder is metadata
    // saying nothing was kept, not content, and is not charged.
    const argBytes = Object.values(out.args as Record<string, string>)
      .filter((v) => !v.startsWith("[withheld:"))
      .reduce((n, v) => n + Buffer.byteLength(v, "utf8"), 0);
    const resultBytes = Buffer.byteLength(out.result ?? "", "utf8");
    expect(argBytes + resultBytes).toBeLessThanOrEqual(1_000);
  });
});
