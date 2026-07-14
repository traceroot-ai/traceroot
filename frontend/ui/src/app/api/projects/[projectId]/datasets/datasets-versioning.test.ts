/**
 * Dataset-version immutability (Phase 8).
 *
 * Saving and editing test cases must publish NEW dataset versions, never rewrite
 * a historical snapshot a run may have pinned. Drives the real test-case Route
 * Handlers against the in-memory fake prisma.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

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
import { POST as saveTestCase } from "./[datasetId]/test-cases/route";
import { PATCH as editTestCase } from "./[datasetId]/test-cases/[testCaseId]/route";

const PROJECT_ID = "proj_1";

function req(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof saveTestCase>[0];
}

beforeEach(() => {
  fakePrisma.reset();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1", email: "e@x.com" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: PROJECT_ID } });
  // A dataset with an initial version v1 holding one case.
  fakePrisma.dataset.rows.push({ id: "ds1", projectId: PROJECT_ID, currentVersionId: "dv1" });
  fakePrisma.datasetVersion.rows.push({
    id: "dv1",
    datasetId: "ds1",
    projectId: PROJECT_ID,
    versionNumber: 1,
    label: "v1",
  });
  fakePrisma.testCase.rows.push({
    id: "row1",
    testCaseId: "case-1",
    datasetVersionId: "dv1",
    datasetId: "ds1",
    projectId: PROJECT_ID,
    input: "original input",
    expected: "billing",
    review: "ready",
    captureReason: "manual",
  });
});

const p = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ projectId: PROJECT_ID, datasetId: "ds1", ...extra }),
});

describe("saving a test case publishes a new immutable version", () => {
  it("adds v2 with both cases and leaves v1 untouched", async () => {
    const res = await saveTestCase(
      req({
        input: "new ticket",
        expected: "billing",
        source_trace_id: "tr_x",
        source_span_id: "sp_x",
      }),
      p(),
    );
    expect(res.status).toBe(201);

    // A new version exists; the current pointer moved to it.
    expect(fakePrisma.datasetVersion.rows).toHaveLength(2);
    const v2 = fakePrisma.datasetVersion.rows.find((v) => v.versionNumber === 2)!;
    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    expect(dataset.currentVersionId).toBe(v2.id);

    // v1's rows are unchanged (still exactly the original case).
    const v1Cases = fakePrisma.testCase.rows.filter((c) => c.datasetVersionId === "dv1");
    expect(v1Cases).toHaveLength(1);
    expect(v1Cases[0].input).toBe("original input");

    // v2 snapshots the original case (same stable testCaseId) plus the new one.
    const v2Cases = fakePrisma.testCase.rows.filter((c) => c.datasetVersionId === v2.id);
    expect(v2Cases).toHaveLength(2);
    expect(v2Cases.map((c) => c.testCaseId)).toContain("case-1");
  });

  it("returns the existing case instead of duplicating the same source span", async () => {
    fakePrisma.testCase.rows.push({
      id: "row2",
      testCaseId: "case-dup",
      datasetVersionId: "dv1",
      datasetId: "ds1",
      projectId: PROJECT_ID,
      input: "x",
      sourceTraceId: "tr_dup",
      sourceSpanId: "sp_dup",
      review: "needs_review",
      captureReason: "manual",
    });
    const res = await saveTestCase(
      req({ input: "again", source_trace_id: "tr_dup", source_span_id: "sp_dup" }),
      p(),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.duplicate).toBe(true);
    expect(body.testCaseId).toBe("case-dup");
    // No new version was published.
    expect(fakePrisma.datasetVersion.rows).toHaveLength(1);
  });
});

describe("editing a test case publishes a new version and leaves the old snapshot intact", () => {
  it("edits content in v2 and demotes a ready case to needs_review", async () => {
    const res = await editTestCase(
      req({ expected: "account-management" }),
      p({ testCaseId: "case-1" }),
    );
    expect(res.status).toBe(201);

    // v1's copy of case-1 is unchanged; the new version holds the edit.
    const v1Case = fakePrisma.testCase.rows.find(
      (c) => c.datasetVersionId === "dv1" && c.testCaseId === "case-1",
    )!;
    expect(v1Case.expected).toBe("billing");
    expect(v1Case.review).toBe("ready");

    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const v2Case = fakePrisma.testCase.rows.find(
      (c) => c.datasetVersionId === dataset.currentVersionId && c.testCaseId === "case-1",
    )!;
    expect(v2Case.expected).toBe("account-management");
    expect(v2Case.review).toBe("needs_review"); // content edit demotes ready
  });
});
