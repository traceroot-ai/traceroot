import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

type Row = Record<string, unknown> & { projectId: string };
const schedules = new Map<string, Row>();
const role = { current: "MEMBER" };

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      project: {
        findUnique: async () => ({ id: "p1", workspaceId: "ws-1", name: "P", deleteTime: null }),
      },
      workspaceMember: { findUnique: async () => ({ role: role.current }) },
      projectUpdateSchedule: {
        findUnique: async ({ where }: { where: { projectId: string } }) =>
          schedules.get(where.projectId) ?? null,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { projectId: string };
          create: Row;
          update: Row;
        }) => {
          const next = schedules.has(where.projectId)
            ? { ...schedules.get(where.projectId), ...update }
            : create;
          schedules.set(where.projectId, next as Row);
          return next;
        },
      },
      projectUpdateRun: { findFirst: async () => null },
    },
  };
});
vi.mock("@/lib/auth-helpers", () => {
  const json = (body: unknown, status: number) => ({ status, json: async () => body });
  const rank: Record<string, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2 };
  return {
    requireAuth: async () => ({ user: { id: "user-1" } }),
    requireProjectAccess: async (_user: string, _project: string, minRole?: string) => {
      if (minRole !== undefined && rank[role.current] < rank[minRole]) {
        return { error: json({ error: "forbidden" }, 403) };
      }
      return {
        project: { id: "p1", workspaceId: "ws-1", name: "P" },
        membership: { role: role.current },
      };
    },
    errorResponse: (message: string, status: number) => json({ error: message }, status),
    successResponse: (data: unknown, status = 200) => json(data, status),
  };
});
vi.mock("@/lib/demo-workspace", () => ({
  DEMO_VIEWER_FORBIDDEN: "demo",
  isDemoViewer: () => false,
}));

const { GET, PUT } = await import("./route");
const params = { params: Promise.resolve({ projectId: "p1" }) };
const put = (body: unknown) =>
  PUT({ json: async () => body } as never, params) as unknown as Promise<{
    status: number;
    json: () => Promise<Record<string, unknown>>;
  }>;

describe("update schedule route", () => {
  beforeEach(() => {
    schedules.clear();
    role.current = "MEMBER";
  });

  it("returns the defaults, switched off, when nothing is saved", async () => {
    const res = (await GET({} as never, params)) as unknown as {
      json: () => Promise<Record<string, unknown>>;
    };
    expect(await res.json()).toMatchObject({
      configured: false,
      enabled: false,
      frequency: "weekly",
      weekday: 1,
      hour: 9,
      timezone: "UTC",
    });
  });

  it("saves a daily schedule in the project's timezone and schedules the next slot", async () => {
    const res = await put({ frequency: "daily", hour: 7, timezone: "Europe/Berlin" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      frequency: "daily",
      hour: 7,
      timezone: "Europe/Berlin",
    });
    expect(new Date(body.next_slot_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(schedules.get("p1")).toMatchObject({ frequency: "daily", hour: 7 });
  });

  it.each([
    { frequency: "hourly" },
    { frequency: "every_6_hours" },
    { everyMinutes: 15 },
    { frequency: "daily", interval: "1h" },
  ])("rejects anything more frequent than daily: %j", async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(schedules.size).toBe(0);
  });

  it("rejects a bad hour and an unknown timezone", async () => {
    expect((await put({ hour: 24 })).status).toBe(400);
    expect((await put({ timezone: "Nowhere/Land" })).status).toBe(400);
  });

  it("does not let a viewer save", async () => {
    role.current = "VIEWER";
    expect((await put({ frequency: "daily" })).status).toBe(403);
    expect(schedules.size).toBe(0);
  });

  it("keeps the saved values for fields a later save leaves out", async () => {
    await put({ frequency: "daily", hour: 7, timezone: "Europe/Berlin" });
    await put({ hour: 8 });
    expect(schedules.get("p1")).toMatchObject({
      frequency: "daily",
      hour: 8,
      timezone: "Europe/Berlin",
    });
  });

  it("saves the limits and keeps them when a later save leaves them out", async () => {
    await put({ frequency: "daily", runTokenCap: 5000, monthlySpendCapUsd: 3 });
    await put({ hour: 6 });
    expect(schedules.get("p1")).toMatchObject({
      hour: 6,
      runTokenCap: 5000,
      monthlySpendCapUsd: 3,
    });
  });

  it("rejects limits out of range", async () => {
    expect((await put({ runTokenCap: 10 })).status).toBe(400);
    expect((await put({ monthlySpendCapUsd: -5 })).status).toBe(400);
  });

  it("saves code changes settings, keeps them when left out, and rejects a bad repository", async () => {
    await put({ frequency: "daily", codeChangesEnabled: true, codeRepos: ["acme/app"] });
    await put({ hour: 6 });
    expect(schedules.get("p1")).toMatchObject({
      hour: 6,
      codeChangesEnabled: true,
      codeRepos: ["acme/app"],
    });
    expect((await put({ codeRepos: ["not a repo"] })).status).toBe(400);
    expect((await put({ codeChangesEnabled: "yes" })).status).toBe(400);
  });

  it("clears the next slot when turned off", async () => {
    await put({ frequency: "weekly" });
    await put({ frequency: "weekly", enabled: false });
    expect(schedules.get("p1")).toMatchObject({ enabled: false, nextSlotAt: null });
  });
});
