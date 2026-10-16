import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getTraces: vi.fn(),
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => mocks.getProjects(workspaceId),
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: (projectId: string, key: string, options: unknown, user: unknown) =>
    mocks.getTraces(projectId, key, options, user),
}));

import {
  MAX_WATCHED_PROJECTS,
  captureTraceBaseline,
  findFirstTrace,
  readWatchedProjects,
  retryUnknownBaseline,
  traceUrl,
} from "./first-trace";
import type { BaselineEntry } from "./first-trace";
import type { Project, TraceListItem, Workspace } from "@/types/api";

function workspace(id: string): Workspace {
  return { id, name: id, role: "ADMIN", create_time: "2026-01-01T00:00:00Z" };
}

function project(id: string, createTime: string): Project {
  return { id, name: id, trace_ttl_days: null, create_time: createTime };
}

// Only the two fields this module reads are meaningful; the rest is the shape
// GET /projects/{id}/traces actually returns, so a row that works here works there.
function trace(traceId: string, startTime: string): TraceListItem {
  return {
    trace_id: traceId,
    project_id: "p",
    name: traceId,
    trace_start_time: startTime,
    user_id: null,
    session_id: null,
    span_count: 1,
    duration_ms: 1,
    error_count: 0,
    input: null,
    output: null,
  };
}

function tracesByProject(pages: Record<string, TraceListItem[]>) {
  mocks.getTraces.mockImplementation(
    async (projectId: string, _key: string, options: { limit: number }) => {
      const all = pages[projectId] ?? [];
      return {
        data: all.slice(0, options.limit),
        meta: { page: 0, limit: options.limit, total: all.length },
      };
    },
  );
}

afterEach(() => {
  mocks.getProjects.mockReset();
  mocks.getTraces.mockReset();
});

describe("readWatchedProjects", () => {
  it("gathers projects across every workspace, newest created first", async () => {
    mocks.getProjects.mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-1"
        ? [project("old", "2026-01-01T00:00:00Z")]
        : [project("new", "2026-03-01T00:00:00Z")],
    );

    const projects = await readWatchedProjects([workspace("ws-1"), workspace("ws-2")]);

    expect(projects.map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("skips a workspace it cannot list rather than losing the others", async () => {
    // One unreadable workspace must not blind the tab to a trace landing in
    // another — the wait is additive, so a partial read still beats no read.
    mocks.getProjects.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === "ws-1") throw new Error("boom");
      return [project("p-2", "2026-01-01T00:00:00Z")];
    });

    const projects = await readWatchedProjects([workspace("ws-1"), workspace("ws-2")]);

    expect(projects.map((p) => p.id)).toEqual(["p-2"]);
  });

  it("caps how many projects one round will look in, keeping the newest", async () => {
    const many = Array.from({ length: MAX_WATCHED_PROJECTS + 5 }, (_, i) =>
      project(`p-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    mocks.getProjects.mockResolvedValue(many);

    const projects = await readWatchedProjects([workspace("ws-1")]);

    expect(projects).toHaveLength(MAX_WATCHED_PROJECTS);
    expect(projects[0].id).toBe(`p-${MAX_WATCHED_PROJECTS + 4}`);
  });
});

describe("captureTraceBaseline", () => {
  it("records the newest existing trace per project, and null for an empty one", async () => {
    tracesByProject({
      "p-busy": [trace("t-old", "2026-05-01T10:00:00Z")],
      "p-empty": [],
    });

    const baseline = await captureTraceBaseline(["p-busy", "p-empty"], undefined);

    expect(baseline.get("p-busy")).toEqual({ kind: "newest", at: "2026-05-01T10:00:00Z" });
    expect(baseline.get("p-empty")).toEqual({ kind: "empty" });
  });

  it("records a project it could not read as unknown, not as empty", async () => {
    // Absence from the baseline means "did not exist at approval", which is the
    // page's strongest binding. A failed read must not borrow that meaning.
    mocks.getTraces.mockRejectedValue(new Error("boom"));

    const baseline = await captureTraceBaseline(["p-1"], undefined);

    expect(baseline.get("p-1")).toEqual({ kind: "unknown" });
  });
});

describe("retryUnknownBaseline", () => {
  it("settles the entries that failed and leaves the rest untouched", async () => {
    tracesByProject({ "p-late": [trace("t-old", "2026-05-01T10:00:00Z")] });

    const settled = await retryUnknownBaseline(
      new Map<string, BaselineEntry>([
        ["p-done", { kind: "empty" }],
        ["p-late", { kind: "unknown" }],
      ]),
      undefined,
    );

    expect(settled.get("p-done")).toEqual({ kind: "empty" });
    expect(settled.get("p-late")).toEqual({ kind: "newest", at: "2026-05-01T10:00:00Z" });
    // The settled project is not re-read.
    expect(mocks.getTraces).toHaveBeenCalledTimes(1);
  });

  it("reads nothing at all when every entry has settled", async () => {
    const baseline = new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]);

    expect(await retryUnknownBaseline(baseline, undefined)).toBe(baseline);
    expect(mocks.getTraces).not.toHaveBeenCalled();
  });

  it("leaves an entry unknown while the read keeps failing", async () => {
    mocks.getTraces.mockRejectedValue(new Error("boom"));

    const settled = await retryUnknownBaseline(
      new Map<string, BaselineEntry>([["p-1", { kind: "unknown" }]]),
      undefined,
    );

    expect(settled.get("p-1")).toEqual({ kind: "unknown" });
  });
});

describe("findFirstTrace", () => {
  it("finds nothing when the only trace is the one the project already had", async () => {
    // The whole point of the baseline: a pre-existing trace in the same
    // workspace is not the trace this run produced.
    tracesByProject({ "p-1": [trace("t-old", "2026-05-01T10:00:00Z")] });

    const found = await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
      undefined,
    );

    expect(found).toBeNull();
  });

  it("returns a trace that arrived after the baseline", async () => {
    tracesByProject({
      "p-1": [trace("t-new", "2026-05-01T11:00:00Z"), trace("t-old", "2026-05-01T10:00:00Z")],
    });

    const found = await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-new" });
  });

  it("lands on the earliest trace of the run, not the most recent one", async () => {
    // The list arrives newest-first and a run that is already going may have
    // sent several. The first one is the one the person was waiting for.
    tracesByProject({
      "p-1": [
        trace("t-third", "2026-05-01T11:00:30Z"),
        trace("t-second", "2026-05-01T11:00:20Z"),
        trace("t-first", "2026-05-01T11:00:10Z"),
        trace("t-before", "2026-05-01T10:00:00Z"),
      ],
    });

    const found = await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-first" });
  });

  it("prefers a project created after approval over one that already existed", async () => {
    // A project the terminal made is the closest thing to a binding this page
    // has: nothing the SDK sends carries the device code, but a project that
    // did not exist at approval belongs to the run that just authorized.
    tracesByProject({
      "p-fresh": [trace("t-fresh", "2026-05-01T11:00:05Z")],
      "p-known": [trace("t-known", "2026-05-01T11:00:00Z")],
    });

    const found = await findFirstTrace(
      [project("p-known", "2026-01-01T00:00:00Z"), project("p-fresh", "2026-05-01T10:59:00Z")],
      new Map<string, BaselineEntry>([["p-known", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-fresh", traceId: "t-fresh" });
  });

  it("takes any trace in a project that had none when the wait began", async () => {
    tracesByProject({ "p-1": [trace("t-1", "2026-05-01T11:00:00Z")] });

    const found = await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-1" });
  });

  it("keeps looking past a project it cannot read", async () => {
    mocks.getTraces.mockImplementation(async (projectId: string) => {
      if (projectId === "p-broken") throw new Error("boom");
      return {
        data: [trace("t-1", "2026-05-01T11:00:00Z")],
        meta: { page: 0, limit: 10, total: 1 },
      };
    });

    const found = await findFirstTrace(
      [project("p-broken", "2026-02-01T00:00:00Z"), project("p-ok", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([
        ["p-broken", { kind: "empty" }],
        ["p-ok", { kind: "empty" }],
      ]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-ok", traceId: "t-1" });
  });

  it("will not match in a project whose baseline never settled", async () => {
    // With no line to compare against, the newest trace there could be one that
    // was already present. Better to keep waiting than to open the wrong trace.
    tracesByProject({ "p-1": [trace("t-1", "2026-05-01T11:00:00Z")] });

    const found = await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "unknown" }]]),
      undefined,
    );

    expect(found).toBeNull();
    expect(mocks.getTraces).not.toHaveBeenCalled();
  });

  it("reads traces without a start_after, so a skewed browser clock cannot hide them", async () => {
    // The baseline is a server-supplied trace_start_time on both sides of the
    // comparison. Sending a local Date.now() as a lower bound would let a fast
    // clock filter out the very trace the tab is waiting for.
    tracesByProject({ "p-1": [] });

    await findFirstTrace(
      [project("p-1", "2026-01-01T00:00:00Z")],
      new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
      undefined,
    );

    expect(mocks.getTraces).toHaveBeenCalledWith("p-1", "", { page: 0, limit: 10 }, undefined);
  });
});

describe("traceUrl", () => {
  it("builds the dashboard's own trace deep link", () => {
    expect(traceUrl({ projectId: "p-1", traceId: "t-1" })).toBe("/projects/p-1/traces?traceId=t-1");
  });

  it("escapes ids rather than pasting them into the query string", () => {
    expect(traceUrl({ projectId: "p/1", traceId: "t&1" })).toBe(
      "/projects/p%2F1/traces?traceId=t%261",
    );
  });
});
