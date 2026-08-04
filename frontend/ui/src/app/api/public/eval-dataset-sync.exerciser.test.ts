/**
 * Local SDK dataset-authoring + lifecycle contract exerciser.
 *
 * Drives the real public dataset routes (A1–A5) and the new run-lifecycle routes
 * (B1/B3/B4) end to end against the in-memory fake prisma — proving the pieces the
 * SDK's remote paths depend on: client-id idempotency, one-call-one-version
 * publishing, optimistic-concurrency 409s, idempotent republish, the batch cap,
 * additive per-scorer scores, human scores, and the cancelled run status.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  const { fakePrisma } = await import("@/lib/eval/__tests__/fake-prisma");
  return { ...actual, prisma: fakePrisma };
});

import { fakePrisma } from "@/lib/eval/__tests__/fake-prisma";
import { hashApiKey } from "@/lib/api-keys";
import { GET as listDatasets, POST as upsertDataset } from "./datasets/route";
import { PATCH as patchDataset } from "./datasets/[datasetId]/route";
import { POST as publishVersion, GET as listVersions } from "./datasets/[datasetId]/versions/route";
import { POST as completeRun } from "./evaluation-runs/[runId]/complete/route";
import { POST as addScore } from "./evaluation-runs/[runId]/results/[testCaseId]/scores/route";
import { POST as addHumanScore } from "./evaluation-runs/[runId]/results/[testCaseId]/human-score/route";

const API_KEY = "tr-test-key";
const OTHER_KEY = "tr-other-key";
const PROJECT_ID = "proj_1";
const OTHER_PROJECT = "proj_2";

function req(body: unknown, key = API_KEY) {
  return {
    headers: new Headers({ authorization: `Bearer ${key}` }),
    url: "https://x/api/public/datasets",
    json: async () => body,
  } as unknown as Request;
}
function getReq(query = "", key = API_KEY) {
  return {
    headers: new Headers({ authorization: `Bearer ${key}` }),
    url: `https://x/api/public/datasets${query}`,
  } as unknown as Request;
}
async function readJson(res: { json: () => Promise<unknown> }) {
  return res.json() as Promise<Record<string, unknown>>;
}
const dsParams = (datasetId: string) => ({ params: Promise.resolve({ datasetId }) });
const resultParams = (runId: string, testCaseId: string) => ({
  params: Promise.resolve({ runId, testCaseId }),
});

beforeEach(() => {
  fakePrisma.reset();
  fakePrisma.accessKey.rows.push(
    {
      secretHash: hashApiKey(API_KEY),
      projectId: PROJECT_ID,
      expireTime: null,
      project: { deleteTime: null },
    },
    {
      secretHash: hashApiKey(OTHER_KEY),
      projectId: OTHER_PROJECT,
      expireTime: null,
      project: { deleteTime: null },
    },
  );
});

describe("A2: upsert a dataset by client id", () => {
  it("creates once, then returns the existing dataset idempotently", async () => {
    const first = await upsertDataset(req({ dataset_id: "ds_01", name: "billing-routing" }));
    expect(first.status).toBe(201);
    expect(fakePrisma.dataset.rows).toHaveLength(1);

    const again = await upsertDataset(
      req({ dataset_id: "ds_01", name: "billing-routing-renamed" }),
    );
    expect(again.status).toBe(200);
    expect(fakePrisma.dataset.rows).toHaveLength(1); // no duplicate
    expect((await readJson(again)).dataset_id).toBe("ds_01");
  });

  it("lets two projects reuse the same client dataset id (per-project keyspace)", async () => {
    await upsertDataset(req({ dataset_id: "ds_shared", name: "mine" }));
    const res = await upsertDataset(req({ dataset_id: "ds_shared", name: "theirs" }, OTHER_KEY));
    // `clientDatasetId` is unique per project, not globally: the other project creates
    // its OWN dataset under the same id rather than being blocked (or shown it exists).
    expect(res.status).toBe(201);
    expect(fakePrisma.dataset.rows).toHaveLength(2);
  });
});

describe("A4: publish an immutable version from changes", () => {
  beforeEach(async () => {
    await upsertDataset(req({ dataset_id: "ds1", name: "billing" }));
  });

  it("publishes one version and folds upsert/delete over the base", async () => {
    const res = await publishVersion(
      req({
        base_version_id: null,
        changes: [
          { op: "upsert", test_case_id: "tc_1", input: "double charge", expected: "billing" },
          { op: "upsert", test_case_id: "tc_2", input: "where is my order" },
        ],
      }),
      dsParams("ds1"),
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.case_count).toBe(2);
    expect(body.version_number).toBe(1);
    const versionId = body.dataset_version_id as string;

    // Dataset now points at the new version.
    const ds = fakePrisma.dataset.rows.find((d) => d.id === "ds1")!;
    expect(ds.currentVersionId).toBe(versionId);

    // A second publish based on the new version: edit tc_1, delete tc_2, add tc_3.
    const res2 = await publishVersion(
      req({
        base_version_id: versionId,
        changes: [
          { op: "upsert", test_case_id: "tc_1", input: "double charge", expected: "refunds" },
          { op: "delete", test_case_id: "tc_2" },
          { op: "upsert", test_case_id: "tc_3", input: "cancel please" },
        ],
      }),
      dsParams("ds1"),
    );
    expect(res2.status).toBe(201);
    const body2 = await readJson(res2);
    expect(body2.case_count).toBe(2); // tc_1 (edited) + tc_3; tc_2 dropped
    const v2 = body2.dataset_version_id as string;
    const v2Cases = fakePrisma.testCase.rows.filter((c) => c.datasetVersionId === v2);
    expect(v2Cases.map((c) => c.testCaseId).sort()).toEqual(["tc_1", "tc_3"]);
    // Stored JSON-encoded (a genuine string is quoted); decodes back to "refunds".
    expect(v2Cases.find((c) => c.testCaseId === "tc_1")!.expected).toBe('"refunds"');
    // The first version still holds its original two cases (immutable).
    expect(fakePrisma.testCase.rows.filter((c) => c.datasetVersionId === versionId)).toHaveLength(
      2,
    );
  });

  it("rejects a stale base_version_id with 409 and the current version", async () => {
    const first = await publishVersion(
      req({ base_version_id: null, changes: [{ op: "upsert", test_case_id: "tc_1", input: "x" }] }),
      dsParams("ds1"),
    );
    const current = (await readJson(first)).dataset_version_id;

    const conflict = await publishVersion(
      req({ base_version_id: null, changes: [{ op: "upsert", test_case_id: "tc_2", input: "y" }] }),
      dsParams("ds1"),
    );
    expect(conflict.status).toBe(409);
    const body = await readJson(conflict);
    expect(body.error).toBe("conflict");
    expect(body.current_version_id).toBe(current);
  });

  it("returns the same version for a retried idempotency_key", async () => {
    const payload = {
      base_version_id: null,
      idempotency_key: "publish-1",
      changes: [{ op: "upsert", test_case_id: "tc_1", input: "x" }],
    };
    const first = await publishVersion(req(payload), dsParams("ds1"));
    expect(first.status).toBe(201);
    const versionId = (await readJson(first)).dataset_version_id;

    const retry = await publishVersion(req(payload), dsParams("ds1"));
    expect(retry.status).toBe(200); // replayed, not created
    expect((await readJson(retry)).dataset_version_id).toBe(versionId);
    expect(fakePrisma.datasetVersion.rows).toHaveLength(1);
  });

  it("rejects an over-cap batch with 413 and the limit", async () => {
    const changes = Array.from({ length: 1001 }, (_, i) => ({
      op: "upsert" as const,
      test_case_id: `tc_${i}`,
      input: "x",
    }));
    const res = await publishVersion(req({ base_version_id: null, changes }), dsParams("ds1"));
    expect(res.status).toBe(413);
    expect((await readJson(res)).limit).toBe(1000);
  });

  it("stores input/expected JSON-encoded so native types round-trip (real SDK payloads)", async () => {
    // The SDK sends native JSON values; the backend must not lose type info. A genuine
    // JSON-looking string must be stored quoted so it is distinguishable from the value.
    await publishVersion(
      req({
        base_version_id: null,
        changes: [
          { op: "upsert", test_case_id: "tc_obj", input: { a: 1, b: [2, 3] } },
          { op: "upsert", test_case_id: "tc_num", input: 42 },
          { op: "upsert", test_case_id: "tc_bool", input: true },
          { op: "upsert", test_case_id: "tc_str", input: "hello" },
          { op: "upsert", test_case_id: "tc_jsonstr", input: "123", expected: "true" },
        ],
      }),
      dsParams("ds1"),
    );
    const stored = (id: string) =>
      fakePrisma.testCase.rows.filter((c) => c.testCaseId === id).at(-1);
    expect(stored("tc_obj")!.input).toBe('{"a":1,"b":[2,3]}');
    expect(stored("tc_num")!.input).toBe("42");
    expect(stored("tc_bool")!.input).toBe("true");
    // Genuine strings are quoted, so "123"/"hello" never read back as a number/JSON.
    expect(stored("tc_str")!.input).toBe('"hello"');
    expect(stored("tc_jsonstr")!.input).toBe('"123"');
    expect(stored("tc_jsonstr")!.expected).toBe('"true"');
  });
});

describe("A1/A5: listing", () => {
  it("lists datasets with a next_cursor when there are more than the limit", async () => {
    fakePrisma.dataset.rows.push(
      { id: "ds_a", projectId: PROJECT_ID, name: "a", updateTime: new Date("2026-01-01") },
      { id: "ds_b", projectId: PROJECT_ID, name: "b", updateTime: new Date("2026-01-02") },
      { id: "ds_c", projectId: PROJECT_ID, name: "c", updateTime: new Date("2026-01-03") },
    );
    const res = await listDatasets(getReq("?limit=2"));
    const body = await readJson(res);
    expect((body.datasets as unknown[]).length).toBe(2);
    expect(body.next_cursor).not.toBeNull();

    const all = await listDatasets(getReq("?limit=50"));
    expect((await readJson(all)).next_cursor).toBeNull();
  });

  it("lists a dataset's versions newest-first with case counts", async () => {
    await upsertDataset(req({ dataset_id: "ds1", name: "billing" }));
    await publishVersion(
      req({ base_version_id: null, changes: [{ op: "upsert", test_case_id: "tc_1", input: "x" }] }),
      dsParams("ds1"),
    );
    const res = await listVersions(getReq("", API_KEY), dsParams("ds1"));
    const body = await readJson(res);
    const versions = body.versions as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0].version_number).toBe(1);
    expect(versions[0].case_count).toBe(1);
    expect(versions[0].is_current).toBe(true);
  });
});

describe("A3: patch dataset metadata", () => {
  it("updates name/description/metadata without touching versions", async () => {
    await upsertDataset(req({ dataset_id: "ds1", name: "billing" }));
    const res = await patchDataset(
      req({ name: "billing-v2", description: "routing tickets" }),
      dsParams("ds1"),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).name).toBe("billing-v2");
    expect(fakePrisma.datasetVersion.rows).toHaveLength(0);
  });
});

describe("B3/B4: additive scores and human scores", () => {
  beforeEach(() => {
    fakePrisma.evaluationResult.rows.push({
      id: "res1",
      runId: "run1",
      evaluationId: "eval1",
      projectId: PROJECT_ID,
      testCaseId: "tc_1",
    });
  });

  it("merges a per-scorer score on (name, version) instead of duplicating", async () => {
    await addScore(
      req({ scorer_name: "helpfulness", scorer_version: "v2", numeric_value: 0.8 }),
      resultParams("run1", "tc_1"),
    );
    await addScore(
      req({ scorer_name: "helpfulness", scorer_version: "v2", numeric_value: 0.95 }),
      resultParams("run1", "tc_1"),
    );
    const scores = fakePrisma.score.rows.filter((s) => s.resultId === "res1");
    expect(scores).toHaveLength(1); // merged
    expect(scores[0].numericValue).toBe(0.95);
  });

  it("records a human score bound to the run + test case", async () => {
    const res = await addHumanScore(
      req({ verdict: "pass", quality: 4, reviewer: "e@x.com" }),
      resultParams("run1", "tc_1"),
    );
    expect(res.status).toBe(201);
    expect(fakePrisma.humanScore.rows).toHaveLength(1);
    expect(fakePrisma.humanScore.rows[0].verdict).toBe("pass");
  });

  it("404s a score for a result that does not exist", async () => {
    const res = await addScore(
      req({ scorer_name: "x", scorer_version: "v1", numeric_value: 1 }),
      resultParams("run1", "missing"),
    );
    expect(res.status).toBe(404);
  });
});

describe("B1: cancelled run status", () => {
  it("accepts cancelled on complete and stamps completedAt", async () => {
    fakePrisma.evaluationRun.rows.push({ id: "run1", projectId: PROJECT_ID, status: "running" });
    const res = await completeRun(req({ status: "cancelled" }), {
      params: Promise.resolve({ runId: "run1" }),
    });
    expect(res.status).toBe(200);
    const run = fakePrisma.evaluationRun.rows.find((r) => r.id === "run1")!;
    expect(run.status).toBe("cancelled");
    expect(run.completedAt).toBeInstanceOf(Date);
  });
});
