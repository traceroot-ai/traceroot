// Unit test: the offline-evaluation contract's presence, payload-cap and
// forward-compatibility rules — the properties the SDK and both validation
// layers depend on, which are easy to regress with a one-token schema edit.
import { describe, it, expect } from "vitest";
import {
  EVAL_METADATA_MAX,
  EVAL_PAYLOAD_TEXT_MAX,
  EVAL_SCORER_LIST_MAX,
  PublishDatasetVersionRequestSchema,
  RegisterRunRequestSchema,
  SCORER_MESSAGES_MAX,
  SCORER_MESSAGE_CONTENT_MAX,
  SCORER_SOURCE_MAX,
  ScorerRefSchema,
  UpsertResultRequestSchema,
} from "../eval-contract.ts";

const result = (over: Record<string, unknown> = {}) => ({
  test_case_id: "tc1",
  input: "in",
  status: "passed",
  ...over,
});

const publish = (change: Record<string, unknown>) => ({
  base_version_id: null,
  changes: [change],
});

describe("UpsertResultRequestSchema.scores", () => {
  it("leaves an omitted scores key undefined so a handler can tell it from []", () => {
    const parsed = UpsertResultRequestSchema.parse(result({ trace_id: "t1" }));
    expect(parsed.scores).toBeUndefined();
    expect("scores" in parsed).toBe(false);
  });

  it("keeps an explicit empty array distinguishable from an omitted one", () => {
    expect(UpsertResultRequestSchema.parse(result({ scores: [] })).scores).toEqual([]);
  });

  it("rejects more scores than the per-result cap", () => {
    const score = { scorer_name: "s", scorer_version: "1" };
    const under = Array.from({ length: EVAL_SCORER_LIST_MAX }, () => score);
    expect(UpsertResultRequestSchema.safeParse(result({ scores: under })).success).toBe(true);
    expect(UpsertResultRequestSchema.safeParse(result({ scores: [...under, score] })).success).toBe(
      false,
    );
  });
});

describe("UpsertResultRequestSchema payload caps", () => {
  it.each(["input", "expected_output", "candidate_output", "baseline_output"])(
    "caps %s at EVAL_PAYLOAD_TEXT_MAX",
    (field) => {
      const at = "a".repeat(EVAL_PAYLOAD_TEXT_MAX);
      expect(UpsertResultRequestSchema.safeParse(result({ [field]: at })).success).toBe(true);
      expect(UpsertResultRequestSchema.safeParse(result({ [field]: at + "a" })).success).toBe(
        false,
      );
    },
  );
});

describe("RegisterRunRequestSchema caps", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    evaluation_name: "e",
    dataset_id: "d",
    candidate_version: "v1",
    ...over,
  });

  it("rejects more scorers than the per-run cap", () => {
    const scorer = { name: "s", version: "1" };
    const under = Array.from({ length: EVAL_SCORER_LIST_MAX }, () => scorer);
    expect(RegisterRunRequestSchema.safeParse(run({ scorers: under })).success).toBe(true);
    expect(RegisterRunRequestSchema.safeParse(run({ scorers: [...under, scorer] })).success).toBe(
      false,
    );
  });

  it("rejects metadata that serializes past EVAL_METADATA_MAX", () => {
    const big = { blob: "b".repeat(EVAL_METADATA_MAX) };
    expect(RegisterRunRequestSchema.safeParse(run({ metadata: big })).success).toBe(false);
    expect(RegisterRunRequestSchema.safeParse(run({ metadata: { blob: "b" } })).success).toBe(true);
  });
});

describe("ScorerRefSchema forward compatibility", () => {
  const ref = (over: Record<string, unknown> = {}) => ({ name: "s", version: "1", ...over });

  it.each(["scorer_type", "output_type", "language"])(
    "degrades an unrecognised %s to null instead of failing the whole run",
    (field) => {
      const parsed = ScorerRefSchema.parse(ref({ [field]: "from-a-newer-sdk" }));
      expect(parsed[field as "language"]).toBeNull();
    },
  );

  it("still accepts the known values", () => {
    const parsed = ScorerRefSchema.parse(
      ref({ scorer_type: "llm_judge", output_type: "score", language: "python" }),
    );
    expect(parsed.scorer_type).toBe("llm_judge");
    expect(parsed.output_type).toBe("score");
    expect(parsed.language).toBe("python");
  });

  it("keeps rejecting the vocabularies that drive persistence", () => {
    expect(ScorerRefSchema.safeParse(ref({ value_type: "vector" })).success).toBe(false);
    expect(ScorerRefSchema.safeParse(ref({ direction: "sideways" })).success).toBe(false);
    expect(UpsertResultRequestSchema.safeParse(result({ status: "skipped" })).success).toBe(false);
    expect(UpsertResultRequestSchema.safeParse(result({ change: "sideways" })).success).toBe(false);
  });

  it("caps source, message content and message count", () => {
    expect(
      ScorerRefSchema.safeParse(ref({ source: "s".repeat(SCORER_SOURCE_MAX + 1) })).success,
    ).toBe(false);
    const msg = { role: "user", content: "c" };
    expect(
      ScorerRefSchema.safeParse(
        ref({ messages: [{ role: "user", content: "c".repeat(SCORER_MESSAGE_CONTENT_MAX + 1) }] }),
      ).success,
    ).toBe(false);
    expect(
      ScorerRefSchema.safeParse(
        ref({ messages: Array.from({ length: SCORER_MESSAGES_MAX + 1 }, () => msg) }),
      ).success,
    ).toBe(false);
  });
});

describe("dataset upsert change", () => {
  it("rejects an upsert with no input rather than creating an empty test case", () => {
    const parsed = PublishDatasetVersionRequestSchema.safeParse(
      publish({ op: "upsert", test_case_id: "new-case" }),
    );
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("input is required");
  });

  it("accepts any JSON value as input, including null and false", () => {
    for (const input of ["text", 0, false, null, { a: 1 }, [1, 2]]) {
      expect(
        PublishDatasetVersionRequestSchema.safeParse(
          publish({ op: "upsert", test_case_id: "c", input }),
        ).success,
      ).toBe(true);
    }
  });

  it("leaves expected optional and caps both by serialized size", () => {
    expect(
      PublishDatasetVersionRequestSchema.safeParse(
        publish({ op: "upsert", test_case_id: "c", input: "i" }),
      ).success,
    ).toBe(true);
    expect(
      PublishDatasetVersionRequestSchema.safeParse(
        publish({ op: "upsert", test_case_id: "c", input: "i".repeat(EVAL_PAYLOAD_TEXT_MAX) }),
      ).success,
    ).toBe(false);
  });

  it("does not require input on archive/delete changes", () => {
    expect(
      PublishDatasetVersionRequestSchema.safeParse(publish({ op: "archive", test_case_id: "c" }))
        .success,
    ).toBe(true);
    expect(
      PublishDatasetVersionRequestSchema.safeParse(publish({ op: "delete", test_case_id: "c" }))
        .success,
    ).toBe(true);
  });
});
