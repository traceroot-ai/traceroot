import { describe, expect, it } from "vitest";
import {
  createLoopSchema,
  loopStatusActionSchema,
  updateLoopSchema,
  LOOP_INSTRUCTIONS_REQUIRED,
  LOOP_LIMITS,
} from "../contracts.ts";
import { getLoopTemplate, LOOP_TEMPLATES, templateLoopInput } from "../templates.ts";

const schedule = { kind: "daily", hour: 9, timezone: "UTC" } as const;
const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error!.issues[0].message;

describe("createLoopSchema", () => {
  it("requires instructions for every Loop, templated or custom", () => {
    for (const template of ["coding-agents", null, undefined]) {
      expect(firstIssue(createLoopSchema.safeParse({ name: "x", schedule, template }))).toBe(
        LOOP_INSTRUCTIONS_REQUIRED,
      );
      expect(
        firstIssue(
          createLoopSchema.safeParse({ name: "x", schedule, template, instructions: "  " }),
        ),
      ).toBe(LOOP_INSTRUCTIONS_REQUIRED);
    }
    expect(firstIssue(createLoopSchema.safeParse({ name: "x", schedule, instructions: 3 }))).toBe(
      "instructions must be text",
    );
  });

  it("accepts a templated Loop with its template's prompt, trimmed", () => {
    const prompt = getLoopTemplate("coding-agents")!.defaultInstructions;
    const parsed = createLoopSchema.parse({
      name: " Weekly review ",
      template: "coding-agents",
      instructions: `${prompt}\n`,
      schedule,
    });
    expect(parsed.name).toBe("Weekly review");
    expect(parsed.instructions).toBe(prompt.trim());
    expect(
      createLoopSchema.safeParse({ name: "x", schedule, instructions: "Look for timeouts" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown template, an empty or long name, and a bad source", () => {
    expect(
      firstIssue(
        createLoopSchema.safeParse({ name: "x", schedule, template: "nope", instructions: "a" }),
      ),
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

  it("bounds the lookback window", () => {
    const base = { name: "x", schedule, instructions: "a" };
    expect(createLoopSchema.safeParse({ ...base, lookbackHours: 169 }).success).toBe(false);
    expect(createLoopSchema.safeParse({ ...base, lookbackHours: 168 }).success).toBe(true);
  });
});

describe("updateLoopSchema", () => {
  it("accepts any subset, including none", () => {
    expect(updateLoopSchema.safeParse({}).success).toBe(true);
    expect(updateLoopSchema.safeParse({ dryRun: true }).success).toBe(true);
  });

  it("does not let a patch blank the instructions, templated or not", () => {
    expect(firstIssue(updateLoopSchema.safeParse({ instructions: "" }))).toBe(
      LOOP_INSTRUCTIONS_REQUIRED,
    );
    expect(
      firstIssue(updateLoopSchema.safeParse({ template: "coding-agents", instructions: " " })),
    ).toBe(LOOP_INSTRUCTIONS_REQUIRED);
    // Left out is untouched: the stored prompt stays.
    expect(updateLoopSchema.safeParse({ template: null }).success).toBe(true);
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

  it("builds a valid create body from a template, on its daily hour in the given zone", () => {
    const input = templateLoopInput("cost-drivers", "Asia/Tokyo")!;
    expect(input).toEqual({
      name: "Cost drivers",
      template: "cost-drivers",
      instructions: LOOP_TEMPLATES[1].defaultInstructions,
      schedule: { kind: "daily", hour: 9, timezone: "Asia/Tokyo" },
    });
    expect(createLoopSchema.safeParse(input).success).toBe(true);
    expect(templateLoopInput(null, "UTC")).toBeNull();
  });
});
