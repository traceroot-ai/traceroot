// @vitest-environment jsdom
/**
 * Throwaway differential harness: drives the pre-refactor device hook and the
 * post-refactor one through identical scenarios and compares what each one did,
 * not whether each one passed.
 *
 * Recorded per scenario: the full ordered sequence of API calls with arguments,
 * and the hook's reported state after every round. Two implementations that
 * agree on both are indistinguishable to the device page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getTraces: vi.fn(),
  log: [] as string[],
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => {
    mocks.log.push(`getProjects(${workspaceId})`);
    return mocks.getProjects(workspaceId);
  },
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: (projectId: string, key: string, options: { limit: number }, user: unknown) => {
    mocks.log.push(
      `getTraces(${projectId}, limit=${options.limit}, user=${JSON.stringify(user)})`,
    );
    return mocks.getTraces(projectId, key, options, user);
  },
}));

import { useFirstTraceWait as useOld } from "./old-use-first-trace-wait";
import { useFirstTraceWait as useNew } from "@/app/device/use-first-trace-wait";
import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
import type { Project, TraceListItem, Workspace } from "@/types/api";

const WORKSPACES: Workspace[] = [
  { id: "ws-1", name: "Acme", role: "ADMIN", create_time: "2026-01-01T00:00:00Z" },
  { id: "ws-2", name: "Beta", role: "ADMIN", create_time: "2026-01-02T00:00:00Z" },
];
const USER = { id: "u-1", email: "kai@example.com" };

function project(id: string, createTime: string): Project {
  return { id, name: id, trace_ttl_days: null, create_time: createTime };
}

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

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 30; turn += 1) {
      await Promise.resolve();
    }
  });
}

/**
 * One scenario, run against one implementation.
 *
 * `script` is consulted per round so a scenario can change what the API answers
 * between rounds — which is the only way a wait ever reaches a second outcome.
 */
type Scenario = {
  rounds: number;
  /** Set up the API answers for round `n` (0-based). */
  arrange: (round: number) => void;
  /** Unmount after this round, to compare what a departing tab stops doing. */
  unmountAfter?: number;
};

async function run(
  hook: typeof useOld,
  scenario: Scenario,
): Promise<{ calls: string[]; states: string[] }> {
  mocks.log = [];
  const states: string[] = [];
  scenario.arrange(0);
  const { result, unmount } = renderHook(() => hook(true, WORKSPACES, USER));
  await flush();
  states.push(JSON.stringify(result.current));

  for (let round = 1; round <= scenario.rounds; round += 1) {
    if (scenario.unmountAfter === round - 1) {
      unmount();
    }
    scenario.arrange(round);
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    await flush();
    // A state read after unmount is the last one React committed, which is
    // itself part of what we are comparing.
    states.push(JSON.stringify(result.current));
  }
  unmount();
  return { calls: [...mocks.log], states };
}

/** Run one scenario against both implementations and compare the recordings. */
async function compare(name: string, scenario: Scenario) {
  const before = await run(useOld, scenario);
  cleanup();
  const after = await run(useNew, scenario);
  cleanup();
  expect({ name, ...after }).toEqual({ name, ...before });
  return before;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.log = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.getProjects.mockReset();
  mocks.getTraces.mockReset();
});

describe("device wait: pre-refactor vs post-refactor", () => {
  it("agrees on a run whose trace arrives in a project that already had one", async () => {
    const recorded = await compare("arrival", {
      rounds: 3,
      arrange: (round) => {
        mocks.getProjects.mockImplementation(async (ws: string) =>
          ws === "ws-1" ? [project("p-1", "2026-05-01T09:00:00Z")] : [],
        );
        const page =
          round < 2
            ? [trace("t-before", "2026-05-01T10:00:00Z")]
            : [trace("t-run", "2026-05-01T10:05:00Z"), trace("t-before", "2026-05-01T10:00:00Z")];
        mocks.getTraces.mockImplementation(async (_p: string, _k: string, o: { limit: number }) => ({
          data: page.slice(0, o.limit),
          meta: { page: 0, limit: o.limit, total: page.length },
        }));
      },
    });
    // Guard against a vacuous pass: the scenario has to actually reach a trace.
    expect(recorded.states.at(-1)).toContain("t-run");
  });

  it("agrees on which project a trace is attributed to when one is brand new", async () => {
    // The device page's only real binding, and the piece that moved into
    // `watchOrder`. A project absent from the baseline must still win.
    const recorded = await compare("ordering", {
      rounds: 3,
      arrange: (round) => {
        mocks.getProjects.mockImplementation(async (ws: string) =>
          ws === "ws-1"
            ? [project("p-known", "2026-01-01T00:00:00Z")]
            : round < 1
              ? []
              : [project("p-fresh", "2026-05-01T10:59:00Z")],
        );
        mocks.getTraces.mockImplementation(async (p: string, _k: string, o: { limit: number }) => {
          const page =
            p === "p-fresh"
              ? [trace("t-fresh", "2026-05-01T11:00:05Z")]
              : [trace("t-known", "2026-05-01T11:00:00Z")];
          return { data: page.slice(0, o.limit), meta: { page: 0, limit: o.limit, total: 1 } };
        });
      },
    });
    expect(recorded.states.at(-1)).toContain("p-fresh");
  });

  it("agrees when the account cannot be read at all", async () => {
    const recorded = await compare("barren", {
      rounds: 5,
      arrange: () => {
        mocks.getProjects.mockRejectedValue(new Error("boom"));
        mocks.getTraces.mockResolvedValue({ data: [], meta: { page: 0, limit: 1, total: 0 } });
      },
    });
    expect(recorded.states.at(-1)).toContain("gave-up");
  });

  it("agrees when a baseline read fails and later settles", async () => {
    const recorded = await compare("unknown-baseline", {
      rounds: 4,
      arrange: (round) => {
        mocks.getProjects.mockResolvedValue([project("p-1", "2026-05-01T09:00:00Z")]);
        mocks.getTraces.mockImplementation(async (_p: string, _k: string, o: { limit: number }) => {
          if (round === 0) throw new Error("boom");
          const page = round >= 3 ? [trace("t-run", "2026-05-01T11:00:00Z")] : [];
          return { data: page.slice(0, o.limit), meta: { page: 0, limit: o.limit, total: 0 } };
        });
      },
    });
    expect(recorded.calls.length).toBeGreaterThan(4);
  });

  it("agrees on a wait that runs out of budget", async () => {
    const recorded = await compare("budget", {
      rounds: Math.ceil(WAIT_BUDGET_MS / POLL_INTERVAL_MS) + 1,
      arrange: () => {
        mocks.getProjects.mockResolvedValue([project("p-1", "2026-05-01T09:00:00Z")]);
        mocks.getTraces.mockResolvedValue({ data: [], meta: { page: 0, limit: 1, total: 0 } });
      },
    });
    expect(recorded.states.at(-1)).toContain("gave-up");
  });

  it("agrees on what a tab that leaves mid-round stops doing", async () => {
    // The property the first extraction lost, and the reason the generic
    // `unmountAfter` above cannot see it: unmounting between rounds leaves
    // nothing in flight to abandon. This holds the round open at its first
    // await, unmounts underneath it, and then counts the reads each
    // implementation still goes on to issue.
    async function readsAfterLeaving(hook: typeof useOld): Promise<string[]> {
      mocks.log = [];
      let releaseProjects: (() => void) | undefined;
      mocks.getProjects.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseProjects = () => resolve([project("p-1", "2026-05-01T09:00:00Z")]);
          }),
      );
      mocks.getTraces.mockResolvedValue({ data: [], meta: { page: 0, limit: 1, total: 0 } });

      const { unmount } = renderHook(() => hook(true, WORKSPACES, USER));
      await flush();
      // Round one is parked on its first read.
      const beforeLeaving = mocks.log.length;
      unmount();
      releaseProjects?.();
      await flush();
      return mocks.log.slice(beforeLeaving);
    }

    const before = await readsAfterLeaving(useOld);
    cleanup();
    const after = await readsAfterLeaving(useNew);
    cleanup();

    expect(after).toEqual(before);
    // What that sameness actually is, recorded rather than assumed: the
    // pre-refactor hook finishes the workspace loop it was already inside —
    // `readWatchedProjects` has no cancellation check of its own — and then
    // stops before reading a single trace. Both must do exactly that.
    expect(before).toEqual(["getProjects(ws-2)"]);
    expect(after.filter((call) => call.startsWith("getTraces"))).toEqual([]);
  });

  it("agrees on the reads made across several workspaces", async () => {
    const recorded = await compare("fan-out", {
      rounds: 3,
      arrange: () => {
        mocks.getProjects.mockImplementation(async (ws: string) => [
          project(`${ws}-a`, "2026-05-01T09:00:00Z"),
          project(`${ws}-b`, "2026-04-01T09:00:00Z"),
        ]);
        mocks.getTraces.mockResolvedValue({ data: [], meta: { page: 0, limit: 1, total: 0 } });
      },
    });
    // The cap is part of what is being compared: four projects exist, three are
    // watched.
    const watched = new Set(
      recorded.calls.filter((c) => c.startsWith("getTraces")).map((c) => c.split("(")[1].split(",")[0]),
    );
    expect(watched.size).toBe(3);
  });
});
