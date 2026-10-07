/**
 * The evaluation listing reads — scoping, ordering, paging and the filters.
 *
 * These are the reads that make a run id discoverable, so what is pinned here is what a
 * client paging to completion depends on: a stable order, a cursor that means a row in
 * THIS set, and a project boundary no filter can cross.
 */
import { describe, it, expect, vi } from "vitest";

const holder = vi.hoisted(() => ({ prisma: {} as Record<string | symbol, unknown> }));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: new Proxy({}, { get: (_t, prop) => holder.prisma[prop] }) };
});

import { listEvaluationRunsPage, listEvaluationsPage } from "./evaluation-read";

const OURS = "proj_ours";
const THEIRS = "proj_theirs";

type Row = Record<string, any>;

const evaluation = (over: Row = {}): Row => ({
  id: "eval_2",
  projectId: OURS,
  name: "Billing routing",
  evaluationKey: "billing-routing",
  datasetId: "ds_internal",
  createTime: new Date("2026-08-01T00:00:00Z"),
  updateTime: new Date("2026-08-02T00:00:00Z"),
  runs: [],
  ...over,
});

const run = (over: Row = {}): Row => ({
  id: "run_2",
  projectId: OURS,
  evaluationId: "eval_2",
  runNumber: 2,
  candidateVersion: "sonnet",
  environment: "evaluation",
  status: "completed",
  datasetId: "ds_internal",
  datasetVersionId: "dv_1",
  startedAt: new Date("2026-08-25T00:00:00Z"),
  completedAt: new Date("2026-08-25T00:01:00Z"),
  evaluation: { name: "Billing routing", evaluationKey: "billing-routing" },
  ...over,
});

/** Enough of Prisma to answer these two reads: filters, order, cursor and take. */
function db(evaluations: Row[], runs: Row[] = []) {
  const order = (rows: Row[], orderBy: Row | Row[]) => {
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0] as [string, "asc" | "desc"];
        const x = a[field] instanceof Date ? a[field].getTime() : a[field];
        const y = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  const page = (rows: Row[], args: Row) => {
    let out = rows;
    if (args.cursor)
      out = out.slice(out.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0));
    return args.take ? out.slice(0, args.take) : out;
  };
  const model = (rows: Row[]) => ({
    findFirst: async ({ where }: Row) =>
      rows.find((r) => r.id === where.id && r.projectId === where.projectId) ?? null,
    findMany: async (args: Row) => {
      const w = args.where ?? {};
      const matched = rows.filter(
        (r) =>
          r.projectId === w.projectId &&
          (w.evaluationId === undefined || r.evaluationId === w.evaluationId) &&
          (w.status === undefined || r.status === w.status) &&
          (w.name === undefined ||
            String(r.name).toLowerCase().includes(String(w.name.contains).toLowerCase())),
      );
      return page(order(matched, args.orderBy), args).map((r) => {
        // Only the evaluations read selects the nested runs; the runs read has no such key.
        const nested = args.select?.runs;
        if (!nested) return r;
        return {
          ...r,
          _count: { runs: runs.filter((x) => x.evaluationId === r.id).length },
          // Ordered by whatever the read asked for — hardcoding it here would hide a
          // missing sort key in the read itself.
          runs: order(
            runs.filter((x) => x.evaluationId === r.id),
            nested.orderBy,
          ).slice(0, nested.take ?? 1),
        };
      });
    },
  });
  return {
    evaluation: model(evaluations),
    evaluationRun: model(runs),
    dataset: {
      findMany: async ({ where }: Row) =>
        where.id.in
          .filter(() => where.projectId === OURS)
          .map((id: string) => ({
            id,
            clientDatasetId: id === "ds_internal" ? "ds_client" : null,
          })),
    },
  };
}

async function body(fn: () => Promise<any>) {
  const result = await fn();
  if (!result.ok) throw new Error(`expected a body, got ${result.status} ${result.error}`);
  return result.body;
}

describe("listEvaluationsPage", () => {
  it("lists the project's evaluations with the run count and the latest run", async () => {
    holder.prisma = db(
      [evaluation()],
      [run(), run({ id: "run_1", runNumber: 1, startedAt: new Date("2026-08-24T00:00:00Z") })],
    );
    const { evaluations } = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: null, cursor: null, name: null }),
    );

    expect(evaluations).toEqual([
      {
        evaluation_id: "eval_2",
        name: "Billing routing",
        evaluation_key: "billing-routing",
        // The client-facing dataset id, as every dataset read reports it.
        dataset_id: "ds_client",
        run_count: 2,
        latest_run: {
          evaluation_run_id: "run_2",
          run_number: 2,
          status: "completed",
          started_at: "2026-08-25T00:00:00.000Z",
        },
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
      },
    ]);
  });

  it("picks the latest run by the same tiebreaker the runs list uses", async () => {
    // Runs reported in one batch share a timestamp. Without the id tiebreaker, "latest"
    // is whichever row the plan happened to return first.
    const at = new Date("2026-08-25T00:00:00Z");
    holder.prisma = db(
      [evaluation()],
      [
        run({ id: "run_1", runNumber: 1, startedAt: at, status: "failed" }),
        run({ id: "run_3", runNumber: 3, startedAt: at, status: "completed" }),
        run({ id: "run_2", runNumber: 2, startedAt: at, status: "running" }),
      ],
    );
    const { evaluations } = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: null, cursor: null, name: null }),
    );
    expect(evaluations[0].latest_run).toEqual({
      evaluation_run_id: "run_3",
      run_number: 3,
      status: "completed",
      started_at: "2026-08-25T00:00:00.000Z",
    });
  });

  it("reports an evaluation nothing has run yet, with a null latest run", async () => {
    holder.prisma = db([evaluation()], []);
    const { evaluations } = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: null, cursor: null, name: null }),
    );
    expect(evaluations[0]).toMatchObject({ run_count: 0, latest_run: null });
  });

  it("never lists another project's evaluations", async () => {
    holder.prisma = db([evaluation({ id: "eval_theirs", projectId: THEIRS })], []);
    const { evaluations, next_cursor } = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: null, cursor: null, name: null }),
    );
    expect(evaluations).toEqual([]);
    expect(next_cursor).toBeNull();
  });

  it("filters by name, case-insensitively", async () => {
    holder.prisma = db([evaluation(), evaluation({ id: "eval_1", name: "Refund triage" })], []);
    const { evaluations } = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: null, cursor: null, name: "refund" }),
    );
    expect(evaluations.map((e: Row) => e.evaluation_id)).toEqual(["eval_1"]);
  });

  it("pages with an opaque cursor and ends with a null one", async () => {
    const rows = [
      evaluation({ id: "eval_3" }),
      evaluation({ id: "eval_2" }),
      evaluation({ id: "eval_1" }),
    ];
    holder.prisma = db(rows, []);
    const first = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: 2, cursor: null, name: null }),
    );
    expect(first.evaluations.map((e: Row) => e.evaluation_id)).toEqual(["eval_3", "eval_2"]);
    expect(first.next_cursor).toBe("eval_2");

    const second = await body(() =>
      listEvaluationsPage({ projectId: OURS, limit: 2, cursor: first.next_cursor, name: null }),
    );
    expect(second.evaluations.map((e: Row) => e.evaluation_id)).toEqual(["eval_1"]);
    expect(second.next_cursor).toBeNull();
  });

  it("refuses a cursor that names no row in this project", async () => {
    holder.prisma = db([evaluation()], []);
    expect(
      await listEvaluationsPage({
        projectId: OURS,
        limit: null,
        cursor: "eval_theirs",
        name: null,
      }),
    ).toEqual({ ok: false, status: 400, error: "Invalid cursor" });
  });
});

describe("listEvaluationRunsPage", () => {
  const args = { projectId: OURS, limit: null, cursor: null, evaluationId: null, status: null };

  it("lists a project's runs, newest first, with identity and status only", async () => {
    holder.prisma = db(
      [],
      [run(), run({ id: "run_1", runNumber: 1, startedAt: new Date("2026-08-24T00:00:00Z") })],
    );
    const { runs } = await body(() => listEvaluationRunsPage(args));

    expect(runs[0]).toEqual({
      evaluation_run_id: "run_2",
      evaluation_id: "eval_2",
      evaluation_name: "Billing routing",
      evaluation_key: "billing-routing",
      run_number: 2,
      candidate_version: "sonnet",
      environment: "evaluation",
      status: "completed",
      dataset_id: "ds_client",
      dataset_version_id: "dv_1",
      started_at: "2026-08-25T00:00:00.000Z",
      completed_at: "2026-08-25T00:01:00.000Z",
    });
    expect(runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_2", "run_1"]);
    // No counts, means, cost or duration: those are aggregates the run read answers.
    for (const key of ["result_count", "scores", "metrics", "scored_count"]) {
      expect(runs[0]).not.toHaveProperty(key);
    }
  });

  it("leaves completed_at null while a run is still going", async () => {
    holder.prisma = db([], [run({ status: "running", completedAt: null })]);
    const { runs } = await body(() => listEvaluationRunsPage(args));
    expect(runs[0]).toMatchObject({ status: "running", completed_at: null });
  });

  it("filters by evaluation and by status", async () => {
    holder.prisma = db(
      [],
      [run(), run({ id: "run_x", evaluationId: "eval_9", status: "running", completedAt: null })],
    );
    const byEvaluation = await body(() =>
      listEvaluationRunsPage({ ...args, evaluationId: "eval_9" }),
    );
    expect(byEvaluation.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_x"]);

    const byStatus = await body(() => listEvaluationRunsPage({ ...args, status: "completed" }));
    expect(byStatus.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_2"]);
  });

  it("refuses a status outside the published set rather than listing everything", async () => {
    holder.prisma = db([], [run()]);
    expect(await listEvaluationRunsPage({ ...args, status: "finished" })).toEqual({
      ok: false,
      status: 400,
      error: "Invalid status",
    });
  });

  it("never lists another project's runs", async () => {
    holder.prisma = db([], [run({ id: "run_theirs", projectId: THEIRS })]);
    const { runs } = await body(() => listEvaluationRunsPage(args));
    expect(runs).toEqual([]);
  });

  it("clamps an absurd or fractional page size instead of returning everything or nothing", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      run({ id: `run_${String(i).padStart(3, "0")}` }),
    );
    holder.prisma = db([], many);
    const clamped = await body(() => listEvaluationRunsPage({ ...args, limit: 9999 }));
    expect(clamped.runs).toHaveLength(200);
    // A fraction floors, but never to an empty page that would still claim a next one.
    const fractional = await body(() => listEvaluationRunsPage({ ...args, limit: 0.5 }));
    expect(fractional.runs).toHaveLength(1);
    // Absent falls back to the default page rather than to 1.
    const absent = await body(() => listEvaluationRunsPage({ ...args, limit: null }));
    expect(absent.runs).toHaveLength(50);
  });

  it("pages runs to the end, with the row id deciding tied timestamps", async () => {
    // Every run shares a startedAt, so the page boundary is decided by the id tiebreaker
    // alone: without it, a cursor can skip or repeat a row between pages.
    const at = new Date("2026-08-25T00:00:00Z");
    const ids = ["run_5", "run_4", "run_3", "run_2", "run_1"];
    // Stored in the opposite order to the one expected back: with a stable sort, a fixture
    // already in id-desc order would look right even with no tiebreaker at all.
    holder.prisma = db(
      [],
      [...ids].reverse().map((id) => run({ id, startedAt: at })),
    );

    const first = await body(() => listEvaluationRunsPage({ ...args, limit: 2 }));
    expect(first.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_5", "run_4"]);
    expect(first.next_cursor).toBe("run_4");

    const second = await body(() =>
      listEvaluationRunsPage({ ...args, limit: 2, cursor: first.next_cursor }),
    );
    expect(second.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_3", "run_2"]);
    expect(second.next_cursor).toBe("run_2");

    const third = await body(() =>
      listEvaluationRunsPage({ ...args, limit: 2, cursor: second.next_cursor }),
    );
    expect(third.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_1"]);
    expect(third.next_cursor).toBeNull();

    // Every run seen exactly once across the three pages.
    const seen = [...first.runs, ...second.runs, ...third.runs].map(
      (r: Row) => r.evaluation_run_id,
    );
    expect(seen).toEqual(ids);
  });

  it("keeps the filter while paging, so a cursor cannot widen the set", async () => {
    const at = new Date("2026-08-25T00:00:00Z");
    holder.prisma = db(
      [],
      [
        run({ id: "run_1", startedAt: at }),
        run({ id: "run_2", startedAt: at }),
        run({ id: "run_9", evaluationId: "eval_9", startedAt: at }),
        run({ id: "run_3", startedAt: at }),
      ],
    );
    const first = await body(() =>
      listEvaluationRunsPage({ ...args, evaluationId: "eval_2", limit: 2 }),
    );
    expect(first.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_3", "run_2"]);

    const second = await body(() =>
      listEvaluationRunsPage({
        ...args,
        evaluationId: "eval_2",
        limit: 2,
        cursor: first.next_cursor,
      }),
    );
    expect(second.runs.map((r: Row) => r.evaluation_run_id)).toEqual(["run_1"]);
    expect(second.next_cursor).toBeNull();
  });

  it("refuses a cursor that names no run in this project", async () => {
    holder.prisma = db([], [run()]);
    expect(await listEvaluationRunsPage({ ...args, cursor: "run_theirs" })).toEqual({
      ok: false,
      status: 400,
      error: "Invalid cursor",
    });
  });
});
