import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTraces: vi.fn(),
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: (projectId: string, key: string, options: unknown, user: unknown) =>
    mocks.getTraces(projectId, key, options, user),
}));

import {
  captureTraceBaseline,
  findFirstTrace,
  retryUnknownBaseline,
  traceUrl,
} from "./first-trace";
import type { BaselineEntry } from "./first-trace";
import type { TraceListItem } from "@/types/api";

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
  mocks.getTraces.mockReset();
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
    // Absence from the baseline means "did not exist when the wait began". A
    // failed read must not borrow that meaning.
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
    // The whole point of the baseline: a trace that was already there is not
    // the trace this run produced. It is also why the onboarding page draws a
    // baseline for the project it just created — a create with a name the
    // workspace already uses hands back the existing project (see
    // lib/write-services/projects), traces and all.
    tracesByProject({ "p-1": [trace("t-old", "2026-05-01T10:00:00Z")] });

    const found = await findFirstTrace(
      "p-1",
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
      "p-1",
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
      "p-1",
      new Map<string, BaselineEntry>([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-first" });
  });

  it("lands on the same trace whichever way the page orders two stamped alike", async () => {
    // Which of two rows inside the same millisecond comes back first is the
    // server's business. A deep link that followed it would send two people who
    // ran the same command to two different traces, so the id breaks the tie.
    const tied = [trace("t-b", "2026-05-01T11:00:00Z"), trace("t-a", "2026-05-01T11:00:00Z")];
    const baseline = new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]);

    tracesByProject({ "p-1": tied });
    expect(await findFirstTrace("p-1", baseline, undefined)).toEqual({
      projectId: "p-1",
      traceId: "t-a",
    });

    tracesByProject({ "p-1": [...tied].reverse() });
    expect(await findFirstTrace("p-1", baseline, undefined)).toEqual({
      projectId: "p-1",
      traceId: "t-a",
    });
  });

  it("passes over a row whose start time does not parse rather than calling it the first", async () => {
    // A project with no line to filter against is the ordinary first-run case,
    // and there every row qualifies. An unparseable one then beats every real
    // trace, because no comparison against NaN is ever true.
    tracesByProject({
      "p-1": [trace("t-bad", ""), trace("t-good", "2026-05-01T11:00:00Z")],
    });

    const found = await findFirstTrace(
      "p-1",
      new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-good" });
  });

  it("keeps waiting when the only row it can see has an unparseable start time", async () => {
    tracesByProject({ "p-1": [trace("t-bad", "not a date")] });

    const found = await findFirstTrace(
      "p-1",
      new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
      undefined,
    );

    expect(found).toBeNull();
  });

  it("takes any trace in a project that had none when the wait began", async () => {
    tracesByProject({ "p-1": [trace("t-1", "2026-05-01T11:00:00Z")] });

    const found = await findFirstTrace(
      "p-1",
      new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
      undefined,
    );

    expect(found).toEqual({ projectId: "p-1", traceId: "t-1" });
  });

  it("lets a failed read through rather than reporting that nothing arrived", async () => {
    // Null means the project was read and held nothing new. A search that could
    // not read it is in no position to say that, so the caller hears the error.
    mocks.getTraces.mockRejectedValue(new Error("unauthorized"));

    await expect(
      findFirstTrace(
        "p-1",
        new Map<string, BaselineEntry>([["p-1", { kind: "empty" }]]),
        undefined,
      ),
    ).rejects.toThrow("unauthorized");
  });

  it("will not match in a project whose baseline never settled", async () => {
    // With no line to compare against, the newest trace there could be one that
    // was already present. Better to keep waiting than to open the wrong trace.
    tracesByProject({ "p-1": [trace("t-1", "2026-05-01T11:00:00Z")] });

    const found = await findFirstTrace(
      "p-1",
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
      "p-1",
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
