/**
 * The prisma mock below is a scoped store rather than a fixed stub: every read
 * and write goes through the same `where` the handler passed, so a handler that
 * dropped `projectId` from its filter would reach another project's row here
 * exactly as it would in production. That is the tenancy check on these routes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type MockResponse = { status: number; json: () => Promise<unknown> };
type Where = Record<string, unknown>;

const baseAlertRow = {
  id: "alert-1",
  projectId: "proj-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  filters: [{ field: "model_name", op: "=", value: "gpt-4o" }] as unknown,
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  renotify: { mode: "EVERY", intervalMinutes: 60 } as unknown,
  noDataMode: "HOLD",
  status: "ACTIVE",
  severity: "ALERT",
  severityChangedAt: new Date("2026-08-12T10:00:00.000Z") as Date | null,
  alertedAt: new Date("2026-08-12T10:00:00.000Z") as Date | null,
  lastEvaluatedAt: new Date("2026-08-12T10:30:00.000Z") as Date | null,
  nextRunAt: new Date("2026-08-12T10:31:00.000Z") as Date | null,
  lastClaimedAt: new Date("2026-08-12T10:30:00.000Z") as Date | null,
  createTime: new Date("2026-08-01T00:00:00.000Z"),
  updateTime: new Date("2026-08-01T00:00:00.000Z"),
  createdBy: "user-1",
};

type AlertRowStub = typeof baseAlertRow;

const alertRow = (overrides: Partial<AlertRowStub> = {}): AlertRowStub => ({
  ...baseAlertRow,
  ...overrides,
});

const store = new Map<string, AlertRowStub>();

function matches(row: AlertRowStub, where: Where): boolean {
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (typeof where.projectId === "string" && row.projectId !== where.projectId) return false;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  // The resume matches on a set of stopped statuses, not one spelling.
  const status = where.status as { in?: string[] } | undefined;
  if (Array.isArray(status?.in) && !status.in.includes(row.status)) return false;
  const name = where.name as { contains?: string } | undefined;
  if (name?.contains !== undefined && !row.name.toLowerCase().includes(name.contains.toLowerCase()))
    return false;
  return true;
}

const rowsMatching = (where: Where) => [...store.values()].filter((row) => matches(row, where));

const alertFindFirst = vi.fn(async ({ where }: { where: Where }) => {
  const [row] = rowsMatching(where);
  return row === undefined ? null : { ...row };
});

const alertFindMany = vi.fn(
  async ({ where, skip = 0, take = 50 }: { where: Where; skip?: number; take?: number }) =>
    rowsMatching(where)
      .slice(skip, skip + take)
      .map((row) => ({ ...row })),
);

const alertCount = vi.fn(async ({ where }: { where: Where }) => rowsMatching(where).length);

const alertUpdateMany = vi.fn(async ({ where, data }: { where: Where; data: Where }) => {
  const rows = rowsMatching(where);
  for (const row of rows) store.set(row.id, { ...row, ...data });
  return { count: rows.length };
});

const alertDeleteMany = vi.fn(async ({ where }: { where: Where }) => {
  const rows = rowsMatching(where);
  for (const row of rows) store.delete(row.id);
  return { count: rows.length };
});

const alertCreate = vi.fn(async ({ data }: { data: Where }) => {
  const row = { ...alertRow(), ...data, id: `alert-${store.size + 1}` } as AlertRowStub;
  store.set(row.id, row);
  return { ...row };
});

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      alert: {
        findFirst: alertFindFirst,
        findMany: alertFindMany,
        count: alertCount,
        create: alertCreate,
        updateMany: alertUpdateMany,
        deleteMany: alertDeleteMany,
      },
      user: { findMany: async () => [{ id: "user-1", name: "Ada", email: "ada@example.com" }] },
      $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
    },
  };
});

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

const { GET: LIST, POST } = await import("./route");
const { GET, PATCH, DELETE } = await import("./[alertId]/route");
const { PATCH: PAUSE } = await import("./[alertId]/pause/route");

const validRule = {
  name: "P99 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p99",
  filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
  window: "10m",
  thresholdOperator: ">",
  threshold: 900,
  renotify: { mode: "OFF" },
};

const request = (body?: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof PATCH>[0];

const alertParams = (alertId = "alert-1", projectId = "proj-1") => ({
  params: Promise.resolve({ projectId, alertId }),
});

const listParams = (projectId = "proj-1") => ({ params: Promise.resolve({ projectId }) });

const post = (body: unknown, projectId?: string) =>
  POST(request(body), listParams(projectId)) as Promise<MockResponse>;
const patch = (body: unknown, alertId?: string) =>
  PATCH(request(body), alertParams(alertId)) as Promise<MockResponse>;
const pause = (status: string, alertId?: string) =>
  PAUSE(request({ status }), alertParams(alertId)) as Promise<MockResponse>;
const remove = (alertId?: string) =>
  DELETE(request(), alertParams(alertId)) as Promise<MockResponse>;
const read = (alertId?: string) => GET(request(), alertParams(alertId)) as Promise<MockResponse>;
const listRequest = (query: string) =>
  ({ nextUrl: new URL(`http://localhost/alerts${query}`) }) as Parameters<typeof LIST>[0];
const list = (query = "") => LIST(listRequest(query), listParams()) as Promise<MockResponse>;

const created = () => alertCreate.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  store.set("alert-1", alertRow());
  // `other-1` belongs to another project and is reachable by id alone: every
  // handler must miss it.
  store.set("other-1", alertRow({ id: "other-1", projectId: "proj-other", name: "Elsewhere" }));
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" }, error: null });
  requireProjectAccessMock.mockResolvedValue({ error: null });
});

describe("an alert id from another project", () => {
  const elsewhere = alertRow({ id: "other-1", projectId: "proj-other", name: "Elsewhere" });

  it("is refused by every handler as missing, which leaves the row exactly as it was", async () => {
    const res = await read("other-1");

    expect(res.status).toBe(404);
    // Missing rather than forbidden: the reply discloses nothing about the row.
    expect(await res.json()).toEqual({ error: "Alert not found" });
    expect((await patch({ name: "Renamed by a stranger" }, "other-1")).status).toBe(404);
    expect((await pause("PAUSED", "other-1")).status).toBe(404);
    expect((await remove("other-1")).status).toBe(404);
    expect(store.get("other-1")).toEqual(elsewhere);
  });

  it("is absent from the list, which is scoped to the project", async () => {
    const body = (await (await list()).json()) as {
      data: { id: string }[];
      meta: { total: number };
    };

    expect(body.data.map((row) => row.id)).toEqual(["alert-1"]);
    expect(body.meta.total).toBe(1);
  });
});

it("demands MEMBER on every mutating handler, not mere membership", async () => {
  await post(validRule);
  await patch({ name: "Renamed" });
  await pause("PAUSED");
  await remove();

  expect(requireProjectAccessMock.mock.calls).toEqual(
    Array.from({ length: 4 }, () => ["user-1", "proj-1", "MEMBER"]),
  );
});

describe("PATCH /api/projects/[projectId]/alerts/[alertId]", () => {
  it("applies a rename through a project-scoped write, leaving the evaluation state alone", async () => {
    expect((await patch({ name: "Renamed" })).status).toBe(200);
    expect(store.get("alert-1")?.name).toBe("Renamed");
    expect(store.get("alert-1")?.severity).toBe("ALERT");
    expect(store.get("alert-1")?.lastClaimedAt).not.toBeNull();
    expect(alertUpdateMany.mock.calls[0][0].where).toEqual({ id: "alert-1", projectId: "proj-1" });
  });

  it("resets the alert to a cold start when the rule itself changed", async () => {
    await patch({ threshold: 999 });
    const row = store.get("alert-1");

    expect(row?.threshold).toBe(999);
    expect(row?.severity).toBe("UNKNOWN");
    expect(row?.severityChangedAt).toBeNull();
    expect(row?.alertedAt).toBeNull();
    // Nulling the claim token is what stops an in-flight worker writing back,
    // and the reset reschedules rather than unscheduling: a null nextRunAt
    // sorts last and would leave the edited rule behind every other rule.
    expect(row?.lastClaimedAt).toBeNull();
    expect(row?.nextRunAt).toBeInstanceOf(Date);
  });

  it("resets the alert to a cold start when the no-data mode changes", async () => {
    // Stored state was computed under the old reading of a gap.
    expect((await patch({ noDataMode: "ZERO" })).status).toBe(200);
    const row = store.get("alert-1");

    expect(row?.noDataMode).toBe("ZERO");
    expect(row?.severity).toBe("UNKNOWN");
    expect(row?.severityChangedAt).toBeNull();
    expect(row?.alertedAt).toBeNull();
    expect(row?.lastClaimedAt).toBeNull();
    expect(row?.nextRunAt).toBeInstanceOf(Date);
    expect((await patch({ noDataMode: "SILENT" })).status).toBe(400);
  });

  describe("a parked rule re-arms on the edit that replaces what it was parked on", () => {
    beforeEach(() => {
      store.set("alert-1", alertRow({ status: "PARKED" }));
    });

    it("starts the rule again, cold, when the edit rewrites the rule", async () => {
      expect((await patch({ threshold: 999 })).status).toBe(200);
      const row = store.get("alert-1");

      expect(row?.status).toBe("ACTIVE");
      expect(row?.severity).toBe("UNKNOWN");
      expect(row?.lastClaimedAt).toBeNull();
      expect(row?.nextRunAt).toBeInstanceOf(Date);
    });

    it("counts a renotify edit, which the evaluated rule does not include", async () => {
      // A renotify the worker cannot parse parks the rule too, and this write
      // replaces it with one the schema validated.
      expect((await patch({ renotify: { mode: "OFF" } })).status).toBe(200);

      expect(store.get("alert-1")?.status).toBe("ACTIVE");
    });

    it("leaves it parked on a rename, which changes nothing the evaluator refused", async () => {
      expect((await patch({ name: "Renamed" })).status).toBe(200);
      const row = store.get("alert-1");

      expect(row?.status).toBe("PARKED");
      expect(row?.name).toBe("Renamed");
    });
  });

  it("rejects an empty update rather than issuing a no-op write", async () => {
    expect((await patch({})).status).toBe(400);
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a filter on a field the alerts feature does not declare", async () => {
    const res = await patch({ filters: [{ field: "service_name", op: "=", value: "api" }] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Alerts cannot filter on "service_name"' });
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  describe("the merged rule, not the patch alone, is what must be evaluable", () => {
    const spanFilter = [{ field: "span_kind", op: "=", value: "LLM" }];

    it("refuses a filters-only edit that the stored measure cannot carry", async () => {
      store.set(
        "alert-1",
        alertRow({ measure: "unique_user_ids", aggregation: "uniq", filters: [] }),
      );

      const res = await patch({ filters: spanFilter });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid aggregation for measure" });
      expect(store.get("alert-1")?.filters).toEqual([]);
    });

    it("accepts a filters-only edit that the stored measure can carry", async () => {
      expect((await patch({ filters: spanFilter })).status).toBe(200);
      expect(store.get("alert-1")?.filters).toEqual(spanFilter);
    });

    it("refuses a measure-only edit that the stored filters cannot be carried by", async () => {
      const res = await patch({ measure: "unique_user_ids", aggregation: "uniq" });

      expect(res.status).toBe(400);
      expect(store.get("alert-1")?.measure).toBe("latency");
    });

    it("accepts the same measure edit once the filters are cleared in the same patch", async () => {
      const res = await patch({ measure: "unique_user_ids", aggregation: "uniq", filters: [] });

      expect(res.status).toBe(200);
      expect(store.get("alert-1")?.measure).toBe("unique_user_ids");
      expect(store.get("alert-1")?.filters).toEqual([]);
    });
  });
});

describe("PATCH /api/projects/[projectId]/alerts/[alertId]/pause", () => {
  it("pauses through a project-scoped write, keeping the severity it stopped at", async () => {
    expect((await pause("PAUSED")).status).toBe(200);
    expect(store.get("alert-1")?.status).toBe("PAUSED");
    expect(store.get("alert-1")?.severity).toBe("ALERT");
    expect(alertUpdateMany.mock.calls[0][0].where).toEqual({ id: "alert-1", projectId: "proj-1" });
  });

  it("resumes as a cold start, because the paused gap was never evaluated", async () => {
    store.set("alert-1", alertRow({ status: "PAUSED" }));

    await pause("ACTIVE");
    const row = store.get("alert-1");

    expect(row?.status).toBe("ACTIVE");
    expect(row?.severity).toBe("UNKNOWN");
    expect(row?.severityChangedAt).toBeNull();
    expect(row?.alertedAt).toBeNull();
    expect(row?.lastClaimedAt).toBeNull();
    // The transition is the WHERE, not a prior read the write could race.
    expect(alertUpdateMany.mock.calls[0][0].where).toEqual({
      id: "alert-1",
      projectId: "proj-1",
      status: { in: ["PAUSED", "PARKED"] },
    });
  });

  it("resumes a parked rule the same way, as the operator's retry of it", async () => {
    // The rule stopped on settings the evaluator refused. Starting it again is
    // allowed and honest: if the settings are still unevaluable the next tick
    // parks it again, with the reason.
    store.set("alert-1", alertRow({ status: "PARKED" }));

    expect((await pause("ACTIVE")).status).toBe(200);
    const row = store.get("alert-1");

    expect(row?.status).toBe("ACTIVE");
    expect(row?.severity).toBe("UNKNOWN");
    expect(row?.lastClaimedAt).toBeNull();
    expect(row?.nextRunAt).toBeInstanceOf(Date);
  });

  it("leaves a rule that is already active exactly as it was", async () => {
    // A double-click or a retried resume must not cold-start a firing rule:
    // the worker would read the reset as UNKNOWN-to-ALERT and page again.
    expect((await pause("ACTIVE")).status).toBe(200);
    const row = store.get("alert-1");

    expect(row?.status).toBe("ACTIVE");
    expect(row?.severity).toBe("ALERT");
    expect(row?.severityChangedAt).toEqual(baseAlertRow.severityChangedAt);
    expect(row?.alertedAt).toEqual(baseAlertRow.alertedAt);
    expect(row?.lastEvaluatedAt).toEqual(baseAlertRow.lastEvaluatedAt);
    expect(row?.nextRunAt).toEqual(baseAlertRow.nextRunAt);
    expect(row?.lastClaimedAt).toEqual(baseAlertRow.lastClaimedAt);
  });

  it("404s a resume of an id that is missing or in another project", async () => {
    expect((await pause("ACTIVE", "missing")).status).toBe(404);
    expect((await pause("ACTIVE", "other-1")).status).toBe(404);
    expect(store.get("other-1")?.severity).toBe("ALERT");
  });

  it("rejects a status outside the settable pair, PARKED included", async () => {
    expect((await pause("DELETED")).status).toBe(400);
    // Parking is the evaluator's verdict about the stored rule: a client that
    // could ask for it could stop a rule that still runs.
    expect((await pause("PARKED")).status).toBe(400);
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/[projectId]/alerts/[alertId]", () => {
  it("deletes through a project-scoped statement", async () => {
    expect((await remove()).status).toBe(200);
    expect(store.has("alert-1")).toBe(false);
    expect(alertDeleteMany.mock.calls[0][0].where).toEqual({ id: "alert-1", projectId: "proj-1" });
  });

  it("404s on an id that does not exist at all", async () => {
    expect((await remove("missing")).status).toBe(404);
  });
});

describe("POST /api/projects/[projectId]/alerts", () => {
  it("creates the rule under the route's project, not the body's", async () => {
    expect((await post({ ...validRule, projectId: "proj-other" })).status).toBe(201);
    expect(created().projectId).toBe("proj-1");
  });

  it("seeds nextRunAt at the creation time, so the rule is due now and no earlier", async () => {
    // Frozen rather than bracketed: the seeded instant is the assertion, and a
    // rule seeded earlier than now would sort ahead of rules already scheduled.
    const createdAt = new Date("2026-03-04T05:06:07.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(createdAt);

    try {
      await post(validRule);

      expect(created().nextRunAt).toEqual(createdAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a filter the engine could not run, naming the reason where it has one", async () => {
    // An unevaluable filter costs the whole evaluation batch, not just the one
    // alert carrying it, so none of these may reach storage.
    const rejected: [Record<string, unknown>, string | null][] = [
      [{ field: "service_name", op: "=", value: "api" }, 'Alerts cannot filter on "service_name"'],
      // There is no default map key, so a keyless metadata row is not
      // "metadata, any key" — it is a predicate the engine cannot compile.
      [{ field: "metadata", op: "=", value: "acme" }, 'Filter on "metadata" requires a key'],
      // is_root has a two-value domain, so it declares equality and nothing else.
      [
        { field: "is_root", op: "contains", value: "true" },
        'Operator "contains" is not valid for "is_root"',
      ],
      // The evaluator has no set operator and no empty-value predicate.
      [{ field: "model_name", op: "in", value: ["api", "web"] }, null],
      [{ field: "model_name", op: "=", value: "" }, null],
    ];

    for (const [filter, message] of rejected) {
      const res = await post({ ...validRule, filters: [filter] });

      expect(res.status).toBe(400);
      if (message !== null) expect(await res.json()).toEqual({ error: message });
    }
    expect(alertCreate).not.toHaveBeenCalled();
  });

  it("stores a key on the field that takes one and strips it off the field that does not", async () => {
    // The form's row editing can leave a key behind when the field changes away
    // from a keyed one, and the engine refuses a key it did not declare.
    const res = await post({
      ...validRule,
      filters: [
        { field: "metadata", key: "tenant", op: "=", value: "acme" },
        { field: "environment", key: "tenant", op: "=", value: "prod" },
      ],
    });

    expect(res.status).toBe(201);
    expect(created().filters).toEqual([
      { field: "environment", op: "=", value: "prod" },
      { field: "metadata", key: "tenant", op: "=", value: "acme" },
    ]);
  });

  it("refuses a measure or an aggregation the engine could not run", async () => {
    const rejected: [Record<string, unknown>, string][] = [
      [{ measure: "not_a_measure", filters: [] }, "Invalid measure for view"],
      [{ aggregation: "count" }, "Invalid aggregation for measure"],
    ];

    for (const [override, message] of rejected) {
      const res = await post({ ...validRule, ...override });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    }
    expect(alertCreate).not.toHaveBeenCalled();
  });

  it("stores the largest threshold the column can hold and refuses one past it", async () => {
    // The column is Decimal(65,30), so 1e34 is the last value that fits. 1e40
    // previously validated and then raised at the database as an unhandled 500,
    // so the caller saw a server fault for their own input.
    expect((await post({ ...validRule, threshold: 1e34 })).status).toBe(201);
    expect((await post({ ...validRule, threshold: 1e40 })).status).toBe(400);
    expect(alertCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves the no-data mode to the column default when the caller says nothing", async () => {
    expect((await post(validRule)).status).toBe(201);
    expect(created().noDataMode).toBeUndefined();
  });

  it("stores a no-data mode the caller names, and refuses one outside the vocabulary", async () => {
    expect((await post({ ...validRule, noDataMode: "NOTIFY" })).status).toBe(201);
    expect(created().noDataMode).toBe("NOTIFY");
    expect((await post({ ...validRule, noDataMode: "hold" })).status).toBe(400);
    expect((await post({ ...validRule, noDataMode: "IGNORE" })).status).toBe(400);
    expect(alertCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses a renotify shape that contradicts itself instead of stripping it", async () => {
    // Stripping would save a rule the caller never asked for; the payload has
    // no correct silent reading.
    const res = await post({ ...validRule, renotify: { mode: "OFF", intervalMinutes: 30 } });

    expect(res.status).toBe(400);
    expect(alertCreate).not.toHaveBeenCalled();
  });

  describe("a measure evaluated at trace grain", () => {
    const uniqueRule = (filters: unknown[]) => ({
      ...validRule,
      measure: "unique_user_ids",
      aggregation: "uniq",
      filters,
    });

    it("is storable without a filter and refused the moment it carries one", async () => {
      // Span predicates cannot apply to a measure the engine reads at trace grain.
      expect((await post(uniqueRule([]))).status).toBe(201);
      expect(created().measure).toBe("unique_user_ids");

      for (const measure of ["unique_user_ids", "unique_session_ids"]) {
        const res = await post({
          ...uniqueRule([{ field: "span_kind", op: "=", value: "LLM" }]),
          measure,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid aggregation for measure" });
      }
      expect(alertCreate).toHaveBeenCalledTimes(1);
    });

    it("is refused for a metadata filter whose key is only whitespace", async () => {
      // The stored row is a filter as far as anything downstream is concerned:
      // the worker forwards it verbatim and the evaluator refuses any filter on
      // a trace-grain measure, so this rule raises on every tick forever. Only
      // the write gate's completeness test reads a blank key as "no filter".
      const res = await post(
        uniqueRule([{ field: "metadata", key: "   ", op: "=", value: "acme" }]),
      );

      expect(res.status).toBe(400);
      expect(alertCreate).not.toHaveBeenCalled();
    });
  });

  describe("the per-project alert cap", () => {
    const seedAlerts = (projectId: string, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const id = `seed-${projectId}-${i}`;
        store.set(id, alertRow({ id, projectId, name: `Seeded ${i}` }));
      }
    };

    beforeEach(() => {
      // The fixtures seed one rule into proj-1; the cap counts from empty here.
      store.clear();
    });

    it("stores the hundredth rule a project asks for", async () => {
      seedAlerts("proj-1", 99);

      expect((await post(validRule)).status).toBe(201);
      expect(alertCreate).toHaveBeenCalledTimes(1);
    });

    it("refuses the hundred and first with a conflict, storing nothing", async () => {
      seedAlerts("proj-1", 100);

      const res = await post(validRule);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "This project has reached its limit of 100 alerts",
      });
      expect(alertCreate).not.toHaveBeenCalled();
    });

    it("counts one project's rules only, so a full neighbour does not block it", async () => {
      seedAlerts("proj-other", 100);
      seedAlerts("proj-1", 1);

      expect((await post(validRule)).status).toBe(201);
    });
  });
});

describe("GET /api/projects/[projectId]/alerts", () => {
  it("clamps the page and the limit rather than letting `skip` overflow a 32-bit int", async () => {
    const body = (await (await list("?page=99999999")).json()) as { meta: { limit: number } };

    expect(alertFindMany.mock.calls[0][0].skip).toBe(10_000 * body.meta.limit);
    expect(alertFindMany.mock.calls[0][0].skip).toBeLessThan(2 ** 31);

    await list("?limit=5000&page=-3");

    expect(alertFindMany.mock.calls[1][0].take).toBe(200);
    expect(alertFindMany.mock.calls[1][0].skip).toBe(0);
  });

  it("searches within the project only", async () => {
    store.set("alert-2", alertRow({ id: "alert-2", name: "Checkout errors" }));

    const body = (await (await list("?search_query=checkout")).json()) as {
      data: { id: string }[];
    };

    expect(body.data.map((row) => row.id)).toEqual(["alert-2"]);
  });

  describe("the capacity it reports beside the list", () => {
    type ListMeta = { total: number; capacity: { used: number; max: number } };
    const meta = async (query = "") =>
      ((await (await list(query)).json()) as { meta: ListMeta }).meta;

    it("spends no second count when nothing is searched, because the total is the count", async () => {
      // The fixtures leave one rule in proj-1 and one in proj-other.
      expect(await meta()).toEqual({
        page: 0,
        limit: 50,
        total: 1,
        capacity: { used: 1, max: 100 },
      });
      expect(alertCount).toHaveBeenCalledTimes(1);
    });

    it("counts the whole project for the cap while the total counts only the search", async () => {
      // Three matching rules out of a full project, and the 97 that do not
      // match are paused: the cap is blind to both the keyword and the status,
      // exactly as the POST that enforces it is.
      for (let i = 0; i < 100; i += 1) {
        const isMatch = i < 3;
        store.set(
          `seed-${i}`,
          alertRow({
            id: `seed-${i}`,
            name: isMatch ? `Checkout ${i}` : `Latency ${i}`,
            status: isMatch ? "ACTIVE" : "PAUSED",
          }),
        );
      }
      store.delete("alert-1");
      store.set("other-2", alertRow({ id: "other-2", projectId: "proj-other", name: "Checkout" }));

      const body = await meta("?search_query=checkout");

      // A control that compares the total to the cap is enabled here, and the
      // create it opens then 409s.
      expect(body.total).toBe(3);
      expect(body.capacity).toEqual({ used: 100, max: 100 });
    });
  });
});
