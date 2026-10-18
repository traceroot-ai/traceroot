// @vitest-environment jsdom
/**
 * The approved panel's three states, mounted through the real page.
 *
 * Its own file because driving the wait means fake timers, and the rest of the
 * device-page suite leans on testing-library's waitFor, which polls on real
 * ones. The mocks stop at the API client, so the module that decides *which*
 * trace belongs to this run is the real one here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
  device: Object.assign(vi.fn(), { approve: vi.fn(), deny: vi.fn() }),
  getWorkspaces: vi.fn(),
  getProjects: vi.fn(),
  getTraces: vi.fn(),
}));

const WORKSPACE = {
  id: "ws-1",
  name: "Acme",
  role: "ADMIN",
  project_count: 1,
  create_time: "2026-01-01T00:00:00Z",
};

const PROJECT = {
  id: "p-1",
  name: "checkout",
  trace_ttl_days: null,
  create_time: "2026-05-01T09:00:00Z",
};

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/api/workspaces", () => ({
  getWorkspaces: () => mocks.getWorkspaces(),
}));

vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => mocks.getProjects(workspaceId),
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: (projectId: string, key: string, options: unknown, user: unknown) =>
    mocks.getTraces(projectId, key, options, user),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mocks.useSession(),
    signOut: (...args: unknown[]) => mocks.signOut(...args),
    device: mocks.device,
  },
}));

import { DeviceClient } from "../device-client";
import { MAX_BARREN_ROUNDS, POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "../use-first-trace-wait";

const WAITING_TEXT = "Waiting for your first trace. This page opens it when it arrives.";
const TERMINAL_TEXT = "Return to your terminal to finish setting up.";

function trace(traceId: string, startTime: string) {
  return {
    trace_id: traceId,
    project_id: PROJECT.id,
    name: traceId,
    trace_start_time: startTime,
    user_id: null,
    session_id: null,
    span_count: 1,
    duration_ms: 12,
    error_count: 0,
    input: null,
    output: null,
  };
}

/** What the project's trace list answers, swapped between rounds. */
let tracePage: ReturnType<typeof trace>[] = [];

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
    }
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

/**
 * Let `count` further rounds happen. One advance per round: each round only
 * schedules the next one after its own reads have settled, which is exactly the
 * no-overlap property, and it means a single long advance would fire one timer
 * rather than a whole chain.
 */
async function rounds(count: number) {
  for (let round = 0; round < count; round += 1) {
    await advance(POLL_INTERVAL_MS);
  }
}

/** Mount, approve the code, and settle on the approved panel. */
async function approve() {
  render(<DeviceClient />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  searchParams = new URLSearchParams({ user_code: "abcd1234" });
  mocks.useSession.mockReturnValue({
    data: { user: { id: "u-1", email: "kai@example.com", name: "Kai" } },
    isPending: false,
  });
  mocks.getWorkspaces.mockResolvedValue([WORKSPACE]);
  mocks.getProjects.mockResolvedValue([PROJECT]);
  mocks.device.mockResolvedValue({
    data: { user_code: "ABCD1234", status: "pending" },
    error: null,
  });
  mocks.device.approve.mockResolvedValue({ data: { success: true }, error: null });
  tracePage = [];
  mocks.getTraces.mockImplementation(
    async (_projectId: string, _key: string, options: { limit: number }) => ({
      data: tracePage.slice(0, options.limit),
      meta: { page: 0, limit: options.limit, total: tracePage.length },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  searchParams = new URLSearchParams();
  mocks.push.mockReset();
  mocks.useSession.mockReset();
  mocks.signOut.mockReset();
  mocks.device.mockReset();
  mocks.device.approve.mockReset();
  mocks.device.deny.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.getProjects.mockReset();
  mocks.getTraces.mockReset();
});

describe("the approved panel", () => {
  it("says it is approved, points at the terminal, and says it is waiting", async () => {
    await approve();

    expect(screen.getByText("Approved")).toBeDefined();
    expect(screen.getByText(TERMINAL_TEXT)).toBeDefined();
    expect(screen.getByText(WAITING_TEXT)).toBeDefined();
    // Nowhere to send anyone yet: no project is known to hold a trace, and an
    // empty project page reads as a failure.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps pointing at the terminal while it waits", async () => {
    await approve();
    await rounds(3);

    expect(screen.getByText(TERMINAL_TEXT)).toBeDefined();
    expect(screen.getByText(WAITING_TEXT)).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("opens the trace the run produced once it arrives", async () => {
    // The project already held a trace when the wait began, so that one is not
    // the run's and the first round records it as the line to beat.
    tracePage = [trace("t-before", "2026-05-01T10:00:00Z")];
    await approve();
    await rounds(1);
    expect(mocks.push).not.toHaveBeenCalled();

    tracePage = [trace("t-run", "2026-05-01T10:05:00Z"), trace("t-before", "2026-05-01T10:00:00Z")];
    await rounds(1);

    // The only navigation the feature ever performs, and it happens at the very
    // end: one push, to the trace, after it has actually arrived.
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith("/projects/p-1/traces?traceId=t-run");
    expect(screen.getByText("Your first trace arrived. Opening it now...")).toBeDefined();
  });

  it("does not seize a trace that was already there", async () => {
    // The tab knows the account, not the run. A trace that predates the
    // approval belongs to something else the account is already running.
    tracePage = [trace("t-stranger", "2026-05-01T10:00:00Z")];
    await approve();
    await rounds(4);

    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByText(WAITING_TEXT)).toBeDefined();
  });

  it("says so and offers somewhere to go when no trace arrives", async () => {
    await approve();
    await advance(WAIT_BUDGET_MS);

    expect(
      screen.getByText("No trace has arrived yet. Your terminal has the result either way."),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/p-1/traces",
    );
    // The approval is still complete, and the guidance that it hands back to is
    // still the one that matters.
    expect(screen.getByText("Approved")).toBeDefined();
    expect(screen.getByText(TERMINAL_TEXT)).toBeDefined();
    expect(screen.queryByText(WAITING_TEXT)).toBeNull();
    // An empty wait ends in this same panel. It is a link the person may take,
    // not a page they are sent to, so nothing navigates on their behalf here.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("leaves the approval complete when the watch cannot read anything", async () => {
    // A failed watch is not a failed approval. The terminal was released before
    // any of this ran and it stays released.
    mocks.getProjects.mockRejectedValue(new Error("offline"));
    mocks.getTraces.mockRejectedValue(new Error("offline"));

    await approve();
    expect(screen.getByText("Approved")).toBeDefined();
    expect(screen.getByText(TERMINAL_TEXT)).toBeDefined();

    await rounds(MAX_BARREN_ROUNDS);

    expect(mocks.device.approve).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(screen.getByText("Approved")).toBeDefined();
    expect(screen.getByText(TERMINAL_TEXT)).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
    // With no project it could name, the way out is the workspace list.
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/workspaces",
    );
  });

  it("never reads a trace list before the code is approved", async () => {
    // Strictly additive means the consent screen is untouched: nothing here may
    // delay, gate or precede the approval itself.
    render(<DeviceClient />);
    await flush();

    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();
    expect(mocks.getProjects).not.toHaveBeenCalled();
    expect(mocks.getTraces).not.toHaveBeenCalled();
  });

  it("stops watching when the tab goes away", async () => {
    const { unmount } = render(<DeviceClient />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await flush();

    const readsBefore = mocks.getProjects.mock.calls.length;
    unmount();
    await rounds(5);

    expect(mocks.getProjects.mock.calls.length).toBe(readsBefore);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("an account with more projects than the watch keeps", () => {
  // Three newer projects and an older one. The cap watches the newest three,
  // so the older one is found only if the terminal's keys point the watch at it.
  const NEWER = ["p-new-1", "p-new-2", "p-new-3"].map((id, i) => ({
    ...PROJECT,
    id,
    name: id,
    create_time: `2026-05-0${i + 2}T09:00:00Z`,
    access_key_count: 1,
  }));
  const LEGACY_ID = "p-legacy";

  /** The legacy project's key count and every project's trace list, swapped between rounds. */
  let legacyKeys = 1;
  let tracesIn: Record<string, ReturnType<typeof trace>[]> = {};

  beforeEach(() => {
    legacyKeys = 1;
    tracesIn = {};
    mocks.getProjects.mockImplementation(async () => [
      ...NEWER,
      {
        ...PROJECT,
        id: LEGACY_ID,
        name: "legacy",
        create_time: "2025-01-01T09:00:00Z",
        access_key_count: legacyKeys,
      },
    ]);
    mocks.getTraces.mockImplementation(
      async (projectId: string, _key: string, options: { limit: number }) => {
        const page = tracesIn[projectId] ?? [];
        return {
          data: page.slice(0, options.limit),
          meta: { page: 0, limit: options.limit, total: page.length },
        };
      },
    );
  });

  it("opens the run's trace in an older project the terminal minted its keys in", async () => {
    tracesIn[LEGACY_ID] = [trace("t-legacy-before", "2026-04-01T10:00:00Z")];
    await approve();
    await flush();
    expect(mocks.getTraces).not.toHaveBeenCalledWith(
      LEGACY_ID,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    // The terminal settles on the older project and mints its two keys there.
    legacyKeys = 3;
    await rounds(1);
    // The project is watched now, but what it already held is not the run's.
    expect(mocks.push).not.toHaveBeenCalled();

    tracesIn[LEGACY_ID] = [
      trace("t-run", "2026-05-01T10:05:00Z"),
      trace("t-legacy-before", "2026-04-01T10:00:00Z"),
    ];
    await rounds(1);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(`/projects/${LEGACY_ID}/traces?traceId=t-run`);
  });

  it("watches only the newest three while no older project gains a key", async () => {
    await approve();
    await flush();
    tracesIn[LEGACY_ID] = [trace("t-elsewhere", "2026-05-01T10:05:00Z")];

    await rounds(3);

    expect(mocks.push).not.toHaveBeenCalled();
    expect(new Set(mocks.getTraces.mock.calls.map(([projectId]) => projectId))).toEqual(
      new Set(NEWER.map((project) => project.id)),
    );
  });
});
