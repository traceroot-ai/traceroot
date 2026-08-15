/**
 * Evaluation-result → dataset actions. Drives the real route against the in-memory
 * fake prisma + versioning engine. Verifies the three explicit actions, the
 * circular-save guard, idempotency, and that candidate output is never copied to
 * expected implicitly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: auth.requireAuth,
  requireProjectAccess: auth.requireProjectAccess,
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const { fakePrisma } = await import("@/lib/eval/__tests__/fake-prisma");
  return { ...actual, prisma: fakePrisma };
});

import { fakePrisma } from "@/lib/eval/__tests__/fake-prisma";
import { POST } from "./route";

const PROJECT_ID = "proj_1";
const params = (resultId: string) => ({
  params: Promise.resolve({ projectId: PROJECT_ID, resultId }),
});
const req = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];
const readJson = (res: { json: () => Promise<unknown> }) =>
  res.json() as Promise<Record<string, unknown>>;

const casesIn = (versionId: string) =>
  fakePrisma.testCase.rows.filter((c) => c.datasetVersionId === versionId);
const currentVersionId = (datasetId: string) =>
  fakePrisma.dataset.rows.find((d) => d.id === datasetId)!.currentVersionId as string;

beforeEach(() => {
  fakePrisma.reset();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1", email: "e@x.com" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: PROJECT_ID } });

  // Originating dataset ds1 @ v1 with one case "tc-A".
  fakePrisma.dataset.rows.push({ id: "ds1", projectId: PROJECT_ID, currentVersionId: "dv1" });
  fakePrisma.datasetVersion.rows.push({
    id: "dv1",
    datasetId: "ds1",
    projectId: PROJECT_ID,
    versionNumber: 1,
    label: "v1",
  });
  fakePrisma.testCase.rows.push({
    id: "tcrow-A",
    testCaseId: "tc-A",
    datasetVersionId: "dv1",
    datasetId: "ds1",
    projectId: PROJECT_ID,
    input: "orig input",
    expected: "orig expected",
    metadata: null,
    review: "ready",
    captureReason: "manual",
    sourceTraceId: null,
    sourceSpanId: null,
    sourceSpanName: null,
    sourceSpanKind: null,
    sourceRunId: null,
    sourceResultId: null,
    addedBy: null,
    createTime: new Date("2026-07-01T00:00:00Z"),
  });

  // A second dataset ds2 @ v1 (empty) — a valid save-new target.
  fakePrisma.dataset.rows.push({ id: "ds2", projectId: PROJECT_ID, currentVersionId: "dv2" });
  fakePrisma.datasetVersion.rows.push({
    id: "dv2",
    datasetId: "ds2",
    projectId: PROJECT_ID,
    versionNumber: 1,
    label: "v1",
  });

  // A run against ds1, and a result mapped to case "tc-A".
  fakePrisma.evaluationRun.rows.push({
    id: "run1",
    projectId: PROJECT_ID,
    datasetId: "ds1",
    evaluationId: "eval1",
  });
  fakePrisma.evaluationResult.rows.push({
    id: "res1",
    runId: "run1",
    projectId: PROJECT_ID,
    testCaseId: "tc-A",
    traceId: "trace-xyz",
    input: "orig input",
    expectedOutput: "orig expected",
    candidateOutput: "the CANDIDATE answer",
  });
});

describe("result → dataset: update_existing_case", () => {
  it("updates the originating case in place, publishes a new version, no duplicate", async () => {
    const res = await POST(
      req({ action: "update_existing_case", expected: "revised expected" }),
      params("res1"),
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.test_case_id).toBe("tc-A"); // stable logical id preserved
    expect(body.version_number).toBe(2); // a NEW immutable version

    const newVersion = currentVersionId("ds1");
    const cases = casesIn(newVersion);
    expect(cases).toHaveLength(1); // updated, not duplicated
    expect(cases[0].testCaseId).toBe("tc-A");
    // Values are JSON-encoded on write so their type round-trips on pull.
    expect(cases[0].expected).toBe('"revised expected"');
    expect(cases[0].input).toBe("orig input"); // unsupplied input unchanged
    // The old version's snapshot is untouched (immutability).
    expect(casesIn("dv1")[0].expected).toBe("orig expected");
  });
});

describe("result → dataset: save_new_case", () => {
  it("saves a new case into another dataset with result provenance; candidate never becomes expected", async () => {
    const res = await POST(req({ action: "save_new_case", dataset_id: "ds2" }), params("res1"));
    expect(res.status).toBe(201);
    const cases = casesIn(currentVersionId("ds2"));
    expect(cases).toHaveLength(1);
    const c = cases[0];
    // Candidate output is NEVER the expected output; it isn't stored on the case
    // either — the source run/result links preserve what actually happened.
    expect(c.expected).toBeNull();
    // Result provenance is captured.
    expect(c.sourceRunId).toBe("run1");
    expect(c.sourceResultId).toBe("res1");
    expect(c.sourceTraceId).toBe("trace-xyz");
  });

  it("refuses a save back into the originating dataset (circular) with an actionable 409", async () => {
    const res = await POST(req({ action: "save_new_case", dataset_id: "ds1" }), params("res1"));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toMatch(/update_existing_case/);
    // No new version was published on ds1.
    expect(currentVersionId("ds1")).toBe("dv1");
  });

  it("copies the candidate into expected ONLY on explicit opt-in", async () => {
    const res = await POST(
      req({ action: "save_new_case", dataset_id: "ds2", use_candidate_as_expected: true }),
      params("res1"),
    );
    expect(res.status).toBe(201);
    const c = casesIn(currentVersionId("ds2"))[0];
    expect(c.expected).toBe('"the CANDIDATE answer"'); // JSON-encoded on write
  });
});

describe("result → dataset: duplicate_as_variant", () => {
  it("adds a second logical case even in the originating dataset, retaining provenance", async () => {
    const res = await POST(
      req({ action: "duplicate_as_variant", dataset_id: "ds1" }),
      params("res1"),
    );
    expect(res.status).toBe(201);
    const cases = casesIn(currentVersionId("ds1"));
    expect(cases).toHaveLength(2); // original tc-A + the new variant
    const variant = cases.find((c) => c.testCaseId !== "tc-A")!;
    expect(variant.testCaseId).not.toBe("tc-A"); // a NEW logical case
    expect(variant.sourceResultId).toBe("res1");
  });
});

describe("result → dataset: idempotency", () => {
  it("a retried request with the same key returns the already-published version", async () => {
    const first = await readJson(
      await POST(
        req({ action: "save_new_case", dataset_id: "ds2", idempotency_key: "k1" }),
        params("res1"),
      ),
    );
    const second = await readJson(
      await POST(
        req({ action: "save_new_case", dataset_id: "ds2", idempotency_key: "k1" }),
        params("res1"),
      ),
    );
    expect(second.version_id).toBe(first.version_id);
    expect(second.replayed).toBe(true);
    // Only one new case exists — the retry did not duplicate.
    expect(casesIn(currentVersionId("ds2"))).toHaveLength(1);
  });
});

describe("result → dataset: guards", () => {
  it("404s an unknown result", async () => {
    expect(
      (await POST(req({ action: "save_new_case", dataset_id: "ds2" }), params("nope"))).status,
    ).toBe(404);
  });
  it("400s save_new_case without a target dataset_id", async () => {
    expect((await POST(req({ action: "save_new_case" }), params("res1"))).status).toBe(400);
  });
});
