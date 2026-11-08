import { describe, expect, it } from "vitest";
import {
  REQUIRED_SKILL_NAMES,
  UPDATE_SKILL_NAMES,
  listSkills,
  loadSkill,
  skillsForRun,
} from "../skills/index.ts";
import { updateResultSchema } from "../result.ts";

describe("update skills", () => {
  it("ships exactly the seventeen skills, each with text", () => {
    expect(UPDATE_SKILL_NAMES).toHaveLength(17);
    expect(new Set(UPDATE_SKILL_NAMES).size).toBe(17);
    for (const skill of listSkills()) {
      expect(skill.name).toMatch(/^update-[a-z-]+$/);
      expect(skill.body.length).toBeGreaterThan(200);
      expect(skill.summary.length).toBeGreaterThan(10);
    }
  });

  it("loads by name through one function and refuses an unknown name", () => {
    expect(loadSkill("update-self-check").title).toBe("Self-check");
    expect(() => loadSkill("update-nope")).toThrow(/Unknown update skill/);
  });

  it("keeps the output schema, evidence and self-check skills always on", () => {
    expect([...REQUIRED_SKILL_NAMES].sort()).toEqual([
      "update-evidence-and-links",
      "update-self-check",
      "update-triage-and-dedupe",
    ]);
    const daily = skillsForRun({ frequency: "daily", codeChangesEnabled: false }).map(
      (s) => s.name,
    );
    for (const name of REQUIRED_SKILL_NAMES) expect(daily).toContain(name);
  });

  it("applies the code changes and weekly skills only when they apply", () => {
    const names = (frequency: "daily" | "weekly", codeChangesEnabled: boolean) =>
      skillsForRun({ frequency, codeChangesEnabled }).map((s) => s.name);
    expect(names("daily", false)).not.toContain("update-code-changes");
    expect(names("daily", false)).not.toContain("update-weekly-rollup");
    expect(names("weekly", true)).toContain("update-code-changes");
    expect(names("weekly", false)).toContain("update-weekly-rollup");
  });

  it("states the correlation-only rule for code changes", () => {
    const body = loadSkill("update-code-changes").body;
    expect(body).toContain("coincides with");
    expect(body).toMatch(/Never "caused by"/);
  });

  it("describes the same output fields the result schema accepts", () => {
    const body = loadSkill("update-triage-and-dedupe").body;
    for (const field of Object.keys(updateResultSchema.shape)) expect(body).toContain(field);
  });
});

describe("result schema", () => {
  it("accepts a nothing-to-report result and rejects an unlinked url", () => {
    const base = {
      nothingToReport: true,
      headline: "Nothing notable this week.",
      summary: "",
      sections: [],
      suggestedDetectors: [],
      notesForNextRun: "",
    };
    expect(updateResultSchema.safeParse(base).success).toBe(true);
    const bad = {
      ...base,
      sections: [
        {
          id: "shifts",
          title: "Shifts",
          items: [{ text: "x", evidence: [{ kind: "trace", label: "t", url: "not a url" }] }],
        },
      ],
    };
    expect(updateResultSchema.safeParse(bad).success).toBe(false);
  });
});
