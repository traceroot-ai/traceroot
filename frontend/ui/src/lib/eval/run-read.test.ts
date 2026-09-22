/**
 * Run-summary read — security and contract properties.
 *
 * The public `read_run` and the agent both reach this one function through the internal
 * route, so the properties a new read surface can get wrong invisibly are pinned here:
 * cross-project isolation, existence leakage, and whether "no data" survives the round
 * trip as null rather than arriving as a confident 0. The retention gate has its own suite.
 */
import { describe, it, expect, vi } from "vitest";

const holder = vi.hoisted(() => ({ prisma: {} as Record<string | symbol, unknown> }));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: new Proxy({}, { get: (_t, prop) => holder.prisma[prop] }) };
});

import { readRunSummary } from "./run-read";

const OURS = "proj_ours";
const THEIRS = "proj_theirs";

type Row = Record<string, any>;

function run(over: Row = {}): Row {
  return {
    id: "run_1",
    projectId: OURS,
    evaluationId: "eval_1",
    runNumber: 2,
    candidateVersion: "sonnet",
    environment: "evaluation",
    status: "completed",
    datasetId: "ds_internal",
    datasetVersionId: "dv_1",
    caseCount: 2,
    scoredCount: 2,
    taskErrorCount: 0,
    scorerErrorCount: 0,
    scorers: [{ name: "acc", version: "v1" }],
    startedAt: new Date("2026-08-25T00:00:00Z"),
    completedAt: new Date("2026-08-25T00:00:05Z"),
    evaluation: { name: "Billing routing", evaluationKey: "billing-routing" },
    results: [
      {
        status: "passed",
        durationMs: 100,
        cost: null,
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
    ],
    ...over,
  };
}

/** A prisma whose findFirst honours `where.projectId` — the isolation under test. */
function db(rows: Row[]) {
  const calls: Row[] = [];
  const selects: Row[] = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const find = (id: string, projectId: string) =>
    rows.find((r) => r.id === id && r.projectId === projectId);
  const resultsOf = (where: Row): Row[] =>
    (find(where.runId, where.projectId)?.results ?? []).map((r: Row, i: number) => ({
      ...r,
      id: r.id ?? `res_${i}`,
    }));
  return {
    calls,
    selects,
    queries,
    client: {
      evaluationRun: {
        findFirst: async ({ where, select }: Row) => {
          calls.push(where);
          selects.push(select);
          const r = find(where.id, where.projectId);
          if (!r) return null;
          const { results: _results, ...header } = r;
          return header;
        },
      },
      // Derived from each fixture's `results`, so the fixtures stay whole rows while the
      // read aggregates everything in the database.
      evaluationResult: {
        groupBy: async ({ where }: Row) => {
          const counts = new Map<string, number>();
          for (const r of resultsOf(where)) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
          return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
        },
        aggregate: async ({ where }: Row) => {
          const stat = (field: string) => {
            const xs = resultsOf(where)
              .map((r) => r[field])
              .filter((x) => x != null);
            return {
              avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
              n: xs.length,
            };
          };
          const d = stat("durationMs");
          const c = stat("cost");
          return {
            _avg: { durationMs: d.avg, cost: c.avg },
            _count: { durationMs: d.n, cost: c.n },
          };
        },
      },
      // The read's score query, answered from the fixture rows: one row per result and
      // scorer (the declared version, else the highest), then each scorer's sum and counts
      // by kind, with the counts as bigints the way Postgres returns them.
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push({ sql: strings.join("?"), values });
        const [declaredJson, runId, projectId] = values as [string, string, string];
        const declared = new Map(
          (JSON.parse(declaredJson) as Row[]).map((d) => [d.name, d.version]),
        );
        const rank = (s: Row) => (s.scorerVersion === declared.get(s.scorerName) ? 1 : 0);
        const totals = new Map<string, Row>();
        for (const r of resultsOf({ runId, projectId })) {
          const picked = new Map<string, Row>();
          for (const s of r.scores) {
            const cur = picked.get(s.scorerName);
            if (
              !cur ||
              rank(s) > rank(cur) ||
              (rank(s) === rank(cur) && s.scorerVersion > cur.scorerVersion)
            )
              picked.set(s.scorerName, s);
          }
          for (const [name, s] of picked) {
            const t = totals.get(name) ?? {
              name,
              sum: null,
              numeric: BigInt(0),
              booleans: BigInt(0),
              labels: BigInt(0),
            };
            totals.set(name, t);
            if (s.error != null) continue;
            const x =
              s.boolValue != null
                ? Number(s.boolValue)
                : Number.isFinite(s.numericValue)
                  ? s.numericValue
                  : null;
            if (x != null) {
              t.sum = (t.sum ?? 0) + x;
              t.numeric += BigInt(1);
              if (s.boolValue != null) t.booleans += BigInt(1);
            } else if (s.numericValue == null && s.stringValue != null) t.labels += BigInt(1);
          }
        }
        return [...totals.values()];
      },
      dataset: {
        // Keyed on the id as well as the project, so a lookup by the wrong id within the
        // project finds nothing, just as the real query would.
        findFirst: async ({ where }: Row) =>
          where.projectId === OURS && where.id === "ds_internal"
            ? { id: "ds_internal", clientDatasetId: "ds_client_facing" }
            : null,
      },
      // The fixtures are dated runs; an unlimited plan keeps the retention gate out of the
      // properties this suite pins.
      project: {
        findUnique: async () => ({ workspace: { billingPlan: "enterprise" } }),
      },
    },
  };
}

async function readBody(rows: Row[], runId = "run_1") {
  holder.prisma = db(rows).client;
  const result = await readRunSummary({ projectId: OURS, runId });
  if (!result.ok) throw new Error(`expected a body, got ${result.status}`);
  return result.body as Row;
}

const byName = (items: Row[]) => Object.fromEntries(items.map((i) => [i.name, i]));

describe("project isolation", () => {
  it("scopes the run lookup to the resolved project", async () => {
    const d = db([run()]);
    holder.prisma = d.client;
    const result = await readRunSummary({ projectId: OURS, runId: "run_1" });
    expect(result.ok).toBe(true);
    // The guarantee is in the QUERY, not a post-hoc check: a run is never fetched
    // unscoped and then compared, which is the shape that leaks under a refactor.
    expect(d.calls[0]).toMatchObject({ id: "run_1", projectId: OURS });
  });

  it("404s another project's run instead of confirming it exists", async () => {
    holder.prisma = db([run({ projectId: THEIRS })]).client;
    const result = await readRunSummary({ projectId: OURS, runId: "run_1" });
    expect(result).toEqual({ ok: false, status: 404, error: "Evaluation run not found" });
  });

  it("gives an unknown id the identical answer", async () => {
    holder.prisma = db([]).client;
    const result = await readRunSummary({ projectId: OURS, runId: "run_does_not_exist" });
    expect(result).toEqual({ ok: false, status: 404, error: "Evaluation run not found" });
  });
});

describe("response shape", () => {
  it("returns no per-case rows, so the payload is bounded by scorer count", async () => {
    const body = await readBody([run()]);
    expect(body.results).toBeUndefined();
    expect(body.results_truncated).toBeUndefined();
    expect(body.result_count).toBe(1);
  });

  it("exposes the client-facing dataset id, not the internal primary key", async () => {
    const body = await readBody([run()]);
    expect(body.dataset_id).toBe("ds_client_facing");
  });

  it("carries the run's link and no comparison or coverage block", async () => {
    const body = await readBody([run()]);
    expect(body.run_path).toBe(`/projects/${OURS}/evaluations/run_1`);
    expect(body.run_url).toMatch(/\/projects\/proj_ours\/evaluations\/run_1$/);
    expect(body).not.toHaveProperty("comparison");
    expect(body).not.toHaveProperty("coverage");
  });

  it("supplies units from the server for the two stored metrics, and leaves scores unitless", async () => {
    const body = await readBody([run()]);
    for (const s of body.scores) expect(s.unit).toBeNull();
    expect(body.metrics.map((m: Row) => [m.name, m.unit])).toEqual([
      ["duration", "ms"],
      ["cost", "$"],
    ]);
  });

  it("keeps an unobserved metric null rather than zero", async () => {
    // "No cost was derived" and "cost was zero" are different facts. A 0 here would
    // render as a real measurement in any client that formats numbers.
    const body = await readBody([run()]);
    const cost = byName(body.metrics).cost;
    expect(cost.value).toBeNull();
    // The denominator is an observation in its own right, so it stays numeric.
    expect(cost.observed_count).toBe(0);
  });

  it("reports each score as the run's own mean", async () => {
    const score = (scorerName: string, over: Row) => ({
      scorerName,
      scorerVersion: "v1",
      numericValue: null,
      boolValue: null,
      stringValue: null,
      error: null,
      ...over,
    });
    const result = (durationMs: number, scores: Row[]) => ({
      ...run().results[0],
      durationMs,
      scores,
    });
    const body = await readBody([
      run({
        scorers: [
          { name: "acc", version: "v1" },
          { name: "exact", version: "v1" },
        ],
        results: [
          result(100, [score("acc", { numericValue: 1 }), score("exact", { boolValue: true })]),
          result(300, [score("acc", { numericValue: 0.5 }), score("exact", { boolValue: false })]),
          // An errored score is not an observation: it lowers no mean.
          result(200, [score("acc", { error: "judge timed out" })]),
        ],
      }),
    ]);

    expect(byName(body.scores).acc).toEqual({
      name: "acc",
      unit: null,
      direction: "higher_is_better",
      value_type: "numeric",
      value: 0.75,
      observed_count: 2,
    });
    // A boolean scorer's mean is its pass rate.
    expect(byName(body.scores).exact).toMatchObject({
      value_type: "boolean",
      value: 0.5,
      observed_count: 2,
    });
    expect(byName(body.metrics).duration).toMatchObject({ value: 200, observed_count: 3 });
  });

  it("gives every score and metric exactly the published item fields", async () => {
    const body = await readBody([run()]);
    for (const item of [...body.scores, ...body.metrics]) {
      expect(Object.keys(item).sort()).toEqual([
        "direction",
        "name",
        "observed_count",
        "unit",
        "value",
        "value_type",
      ]);
    }
  });
});

describe("query cost", () => {
  it("sums the scores in one query, scoped to the run and its project", async () => {
    const results = Array.from({ length: 1001 }, (_, i) => ({
      ...run().results[0],
      id: `res_${i}`,
      scores: [{ ...run().results[0].scores[0], numericValue: i % 2 }],
    }));
    const d = db([run({ results })]);
    holder.prisma = d.client;
    const result = await readRunSummary({ projectId: OURS, runId: "run_1" });
    if (!result.ok) throw new Error(`expected a body, got ${result.status}`);
    // One statement however many results the run holds, never a page loop.
    expect(d.queries).toHaveLength(1);
    expect(d.queries[0].sql).toMatch(/r\.run_id = \? AND r\.project_id = \?/);
    expect(d.queries[0].values).toEqual(expect.arrayContaining(["run_1", OURS]));
    expect(byName((result.body as Row).scores).acc).toMatchObject({
      observed_count: 1001,
      value: 500 / 1001,
    });
  });

  it("never reads a per-case TEXT column: the summary is bounded by scorer count", async () => {
    // The fake answers whatever is asked, so a response-level test cannot see a query that
    // reads a megabyte of text per case and throws it away. Pin the query itself.
    const d = db([run()]);
    holder.prisma = d.client;
    await readRunSummary({ projectId: OURS, runId: "run_1" });
    const { sql } = d.queries[0];
    for (const column of [
      "candidate_output",
      "input",
      "expected_output",
      "baseline_output",
      "task_error",
      "explanation",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
    // A score's error is TEXT too; the summary only asks whether a row errored.
    expect(sql.match(/\berror\b/g)).toEqual(["error"]);
    expect(sql).toContain("s.error IS NOT NULL");
  });
});
