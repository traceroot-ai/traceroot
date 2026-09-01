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
});
