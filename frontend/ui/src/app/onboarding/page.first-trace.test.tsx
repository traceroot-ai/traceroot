// @vitest-environment jsdom
/**
 * The hand-back step's watch for the first trace, driven through the real page.
 *
 * Its own file because driving the wait means fake timers, and the rest of the
 * onboarding suite leans on testing-library's waitFor, which polls on real
 * ones. The mocks stop at the API client, so the module that decides *which*
 * trace belongs to this run is the real one here — which is the point, because
 * what this page claims over the device page is that the question has only one
 * possible answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
  getWorkspaces: vi.fn(),
  getProjects: vi.fn(),
  getTraces: vi.fn(),
  session: {
    data: { user: { id: "user-1", email: "kai@example.com" } },
    isPending: false,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => mocks.session, signOut: vi.fn() },
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHeaderContent: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  createWorkspace: mocks.createWorkspace,
  createProject: mocks.createProject,
  getWorkspaces: mocks.getWorkspaces,
}));
// Listed so that watching anything beyond the created project would show up as
// a call here. Nothing on this page should ever need it.
vi.mock("@/lib/api/projects", () => ({
  getProjects: (workspaceId: string) => mocks.getProjects(workspaceId),
}));
vi.mock("@/lib/api/traces", () => ({
  getTraces: (projectId: string, key: string, options: unknown, user: unknown) =>
    mocks.getTraces(projectId, key, options, user),
}));

// The manual step embeds the traces page's own walkthrough, whose connected
// pieces have nothing to do with the watch. Stubbed exactly as the rest of the
// onboarding suite stubs them.
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/traces/components/GettingStarted/ApiKeyBlock", () => ({
  ApiKeyBlock: () => <div data-testid="api-key-block" />,
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
import { MAX_UNREADABLE_ROUNDS } from "@/features/onboarding/use-project-trace-wait";
import OnboardingPage from "./page";

function trace(traceId: string, startTime: string) {
  return {
    trace_id: traceId,
    project_id: "proj-1",
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
      // The zero-length advance is for react-query, which settles the workspace
      // lookup on a macrotask; the microtask turn is for the wait's own rounds,
      // which are several awaits deep.
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    }
  });
}

/**
 * Let `count` further rounds happen. One advance per round: each round only
 * schedules the next one after its own reads have settled, so a single long
 * advance would fire one timer rather than a whole chain.
 */
async function rounds(count: number) {
  for (let round = 0; round < count; round += 1) {
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    await flush();
  }
}

/** Mount, create the workspace and project, and settle on the hand-back step. */
async function reachHandback() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <OnboardingPage />
    </QueryClientProvider>,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getWorkspaces.mockResolvedValue([]);
  mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
  mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
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
  mocks.push.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.createProject.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.getProjects.mockReset();
  mocks.getTraces.mockReset();
});

describe("the hand-back step's first-trace watch", () => {
  it("watches the project it just made, and only that one", async () => {
    // The whole of this page's advantage over the device page, which has to
    // approve a terminal before that terminal has picked a project and so ends
    // up watching several and ranking them. Here the id is already in hand.
    await reachHandback();
    await rounds(2);

    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();
    expect(mocks.getProjects).not.toHaveBeenCalled();
    const watched = new Set(mocks.getTraces.mock.calls.map((call) => call[0]));
    expect([...watched]).toEqual(["proj-1"]);
  });

  it("does not count a trace the project already had", async () => {
    // Creating a project is idempotent on its name within a workspace, so a run
    // that lands on a name already in use is handed the existing project back.
    // The first round draws the line; nothing older than it can win.
    tracePage = [trace("t-before", "2026-05-01T10:00:00Z")];
    await reachHandback();
    await rounds(3);

    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();
    expect(screen.queryByText(/Your first trace arrived/)).toBeNull();
  });

  it("opens the trace that arrives", async () => {
    await reachHandback();
    await rounds(1);

    tracePage = [trace("t-run", "2026-05-01T10:05:00Z")];
    await rounds(1);

    // Both waiting pages end the same way: the trace the run was for is what
    // the person lands on, without having to ask for it.
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=t-run");
    // Once. The effect is keyed on the wait object's identity, so a settled
    // wait that re-rendered would push again — and the device-page twin pins
    // this same count for the same reason.
    expect(mocks.push).toHaveBeenCalledTimes(1);
    // The link stays in the arrival line as the way forward if that push is
    // slow or refused, so the state is never a statement with no exit.
    expect(screen.getByText(/Your first trace arrived/)).toBeDefined();
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-run",
    );
  });

  it("carries on once a baseline read that failed comes good", async () => {
    // A blip while the line is being drawn records the project as unreadable,
    // and a project with no line can never match — `findFirstTrace` skips it.
    // The retry is the whole of what keeps a momentary 401 from stranding a run
    // that then goes perfectly.
    mocks.getTraces.mockRejectedValueOnce(new Error("offline"));
    await reachHandback();
    // The first round's read failed; the second retries it and draws the line.
    await rounds(1);
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();

    tracePage = [trace("t-run", "2026-05-01T10:05:00Z")];
    await rounds(1);

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=t-run");
  });

  it("says it could not read, rather than that no trace came, when the reads keep failing", async () => {
    // "Still no trace" is a claim about the run. A tab whose session expired
    // mid-wait is in no position to make it, and spinning out the remaining
    // nine and a half minutes first does not make it any truer.
    mocks.getTraces.mockRejectedValue(new Error("unauthorized"));
    await reachHandback();
    await rounds(MAX_UNREADABLE_ROUNDS);

    expect(screen.getByText(/could not read your traces/)).toBeDefined();
    expect(screen.queryByText(/Still no trace/)).toBeNull();
    // And still a way forward — which for an expired session is also where the
    // sign-in it needs lives.
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("leaves both exits working while it waits", async () => {
    // The watch is additive. It must not become a thing the user has to wait
    // out before they can choose the manual path or leave.
    await reachHandback();
    await rounds(1);
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
    await flush();
    expect(screen.getByText("Set up tracing by hand")).toBeDefined();
    // Still watching on the manual step, where the trace is just as welcome.
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Back to the terminal command" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.push).toHaveBeenCalledWith("/workspaces");
  });

  it("says so, and still points somewhere, when the budget runs out", async () => {
    await reachHandback();
    for (let elapsed = 0; elapsed < WAIT_BUDGET_MS; elapsed += POLL_INTERVAL_MS) {
      await rounds(1);
    }

    expect(screen.getByText(/Still no trace/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("reads nothing at all until the project exists", async () => {
    // Nothing to watch before the form is submitted, and a page the user
    // abandons there has cost the trace API nothing.
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OnboardingPage />
      </QueryClientProvider>,
    );
    await flush();
    await rounds(2);

    expect(mocks.getTraces).not.toHaveBeenCalled();
  });
});
