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
});
