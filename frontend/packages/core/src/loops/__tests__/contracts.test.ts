import { describe, expect, it } from "vitest";
import {
  createLoopSchema,
  loopStatusActionSchema,
  updateLoopSchema,
  LOOP_LIMITS,
} from "../contracts.ts";
import { getLoopTemplate, LOOP_TEMPLATES } from "../templates.ts";

const schedule = { kind: "daily", hour: 9, timezone: "UTC" } as const;
const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error!.issues[0].message;

describe("createLoopSchema", () => {
  it("accepts a templated Loop with no instructions", () => {
    const parsed = createLoopSchema.parse({
      name: " Weekly review ",
      template: "coding-agents",
      schedule,
    });
    expect(parsed.name).toBe("Weekly review");
  });

  it("requires instructions for a custom Loop", () => {
    expect(firstIssue(createLoopSchema.safeParse({ name: "x", schedule }))).toBe(
      "instructions are required unless a template is chosen",
    );
    expect(
      firstIssue(createLoopSchema.safeParse({ name: "x", schedule, instructions: "   " })),
    ).toContain("instructions are required");
    expect(
      createLoopSchema.safeParse({ name: "x", schedule, instructions: "Look for timeouts" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown template, an empty or long name, and a bad source", () => {
    expect(
      firstIssue(createLoopSchema.safeParse({ name: "x", schedule, template: "nope" })),
    ).toContain("template");
    expect(
      firstIssue(createLoopSchema.safeParse({ name: "  ", schedule, instructions: "a" })),
    ).toContain("name");
    expect(
      firstIssue(
        createLoopSchema.safeParse({
          name: "n".repeat(LOOP_LIMITS.nameMaxLength + 1),
          schedule,
          instructions: "a",
        }),
      ),
    ).toContain("at most");
    expect(
      firstIssue(
        createLoopSchema.safeParse({ name: "x", schedule, instructions: "a", source: "other" }),
      ),
    ).toContain("source");
  });

  it("bounds the lookback window and the findings per run", () => {
    const base = { name: "x", schedule, instructions: "a" };
    expect(createLoopSchema.safeParse({ ...base, lookbackHours: 169 }).success).toBe(false);
    expect(createLoopSchema.safeParse({ ...base, maxFindingsPerRun: 3 }).success).toBe(false);
    expect(
      createLoopSchema.safeParse({ ...base, lookbackHours: 168, maxFindingsPerRun: 2 }).success,
    ).toBe(true);
  });
});

describe("updateLoopSchema", () => {
  it("accepts any subset, including none", () => {
    expect(updateLoopSchema.safeParse({}).success).toBe(true);
    expect(updateLoopSchema.safeParse({ dryRun: true }).success).toBe(true);
  });

  it("does not let a patch clear the template without instructions", () => {
    expect(firstIssue(updateLoopSchema.safeParse({ template: null }))).toContain(
      "instructions are required",
    );
    expect(updateLoopSchema.safeParse({ template: null, instructions: "mine" }).success).toBe(true);
  });
});

describe("loopStatusActionSchema and templates", () => {
  it("allows pause and resume only", () => {
    expect(loopStatusActionSchema.safeParse({ action: "pause" }).success).toBe(true);
    expect(loopStatusActionSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("looks a template up by id", () => {
    expect(getLoopTemplate("coding-agents")).toBe(LOOP_TEMPLATES[0]);
    expect(getLoopTemplate("nope")).toBeNull();
    expect(getLoopTemplate(null)).toBeNull();
  });
});
