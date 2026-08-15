/**
 * Phase 4 reporting contract: rich scorer metadata + run metadata are accepted, and
 * old SDK clients ({name, version} scorers, no metadata) remain valid.
 */
import { describe, it, expect } from "vitest";
import { ScorerRefSchema, RegisterRunRequestSchema } from "@traceroot/core";

describe("ScorerRefSchema", () => {
  it("accepts the legacy {name, version} shape", () => {
    const r = ScorerRefSchema.safeParse({ name: "acc", version: "unversioned" });
    expect(r.success).toBe(true);
  });

  it("accepts rich metadata (value_type, direction, threshold)", () => {
    const r = ScorerRefSchema.safeParse({
      name: "latency",
      version: "v2",
      value_type: "numeric",
      direction: "lower_is_better",
      threshold: 0.5,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.direction).toBe("lower_is_better");
  });

  it("rejects an unknown direction value", () => {
    const r = ScorerRefSchema.safeParse({ name: "x", version: "v1", direction: "sideways" });
    expect(r.success).toBe(false);
  });
});

describe("RegisterRunRequestSchema", () => {
  const base = {
    evaluation_name: "ticket-routing",
    dataset_id: "ds_1",
    candidate_version: "sonnet",
  };

  it("accepts an old client (no scorer metadata, no run metadata)", () => {
    const r = RegisterRunRequestSchema.safeParse({
      ...base,
      scorers: [{ name: "acc", version: "unversioned" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts structured run metadata/provenance", () => {
    const r = RegisterRunRequestSchema.safeParse({
      ...base,
      scorers: [
        { name: "acc", version: "v1", value_type: "numeric", direction: "higher_is_better" },
      ],
      metadata: { model: "claude-sonnet-5", git: { ref: "abc123" } },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.metadata).toEqual({
      model: "claude-sonnet-5",
      git: { ref: "abc123" },
    });
  });
});
