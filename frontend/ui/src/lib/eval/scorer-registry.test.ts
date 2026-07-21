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
    expect(r.scoreCount).toBe(2);
    expect(r.errorCount).toBe(1);
    expect(r.errorRate).toBe(0.5);
    // The error did not push a 0 into the numeric distribution.
    expect(r.numeric).toEqual({ mean: 1, min: 1, max: 1, count: 1 });
    expect(r.recentErrors[0].message).toContain("JSON");
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
});
