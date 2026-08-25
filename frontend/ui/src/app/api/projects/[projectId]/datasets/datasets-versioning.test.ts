/**
 * Dataset-version immutability.
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
import { decodeJsonValue, encodeJsonValue } from "@/lib/eval/json-value";
import { publishDatasetVersion, type TestCaseSeed } from "@/lib/eval/versions";
import { POST as saveTestCase } from "./[datasetId]/test-cases/route";
import { PATCH as editTestCase } from "./[datasetId]/test-cases/[testCaseId]/route";
import { GET as getDataset, DELETE as deleteDataset } from "./[datasetId]/route";

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

const p = (extra: { testCaseId?: string } = {}) => ({
  params: Promise.resolve({ projectId: PROJECT_ID, datasetId: "ds1", testCaseId: "", ...extra }),
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

  it("preserves each copied case's original created date (does not restamp on add)", async () => {
    const original = new Date("2026-01-01T00:00:00.000Z");
    // Give the pre-existing case a known creation time.
    fakePrisma.testCase.rows.find((c) => c.testCaseId === "case-1")!.createTime = original;

    await saveTestCase(req({ input: "new ticket" }), p());

    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const v2Cases = fakePrisma.testCase.rows.filter(
      (c) => c.datasetVersionId === dataset.currentVersionId,
    );
    const copied = v2Cases.find((c) => c.testCaseId === "case-1")!;
    const added = v2Cases.find((c) => c.testCaseId !== "case-1")!;
    // The unchanged case keeps its original "Created" date...
    expect(copied.createTime).toEqual(original);
    // ...while the newly added case is stamped fresh, not restamped to match.
    expect(added.createTime).not.toEqual(original);
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
    expect(decodeJsonValue(v2Case.expected as string)).toBe("account-management");
    expect(v2Case.review).toBe("needs_review"); // content edit demotes ready
  });
});

describe("the stored encoding survives a UI round trip", () => {
  it("keeps a genuine string that looks like a number a string", async () => {
    // As an SDK publish would have written it: JSON-encoded, so "123" is a string.
    fakePrisma.testCase.rows.push({
      id: "row-str",
      testCaseId: "case-str",
      datasetVersionId: "dv1",
      datasetId: "ds1",
      projectId: PROJECT_ID,
      input: encodeJsonValue("123"),
      review: "ready",
      captureReason: "manual",
    });

    // The UI shows it as `123` and saves that text back unchanged.
    await editTestCase(req({ input: "123" }), p({ testCaseId: "case-str" }));

    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const edited = fakePrisma.testCase.rows.find(
      (c) => c.datasetVersionId === dataset.currentVersionId && c.testCaseId === "case-str",
    )!;
    expect(decodeJsonValue(edited.input as string)).toBe("123");
    expect(typeof decodeJsonValue(edited.input as string)).toBe("string");
  });

  it("keeps a structured value structured", async () => {
    fakePrisma.testCase.rows.push({
      id: "row-obj",
      testCaseId: "case-obj",
      datasetVersionId: "dv1",
      datasetId: "ds1",
      projectId: PROJECT_ID,
      input: encodeJsonValue({ question: "why?" }),
      review: "ready",
      captureReason: "manual",
    });

    // The UI shows structured values as pretty JSON and saves the edited JSON.
    await editTestCase(req({ input: '{\n  "question": "how?"\n}' }), p({ testCaseId: "case-obj" }));

    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const edited = fakePrisma.testCase.rows.find(
      (c) => c.datasetVersionId === dataset.currentVersionId && c.testCaseId === "case-obj",
    )!;
    expect(decodeJsonValue(edited.input as string)).toEqual({ question: "how?" });
  });

  it("stores a case added in the UI JSON-encoded, not raw", async () => {
    await saveTestCase(req({ input: "true" }), p());

    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const added = fakePrisma.testCase.rows.find(
      (c) => c.datasetVersionId === dataset.currentVersionId && c.testCaseId !== "case-1",
    )!;
    expect(added.input).toBe('"true"');
    expect(decodeJsonValue(added.input as string)).toBe("true"); // not the boolean
  });
});

describe("reading a version's cases is deterministically ordered", () => {
  it("returns cases in insertion (position) order, not hashed testCaseId order", async () => {
    // Every case a publish writes shares one create_time (CURRENT_TIMESTAMP is the
    // transaction start time), so create_time is never the tiebreaker here. `position`
    // (assigned in SDK/array order at publish) is what fixes the order — the cases come
    // back the way they were added, matching the run-results table.
    //
    // The `position` values below are deliberately chosen so the resulting order differs
    // from EVERY other candidate: the row insertion order, ascending testCaseId, and
    // descending testCaseId all disagree with it — so a green assertion can only mean
    // `position` drove the sort, never a fallback on the content-addressed (hashed) id.
    const tie = new Date("2026-02-02T00:00:00.000Z");
    const position: Record<string, number> = { "case-b": 0, "case-c": 1, "case-a": 2 };
    fakePrisma.testCase.rows.length = 0;
    for (const id of ["case-c", "case-a", "case-b"]) {
      fakePrisma.testCase.rows.push({
        id: `row-${id}`,
        testCaseId: id,
        datasetVersionId: "dv1",
        datasetId: "ds1",
        projectId: PROJECT_ID,
        input: encodeJsonValue(id),
        createTime: tie,
        position: position[id],
        review: "ready",
        captureReason: "manual",
      });
    }

    const res = await getDataset(
      { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<
        typeof getDataset
      >[0],
      p(),
    );
    const body = (await res.json()) as { testCases: { testCaseId: string }[] };
    // position order [b, c, a] — not insertion [c, a, b], not testCaseId asc [a, b, c],
    // not testCaseId desc [c, b, a]. Only `position` yields this exact sequence.
    expect(body.testCases.map((c) => c.testCaseId)).toEqual(["case-b", "case-c", "case-a"]);
  });

  it("assigns position in array order at publish, so the GET returns cases as they were added", async () => {
    // Drive the REAL publish path (`publishDatasetVersion` → `createMany` with
    // `position: index`) against the fake prisma, then read it back through the route.
    // All cases share ONE createTime, as a real publish does. That makes the fallback
    // ordering (createTime then testCaseId) tie on createTime and fall to testCaseId — so
    // only `position` can produce the added order; a broken position stamp can't hide
    // behind a per-row createTime that happens to match insertion order.
    const tie = new Date("2026-02-02T00:00:00.000Z");
    const seed = (testCaseId: string): TestCaseSeed => ({
      testCaseId,
      input: encodeJsonValue(testCaseId),
      expected: null,
      metadata: null,
      review: "ready",
      captureReason: "manual",
      sourceTraceId: null,
      sourceSpanId: null,
      sourceSpanName: null,
      sourceSpanKind: null,
      addedBy: null,
      createTime: tie,
    });

    // The added order is deliberately neither ascending nor descending by testCaseId, so
    // the order the cases come back in can only have come from `position` (the array index
    // stamped at publish), never a fallback on the content-addressed (hashed) testCaseId:
    //   added      [zeta, alpha, mu]   ← what we publish
    //   id asc     [alpha, mu, zeta]
    //   id desc    [zeta, mu, alpha]
    const added = ["zeta", "alpha", "mu"];
    await publishDatasetVersion({
      datasetId: "ds1",
      projectId: PROJECT_ID,
      transform: () => ({ cases: added.map(seed), focusTestCaseId: added[0] }),
    });

    // The publish stamped position = array index onto the new version's rows.
    const dataset = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    const written = fakePrisma.testCase.rows.filter(
      (c) => c.datasetVersionId === dataset.currentVersionId,
    );
    expect(
      [...written]
        .sort((a, b) => (a.position as number) - (b.position as number))
        .map((c) => c.testCaseId),
    ).toEqual(added);

    // The dataset-detail GET returns them in that same added order.
    const res = await getDataset(
      { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<
        typeof getDataset
      >[0],
      p(),
    );
    const body = (await res.json()) as { testCases: { testCaseId: string }[] };
    expect(body.testCases.map((c) => c.testCaseId)).toEqual(added);
  });
});

describe("deleting a dataset", () => {
  const del = () => deleteDataset({} as unknown as Parameters<typeof deleteDataset>[0], p());

  it("removes a dataset that has never been evaluated", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(fakePrisma.dataset.rows).toHaveLength(0);
    expect(fakePrisma.datasetVersion.rows).toHaveLength(0);
    expect(fakePrisma.testCase.rows).toHaveLength(0);
  });

  it("refuses with 409 once a run pinned one of its versions, instead of a 500", async () => {
    fakePrisma.evaluationRun.rows.push({
      id: "run1",
      projectId: PROJECT_ID,
      datasetId: "ds1",
      datasetVersionId: "dv1",
    });

    const res = await del();
    expect(res.status).toBe(409);
    // The pinned snapshot is still there for the run that scored against it.
    expect(fakePrisma.datasetVersion.rows).toHaveLength(1);
    expect(fakePrisma.testCase.rows).toHaveLength(1);
  });
});
