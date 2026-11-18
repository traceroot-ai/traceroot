import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const projects = new Map<string, { firstTraceReceiveTime: Date | null }>();
  const tracking: { row: { id: number; startedAt: Date } | null } = { row: null };
  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));
  const prisma = {
    project: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { firstTraceReceiveTime: Date };
        }) => {
          const project = projects.get(where.id);
          if (!project || project.firstTraceReceiveTime !== null) return { count: 0 };
          project.firstTraceReceiveTime = data.firstTraceReceiveTime;
          return { count: 1 };
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
    },
    firstTraceTracking: {
      findUnique: vi.fn(async () => {
        await roundTrip();
        return tracking.row ? { startedAt: tracking.row.startedAt } : null;
      }),
      create: vi.fn(async ({ data }: { data: { id: number; startedAt: Date } }) => {
        await roundTrip();
        if (tracking.row) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        tracking.row = { ...data };
        return tracking.row;
      }),
    },
  };
  return { projects, tracking, prisma };
});
vi.mock("@traceroot/core", () => ({ prisma: db.prisma }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "internal-test-secret" } }));
const { captureServerEvent } = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent }));

import {
  fillFirstTraceReceiveTime,
  firstTraceTrackingStart,
  readFirstTraceReceiveTime,
  resolveFirstTraceReceiveTime,
  startFirstTraceTracking,
} from "./first-trace-backfill";

const START = new Date("2026-11-18T10:00:00.000Z");
const BEFORE_START = new Date("2026-11-18T09:00:00.000Z");
const AFTER_START = new Date("2026-11-18T11:00:00.000Z");
const fetchMock = vi.fn();

/** What the trace store answers for the project's earliest customer span. */
function storeAnswers(receivedAt: Date | null) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ first_trace_receive_time: receivedAt?.toISOString() ?? null }), {
      status: 200,
    }),
  );
}

const project = (firstTraceReceiveTime: Date | null = null) => ({
  id: "proj_old",
  workspaceId: "ws_sam",
  firstTraceReceiveTime,
});

beforeEach(() => {
  db.projects.clear();
  db.projects.set("proj_old", { firstTraceReceiveTime: null });
  db.tracking.row = null;
  db.prisma.project.updateMany.mockClear();
  db.prisma.project.findUnique.mockClear();
  fetchMock.mockReset();
  captureServerEvent.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("readFirstTraceReceiveTime", () => {
  it("asks the trace store's internal route with the internal secret", async () => {
    storeAnswers(BEFORE_START);

    expect(await readFirstTraceReceiveTime("proj_old")).toEqual(BEFORE_START);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/v1/internal/projects/proj_old/first-trace");
    expect(init.headers).toEqual({ "X-Internal-Secret": "internal-test-secret" });
  });

  it("answers null for a project without traces", async () => {
    storeAnswers(null);
    expect(await readFirstTraceReceiveTime("proj_old")).toBeNull();
  });

  it("throws when the trace store does not answer", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(readFirstTraceReceiveTime("proj_old")).rejects.toThrow("status 503");
  });
});

describe("startFirstTraceTracking", () => {
  it("starts recording at the first call and keeps that start", async () => {
    expect(await firstTraceTrackingStart()).toBeNull();

    expect(await startFirstTraceTracking(START)).toEqual(START);
    expect(await startFirstTraceTracking(AFTER_START)).toEqual(START);
    expect(await firstTraceTrackingStart()).toEqual(START);
  });

  it("agrees on one start when two first reports arrive together", async () => {
    const starts = await Promise.all([
      startFirstTraceTracking(START),
      startFirstTraceTracking(AFTER_START),
    ]);

    expect(starts[0]).toEqual(starts[1]);
    expect(db.tracking.row?.startedAt).toEqual(starts[0]);
  });
});

describe("fillFirstTraceReceiveTime", () => {
  it("fills an empty time", async () => {
    expect(await fillFirstTraceReceiveTime("proj_old", BEFORE_START)).toEqual(BEFORE_START);
    expect(db.projects.get("proj_old")?.firstTraceReceiveTime).toEqual(BEFORE_START);
  });

  it("keeps a time recorded in the meantime and returns it", async () => {
    db.projects.set("proj_old", { firstTraceReceiveTime: AFTER_START });

    expect(await fillFirstTraceReceiveTime("proj_old", BEFORE_START)).toEqual(AFTER_START);
  });
});

describe("resolveFirstTraceReceiveTime", () => {
  it("returns a recorded time without asking the trace store", async () => {
    expect(await resolveFirstTraceReceiveTime(project(AFTER_START))).toEqual(AFTER_START);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores a first trace from before recording started, and sends no event", async () => {
    db.tracking.row = { id: 1, startedAt: START };
    storeAnswers(BEFORE_START);

    expect(await resolveFirstTraceReceiveTime(project())).toEqual(BEFORE_START);
    expect(db.projects.get("proj_old")?.firstTraceReceiveTime).toEqual(BEFORE_START);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("stores the trace store's time while recording has not started", async () => {
    storeAnswers(AFTER_START);

    expect(await resolveFirstTraceReceiveTime(project())).toEqual(AFTER_START);
    expect(db.projects.get("proj_old")?.firstTraceReceiveTime).toEqual(AFTER_START);
  });

  it("shows a first trace from after recording started without storing it", async () => {
    // Left for the ingest worker's report, which records it with its event.
    db.tracking.row = { id: 1, startedAt: START };
    storeAnswers(AFTER_START);

    expect(await resolveFirstTraceReceiveTime(project())).toEqual(AFTER_START);
    expect(db.projects.get("proj_old")?.firstTraceReceiveTime).toBeNull();
  });

  it("answers null for a project without traces, writing nothing", async () => {
    storeAnswers(null);

    expect(await resolveFirstTraceReceiveTime(project())).toBeNull();
    expect(db.prisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("answers null for the demo workspace without asking the trace store", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws_sam");

    expect(await resolveFirstTraceReceiveTime(project())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a failed lookup on, writing nothing", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(resolveFirstTraceReceiveTime(project())).rejects.toThrow("fetch failed");
    expect(db.projects.get("proj_old")?.firstTraceReceiveTime).toBeNull();
  });
});
