/**
 * saveResultToDataset must JSON-ENCODE the values it writes, so a result value
 * that looks like JSON (`42`, `true`, `[1,2]`) stays that literal string in the
 * immutable snapshot instead of decoding to a different type on pull. We assert on
 * the seeds the code hands to publishDatasetVersion (mocked to capture the transform).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findFirst: vi.fn() },
  evaluationRun: { findFirst: vi.fn() },
  dataset: { findFirst: vi.fn() },
  testCase: { findFirst: vi.fn() },
}));
const publishMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => ({}) as unknown));

vi.mock("@traceroot/core", () => ({ prisma: prismaMock }));
// Mock only the network-bound publish; keep the REAL `canonicalJson` so the
// content-addressed id derivation (and its occurrence counting) runs for real.
vi.mock("./versions", async () => {
  const actual = await vi.importActual<typeof import("./versions")>("./versions");
  return { ...actual, publishDatasetVersion: publishMock };
});

import { saveResultToDataset } from "./result-to-dataset";
import { stableCaseId, LoneSurrogateError } from "./case-id";

type Seed = { testCaseId: string; input: string; expected: string | null; metadata: unknown };
/** Run the transform the code handed to publishDatasetVersion over a given current set. */
function casesFrom(current: Seed[] = []): Seed[] {
  const opts = publishMock.mock.calls[0][0] as unknown as {
    transform: (c: Seed[]) => { cases: Seed[] };
  };
  return opts.transform(current).cases;
}

beforeEach(() => {
  vi.clearAllMocks();
  publishMock.mockResolvedValue({});
  prismaMock.evaluationRun.findFirst.mockResolvedValue({ datasetId: "ds1" });
  // Default: no live originating case (so save_new_case never hits the circular guard).
  prismaMock.dataset.findFirst.mockResolvedValue({ currentVersionId: null });
  prismaMock.testCase.findFirst.mockResolvedValue(null);
});

describe("saveResultToDataset — values are JSON-encoded on write", () => {
  it("encodes a new case's input from the result so a JSON-looking scalar stays a string", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: "t1",
      input: "42",
      candidateOutput: "true",
    });

    await saveResultToDataset({
      projectId: "p1",
      resultId: "r1",
      action: "save_new_case",
      datasetId: "ds2",
    });

    const added = casesFrom([]).at(-1)!;
    expect(added.input).toBe('"42"'); // encoded string, not the raw `42`
    expect(added.expected).toBeNull(); // no expected provided → stays null
  });

  it("encodes the candidate output when opted in as expected", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: null,
      input: "hi",
      candidateOutput: "[1,2]",
    });

    await saveResultToDataset({
      projectId: "p1",
      resultId: "r1",
      action: "save_new_case",
      datasetId: "ds2",
      useCandidateAsExpected: true,
    });

    expect(casesFrom([]).at(-1)!.expected).toBe('"[1,2]"'); // "[1,2]" encoded as a string
  });

  it("update path encodes the edited input keeping the previous value's kind", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: null,
      input: "x",
      candidateOutput: null,
    });
    prismaMock.dataset.findFirst.mockResolvedValue({ currentVersionId: "dv1" });
    prismaMock.testCase.findFirst.mockResolvedValue({ testCaseId: "tc_src" }); // live case

    await saveResultToDataset({
      projectId: "p1",
      resultId: "r1",
      action: "update_existing_case",
      input: "99",
    });

    // Previous stored input was a string ('"old"'), so the edit stays a string.
    const updated = casesFrom([
      { testCaseId: "tc_src", input: '"old"', expected: null, metadata: null },
    ]).find((c) => c.testCaseId === "tc_src")!;
    expect(updated.input).toBe('"99"');
  });
});

describe("saveResultToDataset — new cases get content-addressed ids", () => {
  it("derives a stable tc_ id from the target dataset key + canonical input", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: "t1",
      input: "hello",
      candidateOutput: null,
    });
    // Target dataset carries an explicit key (the pre-image the SDK hashes).
    prismaMock.dataset.findFirst.mockResolvedValue({ currentVersionId: null, key: "support" });

    await saveResultToDataset({
      projectId: "p1",
      resultId: "r1",
      action: "save_new_case",
      datasetId: "ds2",
    });

    // input "hello" is stored as the string '"hello"'; its canonical form is the same
    // string a canonical-JSON of the string value produces (JSON.stringify("hello")).
    const added = casesFrom([]).at(-1)!;
    // Deterministic content-addressed id — not the old random UUID slice.
    expect(added.testCaseId).toBe(stableCaseId("support", '"hello"', 0));
  });

  it("disambiguates a duplicate input with the next occurrence", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: null,
      input: "dup",
      candidateOutput: null,
    });
    prismaMock.dataset.findFirst.mockResolvedValue({ currentVersionId: null, key: "support" });

    await saveResultToDataset({
      projectId: "p1",
      resultId: "r1",
      action: "save_new_case",
      datasetId: "ds2",
    });

    // No existing case with this input → occurrence 0.
    expect(casesFrom([]).at(-1)!.testCaseId).toBe(stableCaseId("support", '"dup"', 0));
    // One existing case already has the identical canonical input → occurrence 1.
    const withDup = casesFrom([
      {
        testCaseId: stableCaseId("support", '"dup"', 0),
        input: '"dup"',
        expected: null,
        metadata: null,
      },
    ]).at(-1)!;
    expect(withDup.testCaseId).toBe(stableCaseId("support", '"dup"', 1));
  });

  it("rejects an input with a lone UTF-16 surrogate with a typed error (route maps to 400)", async () => {
    prismaMock.evaluationResult.findFirst.mockResolvedValue({
      id: "r1",
      runId: "run1",
      testCaseId: "tc_src",
      traceId: null,
      input: "\uD800", // a lone high surrogate — not canonicalizable into a stable id
      candidateOutput: null,
    });
    prismaMock.dataset.findFirst.mockResolvedValue({ currentVersionId: null, key: "support" });

    await expect(
      saveResultToDataset({
        projectId: "p1",
        resultId: "r1",
        action: "save_new_case",
        datasetId: "ds2",
      }),
    ).rejects.toBeInstanceOf(LoneSurrogateError);
    // Rejected before any publish is attempted — nothing is written.
    expect(publishMock).not.toHaveBeenCalled();
  });
});
