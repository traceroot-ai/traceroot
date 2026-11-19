import { describe, it, expect } from "vitest";
import { aggregateScorers, type RawScore } from "./scorer-registry";

const score = (
  p: Partial<RawScore> & Pick<RawScore, "scorerName" | "scorerVersion">,
): RawScore => ({
  numericValue: null,
  boolValue: null,
  stringValue: null,
  passed: null,
  error: null,
  createTime: new Date("2026-07-25T10:00:00.000Z"),
  runId: "run1",
  evaluationId: "ev1",
  ...p,
});

describe("aggregateScorers", () => {
  it("aggregates one row per (name, version) and preserves all versions", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "helpfulness", scorerVersion: "v1", numericValue: 0.8 }),
        score({ scorerName: "helpfulness", scorerVersion: "v1", numericValue: 0.6 }),
        score({ scorerName: "helpfulness", scorerVersion: "v2", numericValue: 1 }),
      ],
      [],
    );
    expect(rows.map((r) => `${r.name}@${r.version}`)).toEqual(["helpfulness@v1", "helpfulness@v2"]);
    const v1 = rows.find((r) => r.version === "v1")!;
    expect(v1.scoreCount).toBe(2);
    expect(v1.valueType).toBe("numeric");
    expect(v1.numeric).toEqual({ mean: 0.7, min: 0.6, max: 0.8, count: 2 });
    expect(v1.source).toBe("SDK");
  });

  it("counts a scorer error into error stats but never as a 0 score", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "judge", scorerVersion: "v1", numericValue: 1 }),
        score({ scorerName: "judge", scorerVersion: "v1", error: "Judge returned malformed JSON" }),
      ],
      [],
    );
    const r = rows[0];
    // scoreCount is rows that actually produced a value (1 numeric), not attempts
    // (2 total including the error): an all-errored scorer reports 0 scored, not attempts.
    expect(r.scoreCount).toBe(1);
    expect(r.errorCount).toBe(1);
    expect(r.errorRate).toBe(0.5);
    // The error did not push a 0 into the numeric distribution.
    expect(r.numeric).toEqual({ mean: 1, min: 1, max: 1, count: 1 });
    expect(r.recentErrors[0].message).toContain("JSON");
  });

  it("reports a zero score count (not the attempt count) when every attempt errored", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "judge", scorerVersion: "v1", error: "timeout" }),
        score({ scorerName: "judge", scorerVersion: "v1", error: "timeout" }),
      ],
      [],
    );
    const r = rows[0];
    expect(r.scoreCount).toBe(0);
    expect(r.errorCount).toBe(2);
    expect(r.errorRate).toBe(1);
    expect(r.numeric).toBeNull();
  });

  it("handles a project's worth of numeric scores without a stack overflow", () => {
    // Regression for the Math.min(...nums)/Math.max(...nums) spread, which blows
    // the engine's argument limit well before this many scores for one scorer.
    const scores = Array.from({ length: 150_000 }, (_, i) =>
      score({ scorerName: "bulk", scorerVersion: "v1", numericValue: i % 100 }),
    );
    const rows = aggregateScorers(scores, []);
    const r = rows[0];
    expect(r.numeric).toEqual({ mean: 49.5, min: 0, max: 99, count: 150_000 });
    expect(r.scoreCount).toBe(150_000);
  });

  it("surfaces declared value_type/direction/threshold from the newest manifest", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "acc", scorerVersion: "v3", numericValue: 0.9 })],
      [
        { scorers: [{ name: "acc", version: "v3", direction: "higher_is_better" }] },
        {
          scorers: [
            {
              name: "acc",
              version: "v3",
              value_type: "numeric",
              direction: "lower_is_better",
              threshold: 0.5,
            },
          ],
        },
      ],
    );
    const r = rows[0];
    expect(r.declaredValueType).toBe("numeric");
    expect(r.direction).toBe("lower_is_better"); // newest declaration wins
    expect(r.threshold).toBe(0.5);
  });

  it("exposes the manifest's semantic key across SDK languages, falling back to name", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "covers_both_cities", scorerVersion: "v2", numericValue: 0.9 }),
        score({ scorerName: "coversBothCities", scorerVersion: "v2", numericValue: 0.8 }),
        score({ scorerName: "unkeyed", scorerVersion: "v1", numericValue: 0.5 }),
      ],
      [
        {
          scorers: [
            { key: "grade", name: "covers_both_cities", version: "v2", language: "python" },
          ],
        },
        {
          scorers: [
            { key: "grade", name: "coversBothCities", version: "v2", language: "typescript" },
          ],
        },
        { scorers: [{ name: "unkeyed", version: "v1" }] }, // no key → falls back to name
      ],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    // Same semantic key for the Python and TypeScript spellings — the UI groups on this,
    // never on the function name or the source.
    expect(byName["covers_both_cities"].key).toBe("grade");
    expect(byName["coversBothCities"].key).toBe("grade");
    // …while each row keeps its own name + language provenance.
    expect(byName["covers_both_cities"].language).toBe("python");
    expect(byName["coversBothCities"].language).toBe("typescript");
    // No key from the SDK → the name is the key (older SDK / single language).
    expect(byName["unkeyed"].key).toBe("unkeyed");
  });

  it("builds boolean and categorical distributions and pass rate", () => {
    const boolRows = aggregateScorers(
      [
        score({ scorerName: "b", scorerVersion: "v1", boolValue: true, passed: true }),
        score({ scorerName: "b", scorerVersion: "v1", boolValue: false, passed: false }),
        score({ scorerName: "b", scorerVersion: "v1", boolValue: true, passed: true }),
      ],
      [],
    );
    const b = boolRows[0];
    expect(b.valueType).toBe("boolean");
    expect(b.distribution).toEqual([
      { label: "true", count: 2 },
      { label: "false", count: 1 },
    ]);
    expect(b.passRate).toBeCloseTo(2 / 3);

    const catRows = aggregateScorers(
      [
        score({ scorerName: "c", scorerVersion: "v1", stringValue: "billing" }),
        score({ scorerName: "c", scorerVersion: "v1", stringValue: "billing" }),
        score({ scorerName: "c", scorerVersion: "v1", stringValue: "tech" }),
      ],
      [],
    );
    expect(catRows[0].valueType).toBe("categorical");
    expect(catRows[0].distribution?.[0]).toEqual({ label: "billing", count: 2 });
  });

  it("counts distinct runs and evaluations for usage", () => {
    const rows = aggregateScorers(
      [
        score({
          scorerName: "u",
          scorerVersion: "v1",
          numericValue: 1,
          runId: "r1",
          evaluationId: "e1",
        }),
        score({
          scorerName: "u",
          scorerVersion: "v1",
          numericValue: 1,
          runId: "r2",
          evaluationId: "e1",
        }),
        score({
          scorerName: "u",
          scorerVersion: "v1",
          numericValue: 1,
          runId: "r2",
          evaluationId: "e2",
        }),
      ],
      [],
    );
    expect(rows[0].runCount).toBe(2);
    expect(rows[0].evaluationCount).toBe(2);
  });

  it("seeds a zero-count row for a scorer declared in a manifest but never scored", () => {
    const rows = aggregateScorers(
      [],
      [
        {
          scorers: [
            { name: "faithfulness", version: "v2", scorer_type: "llm_judge", model: "gpt-4o" },
          ],
        },
      ],
    );
    const r = rows.find((x) => x.name === "faithfulness" && x.version === "v2")!;
    expect(r).toBeDefined();
    expect(r.scoreCount).toBe(0);
    expect(r.errorCount).toBe(0);
    expect(r.valueType).toBe("unknown");
    expect(r.numeric).toBeNull();
    expect(r.runCount).toBe(0);
    expect(r.lastUsed).toBeNull();
    // The declared definition is still surfaced even with zero observed scores.
    expect(r.model).toBe("gpt-4o");
  });
});

describe("aggregateScorers — definition folding", () => {
  it("uses the latest run's definition, not the first (definition is part of identity)", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "judge", scorerVersion: "unversioned", numericValue: 1 })],
      [
        {
          scorers: [
            { name: "judge", version: "unversioned", scorer_type: "llm_judge", model: "a" },
          ],
        },
        {
          scorers: [
            { name: "judge", version: "unversioned", scorer_type: "llm_judge", model: "b" },
          ],
        },
      ],
    );
    expect(rows[0].model).toBe("b");
  });

  it("leaves undeclared definition fields absent, never inferred", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "acc", scorerVersion: "v1", numericValue: 1 })],
      [{ scorers: [{ name: "acc", version: "v1" }] }],
    );
    const r = rows[0];
    expect(r.scorerType).toBeNull();
    expect(r.model).toBeNull();
    expect(r.messages).toBeNull();
    expect(r.sourceCode).toBeNull();
    // An absent required_inputs stays null (unknown), never coerced to [] ("nothing").
    expect(r.requiredInputs).toBeNull();
    // Value type is still INFERRED from the observed score, independent of the
    // (absent) declared definition.
    expect(r.valueType).toBe("numeric");
  });

  it("carries declared required_inputs through, keeping an explicit empty list distinct from absent", () => {
    const [withInputs] = aggregateScorers(
      [score({ scorerName: "em", scorerVersion: "v1", numericValue: 1 })],
      [{ scorers: [{ name: "em", version: "v1", required_inputs: ["output", "expected", 7] }] }],
    );
    // Non-string entries are dropped; the declared inputs survive.
    expect(withInputs.requiredInputs).toEqual(["output", "expected"]);

    const [readsNothing] = aggregateScorers(
      [score({ scorerName: "noop", scorerVersion: "v1", numericValue: 1 })],
      [{ scorers: [{ name: "noop", version: "v1", required_inputs: [] }] }],
    );
    // [] is a real "reads no case fields", NOT the same as an absent (null) declaration.
    expect(readsNothing.requiredInputs).toEqual([]);
  });

  it("tolerates malformed manifests instead of throwing", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "acc", scorerVersion: "v1", numericValue: 1 })],
      [
        { scorers: null },
        { scorers: "[]" },
        { scorers: [{ version: "v1" }] }, // no name
        { scorers: [{ name: "acc", version: "v1", messages: [{ role: 1 }] }] }, // bad message shape
      ],
    );
    const r = rows[0];
    // None of the malformed manifests threw, and the bad `messages` entry was
    // dropped rather than surfaced.
    expect(r.messages).toBeNull();
  });

  it("flags divergent definitions reported under the identical (name, version) key", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "judge", scorerVersion: "unversioned", numericValue: 0.9 }),
        score({ scorerName: "judge", scorerVersion: "unversioned", numericValue: 0.5 }),
      ],
      [
        {
          scorers: [
            {
              name: "judge",
              version: "unversioned",
              scorer_type: "llm_judge",
              model: "gpt-4o",
              messages: [{ role: "system", content: "promptA" }],
            },
          ],
        },
        {
          scorers: [
            {
              name: "judge",
              version: "unversioned",
              scorer_type: "llm_judge",
              model: "claude-sonnet-5",
              messages: [{ role: "system", content: "promptB" }],
            },
          ],
        },
      ],
    );
    const r = rows[0];
    expect(r.distinctDefinitions).toBe(2);
    expect(r.definitionHash).not.toBeNull();
  });

  it("reports exactly one distinct definition when every manifest agrees", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "judge", scorerVersion: "v1", numericValue: 1 })],
      [
        { scorers: [{ name: "judge", version: "v1", scorer_type: "code", language: "python" }] },
        { scorers: [{ name: "judge", version: "v1", scorer_type: "code", language: "python" }] },
      ],
    );
    expect(rows[0].distinctDefinitions).toBe(1);
  });
});

describe("aggregateScorers — value type and shaping edge cases", () => {
  it("reports mixed when a (name, version) key observed more than one value kind", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "flaky", scorerVersion: "v1", numericValue: 1 }),
        score({ scorerName: "flaky", scorerVersion: "v1", boolValue: true }),
      ],
      [],
    );
    expect(rows[0].valueType).toBe("mixed");
  });

  it("truncates the category distribution to the top 8", () => {
    const scores: RawScore[] = [];
    for (let i = 0; i < 10; i++) {
      // Give each category a distinct count so the ordering is unambiguous, and
      // make sure there are more than 8 categories.
      for (let j = 0; j <= i; j++) {
        scores.push(score({ scorerName: "cat", scorerVersion: "v1", stringValue: `label-${i}` }));
      }
    }
    const rows = aggregateScorers(scores, []);
    expect(rows[0].distribution).toHaveLength(8);
    // Highest-count categories first.
    expect(rows[0].distribution?.[0]).toEqual({ label: "label-9", count: 10 });
  });

  it("keeps only the 3 most recent errors, newest first", () => {
    const scores = [
      score({
        scorerName: "e",
        scorerVersion: "v1",
        error: "e1",
        createTime: new Date("2026-01-01"),
      }),
      score({
        scorerName: "e",
        scorerVersion: "v1",
        error: "e2",
        createTime: new Date("2026-01-02"),
      }),
      score({
        scorerName: "e",
        scorerVersion: "v1",
        error: "e3",
        createTime: new Date("2026-01-03"),
      }),
      score({
        scorerName: "e",
        scorerVersion: "v1",
        error: "e4",
        createTime: new Date("2026-01-04"),
      }),
    ];
    const rows = aggregateScorers(scores, []);
    expect(rows[0].recentErrors.map((e) => e.message)).toEqual(["e4", "e3", "e2"]);
  });

  it("surfaces the SDK-reported definition for a code scorer and an llm_judge scorer", () => {
    const rows = aggregateScorers(
      [
        score({ scorerName: "nc", scorerVersion: "1", numericValue: 1 }),
        score({ scorerName: "concise", scorerVersion: "1", numericValue: 0.9 }),
      ],
      [
        {
          scorers: [
            {
              name: "nc",
              version: "1",
              scorer_type: "code",
              language: "python",
              source: "def nc(ctx):\n    return 1.0",
            },
            {
              name: "concise",
              version: "1",
              scorer_type: "llm_judge",
              output_type: "score",
              model: "claude-sonnet-5",
              messages: [{ role: "system", content: "Rate the answer 0..1" }],
            },
          ],
        },
      ],
    );
    const code = rows.find((r) => r.name === "nc")!;
    expect(code.scorerType).toBe("code");
    expect(code.language).toBe("python");
    expect(code.sourceCode).toBe("def nc(ctx):\n    return 1.0");
    expect(code.model).toBeNull();
    expect(code.messages).toBeNull();

    const judge = rows.find((r) => r.name === "concise")!;
    expect(judge.scorerType).toBe("llm_judge");
    expect(judge.outputType).toBe("score");
    expect(judge.model).toBe("claude-sonnet-5");
    expect(judge.messages).toEqual([{ role: "system", content: "Rate the answer 0..1" }]);
    expect(judge.language).toBeNull();
    expect(judge.sourceCode).toBeNull();
  });

  it("lets the last manifest in array order win — callers must pass manifests oldest-first", () => {
    // aggregateScorers has no timestamp to sort by; it trusts the caller's order and
    // overwrites on each pass. Feeding a newer definition first and an older one last
    // means the OLDER one wins here, documenting that the "latest wins" guarantee is
    // entirely the caller's responsibility (see evaluations/scorers/route.ts orderBy).
    const rows = aggregateScorers(
      [score({ scorerName: "nc", scorerVersion: "1", numericValue: 1 })],
      [
        { scorers: [{ name: "nc", version: "1", scorer_type: "code", language: "python" }] },
        { scorers: [{ name: "nc", version: "1", scorer_type: "code", language: "typescript" }] },
      ],
    );
    // The second (last-in-array) manifest's declaration wins.
    expect(rows[0].language).toBe("typescript");
  });

  it("lets a later partial report wipe an earlier definition's other fields wholesale", () => {
    // definitionByKey rebuilds an empty definition per manifest entry and replaces the
    // whole map value whenever any field is present — so a later run reporting only
    // `description` resets `language`/`sourceCode` to null rather than merging with the
    // earlier, richer report. This documents that behavior rather than asserting it is
    // desirable; flag before anything downstream relies on partial reports accumulating.
    const rows = aggregateScorers(
      [score({ scorerName: "nc", scorerVersion: "1", numericValue: 1 })],
      [
        {
          scorers: [
            {
              name: "nc",
              version: "1",
              scorer_type: "code",
              language: "python",
              source: "def nc(ctx):\n    return 1.0",
            },
          ],
        },
        { scorers: [{ name: "nc", version: "1", description: "tweaked" }] },
      ],
    );
    const r = rows[0];
    expect(r.description).toBe("tweaked");
    expect(r.language).toBeNull();
    expect(r.sourceCode).toBeNull();
  });

  it("filters malformed messages entries and leaves messages null when all are malformed", () => {
    const rows = aggregateScorers(
      [score({ scorerName: "concise", scorerVersion: "1", numericValue: 1 })],
      [
        {
          scorers: [
            {
              name: "concise",
              version: "1",
              messages: [
                { role: "system", content: "keep me" },
                { role: "system" }, // missing content — dropped
                { content: "no role" }, // missing role — dropped
                "not an object", // dropped
              ],
            },
          ],
        },
      ],
    );
    expect(rows[0].messages).toEqual([{ role: "system", content: "keep me" }]);

    const allMalformed = aggregateScorers(
      [score({ scorerName: "concise2", scorerVersion: "1", numericValue: 1 })],
      [
        {
          scorers: [
            { name: "concise2", version: "1", messages: [{ role: "system" }, { content: "x" }] },
          ],
        },
      ],
    );
    expect(allMalformed[0].messages).toBeNull();
  });
});
