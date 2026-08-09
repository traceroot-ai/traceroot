/**
 * Run registration (public, API-key authed).
 *
 * The behaviours here are the ones a concurrent registration would otherwise break
 * silently: one lineage per (project, evaluation_name), one run per run_number, and
 * one run per client_run_id however many times the SDK retries. Each race is driven
 * through the real handler against an in-memory prisma that enforces the same three
 * unique indexes Postgres does, injecting the competing row at the moment the real
 * race would land (between our read and our insert).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireApiKeyProject: vi.fn() }));
vi.mock("@/lib/eval/auth", () => auth);

// The store is rebuilt per test, so the module mock hands out a late-bound view of it.
const holder = vi.hoisted(() => ({ prisma: {} as Record<string | symbol, unknown> }));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: new Proxy({}, { get: (_t, prop) => holder.prisma[prop] }) };
});

import { Prisma } from "@traceroot/core";
import { POST } from "./route";

const PROJECT_ID = "proj_1";
const OTHER_PROJECT_ID = "proj_2";
const APP_URL = "https://app.traceroot.test";

type Row = Record<string, any>;
/** Prisma call arguments — the fake reads only the fields the route actually sends. */
type Args = Record<string, any>;

function uniqueViolation(constraint: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${constraint}\``,
    { code: "P2002", clientVersion: "5.22.0", meta: { target: constraint } },
  );
}

/**
 * An in-memory prisma covering exactly what the register transaction touches, with
 * uq_evaluation_project_name, uq_run_client_run_id and uq_run_evaluation_run_number
 * enforced on insert. `hooks` run once, immediately before an insert, and are how a
 * test plants the row a concurrent transaction would have committed by then.
 */
function makeDb() {
  const rows = {
    dataset: [] as Row[],
    datasetVersion: [] as Row[],
    testCase: [] as Row[],
    evaluation: [] as Row[],
    evaluationRun: [] as Row[],
  };
  const hooks = {
    beforeEvaluationCreate: [] as Array<() => void>,
    beforeRunCreate: [] as Array<() => void>,
  };
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  const client: Record<string, any> = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),

    dataset: {
      // The register route resolves the SDK's project-scoped client id, not the PK.
      findUnique: async ({ where }: Args) => {
        const key = where.projectId_clientDatasetId;
        return (
          rows.dataset.find(
            (d) => d.projectId === key.projectId && d.clientDatasetId === key.clientDatasetId,
          ) ?? null
        );
      },
      findFirst: async ({ where }: Args) =>
        rows.dataset.find((d) => d.id === where.id && d.projectId === where.projectId) ?? null,
    },

    datasetVersion: {
      findFirst: async ({ where }: Args) =>
        rows.datasetVersion.find(
          (v) =>
            v.id === where.id && v.datasetId === where.datasetId && v.projectId === where.projectId,
        ) ?? null,
    },

    testCase: {
      count: async ({ where }: Args) =>
        rows.testCase.filter((c) => c.datasetVersionId === where.datasetVersionId).length,
    },

    evaluation: {
      findUnique: async ({ where }: Args) => {
        const key = where.projectId_evaluationKey;
        return (
          rows.evaluation.find(
            (e) => e.projectId === key.projectId && e.evaluationKey === key.evaluationKey,
          ) ?? null
        );
      },
      findFirst: async ({ where, orderBy }: Args) => {
        let matches = rows.evaluation.filter(
          (e) => e.projectId === where.projectId && e.evaluationKey === where.evaluationKey,
        );
        if (orderBy?.createTime === "asc") {
          matches = [...matches].sort((a, b) => a.createTime - b.createTime);
        }
        return matches[0] ?? null;
      },
      create: async ({ data }: Args) => {
        hooks.beforeEvaluationCreate.shift()?.();
        if (
          rows.evaluation.some(
            (e) => e.projectId === data.projectId && e.evaluationKey === data.evaluationKey,
          )
        ) {
          throw uniqueViolation("uq_evaluation_project_key");
        }
        const row = { id: nextId("eval"), createTime: new Date(), ...data };
        rows.evaluation.push(row);
        return row;
      },
    },

    evaluationRun: {
      findUnique: async ({ where }: Args) => {
        const key = where.evaluationId_clientRunId;
        return (
          rows.evaluationRun.find(
            (r) => r.evaluationId === key.evaluationId && r.clientRunId === key.clientRunId,
          ) ?? null
        );
      },
      findFirst: async ({ where, orderBy }: Args) => {
        let matches = rows.evaluationRun.filter(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.projectId === undefined || r.projectId === where.projectId) &&
            (where.evaluationId === undefined || r.evaluationId === where.evaluationId) &&
            (where.clientRunId === undefined || r.clientRunId === where.clientRunId),
        );
        if (orderBy?.runNumber === "desc") {
          matches = [...matches].sort((a, b) => b.runNumber - a.runNumber);
        }
        return matches[0] ?? null;
      },
      create: async ({ data }: Args) => {
        hooks.beforeRunCreate.shift()?.();
        if (
          data.clientRunId != null &&
          rows.evaluationRun.some(
            (r) => r.evaluationId === data.evaluationId && r.clientRunId === data.clientRunId,
          )
        ) {
          throw uniqueViolation("uq_run_client_run_id");
        }
        if (
          rows.evaluationRun.some(
            (r) => r.evaluationId === data.evaluationId && r.runNumber === data.runNumber,
          )
        ) {
          throw uniqueViolation("uq_run_evaluation_run_number");
        }
        const row = { id: nextId("run"), ...data };
        rows.evaluationRun.push(row);
        return row;
      },
    },
  };

  return { client, rows, hooks };
}

let db: ReturnType<typeof makeDb>;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  db = makeDb();
  holder.prisma = db.client;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  auth.requireApiKeyProject.mockResolvedValue({ projectId: PROJECT_ID });

  db.rows.dataset.push({
    id: "ds1",
    clientDatasetId: "ds1",
    projectId: PROJECT_ID,
    currentVersionId: "dv1",
  });
  db.rows.datasetVersion.push({ id: "dv1", datasetId: "ds1", projectId: PROJECT_ID });
  db.rows.datasetVersion.push({ id: "dv2", datasetId: "ds1", projectId: PROJECT_ID });
  db.rows.testCase.push({ id: "tc1", datasetVersionId: "dv1" });
  db.rows.testCase.push({ id: "tc2", datasetVersionId: "dv1" });
  // Another tenant's dataset, reachable only by guessing its id.
  db.rows.dataset.push({
    id: "ds_other",
    clientDatasetId: "ds_other",
    projectId: OTHER_PROJECT_ID,
    currentVersionId: "dv_other",
  });
  db.rows.datasetVersion.push({
    id: "dv_other",
    datasetId: "ds_other",
    projectId: OTHER_PROJECT_ID,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

const body = (extra: Record<string, unknown> = {}) => ({
  evaluation_name: "nightly",
  dataset_id: "ds1",
  candidate_version: "git:4a91c02",
  scorers: [{ name: "exact_match", version: "1" }],
  ...extra,
});

function post(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://api.internal/api/public/evaluation-runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("cross-language evaluation identity (evaluation_key)", () => {
  const py = { sdk_language: "python" };
  const ts = { sdk_language: "typescript" };

  it("groups equivalent Python and TypeScript runs under one evaluation by shared key", async () => {
    const pyRun = await POST(
      post(body({ evaluation_key: "billing-routing", provenance: py })),
    );
    const tsRun = await POST(
      post(body({ evaluation_key: "billing-routing", provenance: ts })),
    );

    expect(pyRun.status).toBe(201);
    expect(tsRun.status).toBe(201);
    const a = await pyRun.json();
    const b = await tsRun.json();
    // One evaluation definition, two distinct runs — the SDK language is provenance,
    // not identity.
    expect(db.rows.evaluation).toHaveLength(1);
    expect(b.evaluation_id).toBe(a.evaluation_id);
    expect(a.run_number).toBe(1);
    expect(b.run_number).toBe(2);
    expect(a.evaluation_run_id).not.toBe(b.evaluation_run_id);
  });

  it("keeps different evaluation keys as separate evaluations", async () => {
    await POST(post(body({ evaluation_key: "billing-routing" })));
    await POST(post(body({ evaluation_key: "refund-routing" })));
    expect(db.rows.evaluation).toHaveLength(2);
  });

  it("keeps the same display name under different explicit keys separate", async () => {
    // Same evaluation_name, different keys → two evaluations (name is a label, not identity).
    await POST(post(body({ evaluation_name: "Routing", evaluation_key: "routing-v1" })));
    await POST(post(body({ evaluation_name: "Routing", evaluation_key: "routing-v2" })));
    expect(db.rows.evaluation).toHaveLength(2);
    expect(db.rows.evaluation.map((e) => e.evaluationKey).sort()).toEqual([
      "routing-v1",
      "routing-v2",
    ]);
  });

  it("falls back to grouping by name for an older SDK that omits the key", async () => {
    // No evaluation_key on either → both key off the name and group (pre-key behavior).
    const first = await POST(post(body()));
    const second = await POST(post(body()));
    const a = await first.json();
    const b = await second.json();
    expect(db.rows.evaluation).toHaveLength(1);
    expect(b.evaluation_id).toBe(a.evaluation_id);
    // The backfilled key equals the display name.
    expect(db.rows.evaluation[0].evaluationKey).toBe("nightly");
  });
});

describe("lineage resolution", () => {
  it("groups same-named registrations into one evaluation with incrementing run numbers", async () => {
    const first = await POST(post(body()));
    const second = await POST(post(body()));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = await first.json();
    const b = await second.json();

    expect(db.rows.evaluation).toHaveLength(1);
    expect(b.evaluation_id).toBe(a.evaluation_id);
    expect(a.run_number).toBe(1);
    expect(b.run_number).toBe(2);
  });

  it("converges on the winner's lineage when a concurrent process creates it first", async () => {
    // The competing transaction commits its evaluation between our findUnique and our
    // create, so our insert is the one that hits uq_evaluation_project_name.
    db.hooks.beforeEvaluationCreate.push(() => {
      db.rows.evaluation.push({
        id: "eval_winner",
        projectId: PROJECT_ID,
        datasetId: "ds1",
        name: "nightly",
        evaluationKey: "nightly",
        mainScoreName: "Score",
        createTime: new Date(),
      });
    });

    const res = await POST(post(body()));

    expect(res.status).toBe(201);
    const payload = await res.json();
    // One lineage, not two: the retry adopted the committed row instead of splitting.
    expect(db.rows.evaluation).toHaveLength(1);
    expect(payload.evaluation_id).toBe("eval_winner");
    expect(db.rows.evaluationRun).toHaveLength(1);
    expect(db.rows.evaluationRun[0].evaluationId).toBe("eval_winner");
  });
});

describe("dataset resolution", () => {
  it("resolves a dataset by its internal id, the same way GET /datasets/{id} does", async () => {
    // pull_dataset resolves an internal id via resolvePublicDataset's PK fallback and
    // stamps it back, so register must resolve identically — a strict client-id-only
    // lookup would 404 an id that pull just accepted (e.g. an internal id from the UI).
    db.rows.dataset.push({
      id: "cmse_internal_pk",
      clientDatasetId: "regression",
      projectId: PROJECT_ID,
      currentVersionId: "dv_reg",
    });
    db.rows.datasetVersion.push({ id: "dv_reg", datasetId: "cmse_internal_pk", projectId: PROJECT_ID });

    const res = await POST(post(body({ dataset_id: "cmse_internal_pk" })));

    expect(res.status).toBe(201);
    expect(db.rows.evaluationRun[0].datasetId).toBe("cmse_internal_pk");
    expect(db.rows.evaluationRun[0].datasetVersionId).toBe("dv_reg");
  });
});

describe("run_number allocation", () => {
  it("reallocates instead of duplicating when a concurrent run takes the number", async () => {
    const seeded = await POST(post(body()));
    const { evaluation_id } = await seeded.json();

    // Our second registration reads max = 1 and goes for 2; a concurrent run commits 2
    // first, so uq_run_evaluation_run_number rejects ours.
    db.hooks.beforeRunCreate.push(() => {
      db.rows.evaluationRun.push({
        id: "run_winner",
        evaluationId: evaluation_id,
        projectId: PROJECT_ID,
        runNumber: 2,
        clientRunId: null,
      });
    });

    const res = await POST(post(body()));

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.run_number).toBe(3);
    const numbers = db.rows.evaluationRun
      .filter((r) => r.evaluationId === evaluation_id)
      .map((r) => r.runNumber)
      .sort();
    expect(numbers).toEqual([1, 2, 3]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("client_run_id idempotency", () => {
  it("returns the original run when the SDK retries after the first call committed", async () => {
    const first = await POST(post(body({ client_run_id: "sdk-run-1" })));
    const second = await POST(post(body({ client_run_id: "sdk-run-1" })));

    const a = await first.json();
    const b = await second.json();
    expect(second.status).toBe(201);
    expect(b.evaluation_run_id).toBe(a.evaluation_run_id);
    expect(b.run_number).toBe(a.run_number);
    expect(db.rows.evaluationRun).toHaveLength(1);
  });

  it("returns the original run — not a 500 — when the retry races the in-flight original", async () => {
    const evaluation = {
      id: "eval_1",
      projectId: PROJECT_ID,
      datasetId: "ds1",
      name: "nightly",
      evaluationKey: "nightly",
      mainScoreName: "Score",
      createTime: new Date(),
    };
    db.rows.evaluation.push(evaluation);
    // The original request commits after our idempotency read missed and before our
    // insert — the exact window a pre-check can never cover.
    db.hooks.beforeRunCreate.push(() => {
      db.rows.evaluationRun.push({
        id: "run_original",
        evaluationId: "eval_1",
        projectId: PROJECT_ID,
        runNumber: 1,
        datasetVersionId: "dv1",
        clientRunId: "sdk-run-1",
      });
    });

    const res = await POST(post(body({ client_run_id: "sdk-run-1" })));

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.evaluation_run_id).toBe("run_original");
    expect(payload.run_number).toBe(1);
    // No second run was written for the same key.
    expect(db.rows.evaluationRun).toHaveLength(1);
  });
});

describe("failure reporting", () => {
  it("logs the cause and returns 500 for an error that is not a lost race", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Prisma.PrismaClientKnownRequestError("FK violated", {
      code: "P2003",
      clientVersion: "5.22.0",
    });
    db.hooks.beforeRunCreate.push(() => {
      throw boom;
    });

    const res = await POST(post(body()));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to register run" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Failed to register"), boom);
    // A non-race failure is reported, not retried.
    expect(db.rows.evaluationRun).toHaveLength(0);
  });
});

describe("run link", () => {
  it("builds run_url from the configured app origin, ignoring spoofed forwarding headers", async () => {
    const res = await POST(
      post(body(), {
        host: "evil.example.com",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "http",
      }),
    );

    const payload = await res.json();
    expect(payload.run_path).toBe(
      `/projects/${PROJECT_ID}/evaluations/${payload.evaluation_run_id}`,
    );
    expect(payload.run_url).toBe(`${APP_URL}${payload.run_path}`);
    expect(payload.run_url).not.toContain("evil.example.com");
  });
});

describe("dataset version pinning and tenant isolation", () => {
  it("pins the dataset's current version when none is supplied", async () => {
    const res = await POST(post(body()));
    await expect(res.json()).resolves.toMatchObject({ dataset_version_id: "dv1" });
    expect(db.rows.evaluationRun[0].caseCount).toBe(2);
  });

  it("honours an explicitly supplied version of the same dataset", async () => {
    const res = await POST(post(body({ dataset_version_id: "dv2" })));
    await expect(res.json()).resolves.toMatchObject({ dataset_version_id: "dv2" });
  });

  it("does not register against another project's dataset", async () => {
    const res = await POST(post(body({ dataset_id: "ds_other" })));
    expect(res.status).toBe(404);
    expect(db.rows.evaluationRun).toHaveLength(0);
  });

  it("rejects a version owned by another project without writing a run", async () => {
    const res = await POST(post(body({ dataset_version_id: "dv_other" })));
    expect(res.status).toBe(400);
    expect(db.rows.evaluationRun).toHaveLength(0);
  });
});

describe("scorer manifest", () => {
  it("stores the SDK's manifest verbatim", async () => {
    const scorers = [
      {
        name: "llm_judge",
        version: "3",
        value_type: "numeric",
        direction: "higher_is_better",
        threshold: 0.8,
        scorer_type: "llm_judge",
        model: "claude-opus-5",
      },
    ];
    await POST(post(body({ scorers })));
    expect(db.rows.evaluationRun[0].scorers).toEqual(scorers);
  });
});
