import { describe, expect, it } from "vitest";
import { applyCapturePolicy, redactSecrets } from "../lib/capture-policy.ts";

// A truncated result may carry one uncharged "[withheld: budget]" (or "…")
// placeholder capArgs doesn't bill to the budget, plus the string-escaping
// bytes the byte accounting approximates rather than counts exactly (see the
// capArgs doc comment). This bounds that gap in the tests below.
const BUDGET_SLACK_BYTES = 64;

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
    // The pattern is scheme-agnostic; a made-up scheme keeps this fixture from
    // tripping secret scanners that recognise real database URL shapes.
    expect(redactSecrets("svc://app:hunter2xx@db.internal:5432/app")).toBe(
      "svc://app:[REDACTED]@db.internal:5432/app",
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

  it("redacts a structured result by key before serialising it, camelCase included", () => {
    const state = { spentBytes: 0 };
    const out = applyCapturePolicy(
      {
        toolName: "download_traces",
        args: {},
        result: {
          rows: [{ dbPassword: "hunter2", apiToken: 12345, note: "plain" }],
          Authorization: "Bearer abcdefghijklmnop",
          text: "AKIAIOSFODNN7EXAMPLE inline",
        },
      },
      state,
    );
    expect(out.result).not.toContain("hunter2");
    expect(out.result).not.toContain("12345");
    expect(out.result).not.toContain("abcdefghijklmnop");
    expect(out.result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.result).toContain('"dbPassword":"[REDACTED]"');
    expect(out.result).toContain('"apiToken":"[REDACTED]"');
    expect(out.result).toContain('"note":"plain"');
    expect(JSON.parse(out.result!)).toBeTruthy();
    // The reported size is the tool's actual output, not the redacted text.
    const original = JSON.stringify({
      rows: [{ dbPassword: "hunter2", apiToken: 12345, note: "plain" }],
      Authorization: "Bearer abcdefghijklmnop",
      text: "AKIAIOSFODNN7EXAMPLE inline",
    });
    expect(out.outputBytes).toBe(Buffer.byteLength(original, "utf8"));
    expect(out.outputBytes).not.toBe(Buffer.byteLength(out.result!, "utf8"));
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

  it("never returns or charges more bytes than the budget for multibyte text", () => {
    // Cutting the byte buffer mid-codepoint made the decoder emit a 3-byte
    // U+FFFD for the fragment, so both the result and spentBytes overshot.
    for (const [perStepBytes, perRunBytes] of [
      [5, 5],
      [8, 100],
      [1_000, 1_006],
    ]) {
      const state = { spentBytes: 0 };
      const r = applyCapturePolicy(
        { toolName: "download_traces", args: {}, result: "😀".repeat(500) },
        state,
        { perStepBytes, perRunBytes },
      );
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.result!, "utf8")).toBeLessThanOrEqual(perStepBytes);
      expect(state.spentBytes).toBeLessThanOrEqual(perRunBytes);
      expect(r.result).not.toContain("�");
    }
    // Args leaves take the same path. The budget now also charges the `{`/`}`
    // and the `"command":` key (11 bytes total), so it needs headroom beyond
    // the multibyte content itself, unlike the result-only cases above.
    const state = { spentBytes: 0 };
    const r = applyCapturePolicy(
      { toolName: "bash", args: { command: "日本語".repeat(100) }, result: "" },
      state,
      { perStepBytes: 20, perRunBytes: 20 },
    );
    expect(Buffer.byteLength((r.args as { command: string }).command, "utf8")).toBeLessThanOrEqual(
      20,
    );
    expect(state.spentBytes).toBeLessThanOrEqual(20);
  });

  it("reports cut args as truncated, and withholds the result the args used up", () => {
    // Before, a 20 KB `bash` command cut to the step allowance came back with
    // `truncated: false`, and a result with no allowance left came back as
    // `result: ""` — an empty string that reads as real output — instead of
    // the `withheld: "budget"` a spent run budget yields.
    const withheld = applyCapturePolicy(
      { toolName: "download_traces", args: { q: "x".repeat(5_000) }, result: "rows" },
      { spentBytes: 0 },
      { perStepBytes: 1_000, perRunBytes: 100_000 },
    );
    expect(withheld.truncated).toBe(true);
    expect(withheld.result).toBeUndefined();
    expect(withheld.withheld).toBe("budget");

    const cutArgs = applyCapturePolicy(
      { toolName: "bash", args: { command: "x".repeat(5_000) }, result: "out" },
      { spentBytes: 0 },
      { perStepBytes: 1_000, perRunBytes: 100_000 },
    );
    expect(cutArgs.truncated).toBe(true);
    expect(cutArgs.withheld).toBe("not-allowlisted");

    const fits = applyCapturePolicy(
      { toolName: "download_traces", args: { q: "short" }, result: "rows" },
      { spentBytes: 0 },
      { perStepBytes: 1_000, perRunBytes: 100_000 },
    );
    expect(fits).toMatchObject({ result: "rows", truncated: false, withheld: null });
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

  it("redacts a value by its key, not just by matching its shape", () => {
    // The other redaction tests use values that independently look like a
    // secret (a token shape, or a colon-form "key":"value" once serialised).
    // An ordinary value under a credential-shaped key has no such shape of
    // its own for redactSecrets to catch once the two are separated.
    const r = applyCapturePolicy(
      { toolName: "bash", args: { password: "hunter2" }, result: "" },
      { spentBytes: 0 },
    );
    const args = r.args as Record<string, string>;
    expect(args.password).toBe("[REDACTED]");
    expect(Object.keys(args)).toEqual(["password"]); // the key itself survives
  });

  it("redacts a credential-shaped key at any depth, whatever the value's type", () => {
    const r = applyCapturePolicy(
      { toolName: "bash", args: { db: { connection: { passwd: 123 } } }, result: "" },
      { spentBytes: 0 },
    );
    const args = r.args as { db: { connection: { passwd: unknown } } };
    expect(args.db.connection.passwd).toBe("[REDACTED]");
  });

  it("recognizes a credential key regardless of separator or camelCase", () => {
    const r = applyCapturePolicy(
      {
        toolName: "bash",
        args: {
          apiKey: "abc",
          API_KEY: "def",
          "api-key": "ghi",
          dbPassword: "jkl",
          plain: "kept",
        },
        result: "",
      },
      { spentBytes: 0 },
    );
    const args = r.args as Record<string, string>;
    expect(args.apiKey).toBe("[REDACTED]");
    expect(args.API_KEY).toBe("[REDACTED]");
    expect(args["api-key"]).toBe("[REDACTED]");
    expect(args.dbPassword).toBe("[REDACTED]");
    expect(args.plain).toBe("kept");
  });

  it("charges a long key against the budget like any other content", () => {
    // Previously only string VALUES were charged; an arbitrarily long key
    // name cost nothing, so a tiny value under a huge key still fit whole.
    const longKey = "x".repeat(100);
    const state = { spentBytes: 0 };
    const out = applyCapturePolicy(
      { toolName: "bash", args: { [longKey]: "v" }, result: "" },
      state,
      { perStepBytes: 50, perRunBytes: 50 },
    );
    expect(JSON.stringify(out.args)).not.toContain(longKey);
    expect(out.truncated).toBe(true);
    expect(state.spentBytes).toBeLessThanOrEqual(50);
    expect(() => JSON.parse(JSON.stringify(out.args))).not.toThrow();
  });

  it("charges structural bytes for numeric and boolean payloads, not just strings", () => {
    // Before, only string leaves were charged: a 100,000-number array came
    // back at ~590 KB serialized with spentBytes=0 and truncated=false.
    const payloads = [
      { nums: Array.from({ length: 100_000 }, (_, i) => i) },
      { flags: Array.from({ length: 100_000 }, (_, i) => i % 2 === 0) },
    ];
    for (const args of payloads) {
      const state = { spentBytes: 0 };
      const budget = { perStepBytes: 2_000, perRunBytes: 2_000 };
      const out = applyCapturePolicy({ toolName: "bash", args, result: "" }, state, budget);
      const serializedBytes = Buffer.byteLength(JSON.stringify(out.args), "utf8");
      expect(serializedBytes).toBeLessThanOrEqual(budget.perStepBytes + BUDGET_SLACK_BYTES);
      expect(out.truncated).toBe(true);
      expect(state.spentBytes).toBeGreaterThan(0);
    }
  });

  it("stays valid, parseable JSON when the budget runs out in the middle of a mixed object", () => {
    const state = { spentBytes: 0 };
    const out = applyCapturePolicy(
      {
        toolName: "bash",
        args: {
          a: "x".repeat(200),
          b: 12345,
          c: [1, 2, 3, "y".repeat(200)],
          d: { nested: "z".repeat(200) },
          e: "kept only if room remains",
        },
        result: "",
      },
      state,
      { perStepBytes: 300, perRunBytes: 300 },
    );
    expect(() => JSON.parse(JSON.stringify(out.args))).not.toThrow();
    expect(out.truncated).toBe(true);
    expect(state.spentBytes).toBeLessThanOrEqual(300);
  });

  it("leaves one sentinel, not one per ancestor, when the budget runs out deep inside nested args", () => {
    const state = { spentBytes: 0 };
    const budget = { perStepBytes: 120, perRunBytes: 120 };
    const args = {
      outer: [[["x".repeat(500), "never"], "never"], "never"],
      after: "never",
    };
    const out = applyCapturePolicy({ toolName: "bash", args, result: "" }, state, budget);
    const serialized = JSON.stringify(out.args);
    expect(serialized.match(/\[withheld: budget\]/g)?.length ?? 0).toBe(1);
    expect(serialized).not.toContain("never");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      budget.perStepBytes + BUDGET_SLACK_BYTES,
    );
    expect(out.truncated).toBe(true);
  });

  it("bounds a quote- and backslash-heavy string by its escaped size, so the cap holds", () => {
    const state = { spentBytes: 0 };
    const budget = { perStepBytes: 200, perRunBytes: 200 };
    const args = { cmd: '"\\'.repeat(400) };
    const out = applyCapturePolicy({ toolName: "bash", args, result: "" }, state, budget);
    expect(Buffer.byteLength(JSON.stringify(out.args), "utf8")).toBeLessThanOrEqual(
      budget.perStepBytes,
    );
    expect(state.spentBytes).toBeLessThanOrEqual(budget.perRunBytes);
    expect(out.truncated).toBe(true);
  });
});
