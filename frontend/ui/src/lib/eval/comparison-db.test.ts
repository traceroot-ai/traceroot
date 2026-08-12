import { describe, it, expect } from "vitest";
import { parseScorers, toComparisonRun, toComparisonResults } from "./comparison-db";

describe("parseScorers", () => {
  it("tolerates the legacy {name, version} shape (no metadata)", () => {
    expect(parseScorers([{ name: "acc", version: "v1" }])).toEqual([
      { name: "acc", version: "v1", valueType: null, direction: null, threshold: null },
    ]);
  });

  it("reads richer metadata when present and ignores unknown values", () => {
    expect(
      parseScorers([
        {
          name: "lat",
          version: "v2",
          value_type: "numeric",
          direction: "lower_is_better",
          threshold: 0.5,
        },
        { name: "bad", version: "v1", value_type: "nonsense", direction: "sideways" },
      ]),
    ).toEqual([
      {
        name: "lat",
        version: "v2",
        valueType: "numeric",
        direction: "lower_is_better",
        threshold: 0.5,
      },
      { name: "bad", version: "v1", valueType: null, direction: null, threshold: null },
    ]);
  });

  it("surfaces each emitted metric under its own name with its own policy", () => {
    // A `grade` definition emits `quality`/`relevance`; a Score reports the metric name as
    // scorer_name, so each metric's policy must resolve by that name, not the definition's.
    expect(
      parseScorers([
        {
          name: "grade",
          version: "v2",
          emitted_metrics: [
            {
              name: "quality",
              value_type: "numeric",
              direction: "higher_is_better",
              threshold: 0.8,
            },
            { name: "relevance", value_type: "boolean" },
          ],
        },
      ]),
    ).toEqual([
      { name: "grade", version: "v2", valueType: null, direction: null, threshold: null },
      {
        name: "quality",
        version: "v2",
        valueType: "numeric",
        direction: "higher_is_better",
        threshold: 0.8,
      },
      { name: "relevance", version: "v2", valueType: "boolean", direction: null, threshold: null },
    ]);
  });

  it("returns [] for null / non-array / malformed entries", () => {
    expect(parseScorers(null)).toEqual([]);
    expect(parseScorers("nope")).toEqual([]);
    expect(parseScorers([{ version: "v1" }, 42, null])).toEqual([]);
  });
});

describe("toComparisonRun", () => {
  it("maps DB run fields and parses scorers", () => {
    const run = toComparisonRun({
      id: "r1",
      runNumber: 3,
      evaluationId: "e1",
      datasetVersionId: "dsv1",
      candidateVersion: "sonnet",
      status: "completed",
      baselineRunId: "r0",
      scorers: [{ name: "acc", version: "unversioned" }],
    });
    expect(run.scorers).toEqual([
      { name: "acc", version: "unversioned", valueType: null, direction: null, threshold: null },
    ]);
  });
});

describe("toComparisonResults", () => {
  it("maps results + scores to engine inputs", () => {
    const [r] = toComparisonResults([
      {
        testCaseId: "t1",
        status: "passed",
        candidateOutput: "out",
        durationMs: 123,
        scores: [
          {
            scorerName: "acc",
            scorerVersion: "v1",
            numericValue: 1,
            boolValue: null,
            stringValue: null,
            error: null,
          },
        ],
      },
    ]);
    expect(r.testCaseId).toBe("t1");
    expect(r.durationMs).toBe(123);
    expect(r.scores[0]).toMatchObject({ scorerName: "acc", numericValue: 1 });
  });
});
