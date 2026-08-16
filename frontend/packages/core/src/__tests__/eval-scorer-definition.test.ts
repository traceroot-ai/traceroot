/**
 * Guards the scorer-DEFINITION plumbing.
 *
 * The SDK reports each scorer's definition (type, prompt/source, config) on the
 * run's `scorers` manifest, and the control-plane register-run handler persists
 * that manifest verbatim (`route.ts` stores `req.scorers`). `ScorerRefSchema` is a
 * plain (non-strict) z.object, so any definition field it does NOT declare is
 * silently stripped and never reaches the read-only Scorer detail. This asserts
 * the definition survives the parse (the bug: a code scorer showed "—" because
 * `scorer_type`/`language`/`source` were dropped here).
 */
import { describe, it, expect } from "vitest";
import { RegisterRunRequestSchema } from "../eval-contract.ts";

const base = { evaluation_name: "e", dataset_id: "ds", candidate_version: "v1" };

describe("scorer definition survives run registration parse", () => {
  it("retains a code scorer's type + language + source", () => {
    const parsed = RegisterRunRequestSchema.parse({
      ...base,
      scorers: [
        {
          name: "no_conclusion_judge",
          version: "unversioned",
          scorer_type: "code",
          language: "python",
          source: "def no_conclusion_judge(ctx):\n    return 1.0",
        },
      ],
    });
    expect(parsed.scorers[0]).toMatchObject({
      scorer_type: "code",
      language: "python",
      source: expect.stringContaining("def no_conclusion_judge"),
    });
  });

  it("retains an llm_judge's model + messages + shared config", () => {
    const parsed = RegisterRunRequestSchema.parse({
      ...base,
      scorers: [
        {
          name: "concise",
          version: "1",
          scorer_type: "llm_judge",
          output_type: "score",
          description: "Judges conciseness",
          metadata: { team: "quality" },
          model: "claude-sonnet-5",
          messages: [{ role: "system", content: "Rate the answer 0..1" }],
        },
      ],
    });
    const s = parsed.scorers[0];
    expect(s).toMatchObject({
      scorer_type: "llm_judge",
      output_type: "score",
      description: "Judges conciseness",
      model: "claude-sonnet-5",
      messages: [{ role: "system", content: "Rate the answer 0..1" }],
    });
    expect(s.metadata).toEqual({ team: "quality" });
  });

  it("still accepts a legacy {name, version} scorer and strips unknown keys", () => {
    const parsed = RegisterRunRequestSchema.parse({
      ...base,
      scorers: [{ name: "s", version: "1", bogus_field: 123 }],
    });
    expect(parsed.scorers[0]).toEqual({ name: "s", version: "1" });
  });
});
