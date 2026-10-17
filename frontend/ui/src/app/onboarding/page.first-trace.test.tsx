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
  createCliHandoff: vi.fn(),
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
// The hand-back step mints a handoff code for the command it prints. It runs on
// a timer of its own, which these fake timers would otherwise drive into the
// network; the code's own schedule is covered in use-cli-handoff.test.tsx.
vi.mock("@/lib/api/cli-handoff", () => ({
  createCliHandoff: (projectId: string) => mocks.createCliHandoff(projectId),
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
vi.mock("@/features/traces/components/GettingStarted/ModelProviderBlock", () => ({
  ModelProviderBlock: () => <div data-testid="model-provider-block" />,
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
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

/** Document order, so "above" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * The block the frame pins to the top of the viewport: the logo, the "Let's get started"
 * heading, its description and — since the layout fix — the first-trace line.
 * Found from the heading rather than by a class, so it is the block the user
 * sees rather than a selector that happens to match it.
 */
function headerBlock(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Let's get started" });
  return heading.parentElement!.parentElement!;
}

/** Whichever of the three states the line is currently in. */
function traceLine(): HTMLElement {
  const found = screen.queryAllByText(
    /Waiting for your first trace|Your first trace arrived|Still no trace/,
  );
  // One on screen, never two: the steps used to render their own.
  expect(found).toHaveLength(1);
  return found[0]!;
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

/** The same, then on to the manual walkthrough. */
async function reachManual() {
  await reachHandback();
  fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getWorkspaces.mockResolvedValue([]);
  mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
  mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
  mocks.createCliHandoff.mockResolvedValue({
    code: "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABC",
    expiresIn: 600,
    expiresAt: "2026-10-17T18:31:00.000Z",
  });
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
  mocks.createCliHandoff.mockReset();
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
    // The link stays in the arrival line as the way forward if that push is
    // slow or refused, so the state is never a statement with no exit.
    expect(screen.getByText(/Your first trace arrived/)).toBeDefined();
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-run",
    );
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

describe("where the page says the watch stands", () => {
  it("says it once, in the pinned header, on the hand-back step", async () => {
    // The user's own ask: the icon, the heading, the description and this line
    // are one block that does not move, so the line goes up with them rather
    // than sitting inside whichever step is on screen. Asserted through the DOM
    // tree and document order — a class name would not have caught the layout
    // bug this replaced.
    await reachHandback();
    await rounds(1);

    const line = traceLine();
    expect(headerBlock().contains(line)).toBe(true);
    expect(isAbove(screen.getByRole("heading", { name: "Let's get started" }), line)).toBe(true);
    expect(isAbove(line, screen.getByText("Finish setting up in your terminal"))).toBe(true);
  });

  it("keeps it in that same header when the user switches to the manual step", async () => {
    // The switch is what moved it before: the step rendered its own copy, so the
    // line changed place along with everything else on the card.
    await reachManual();
    await rounds(1);

    const line = traceLine();
    expect(headerBlock().contains(line)).toBe(true);
    expect(isAbove(line, screen.getByText("Set up tracing by hand"))).toBe(true);
    // And above the walkthrough's own shared top, which used to hold it.
    expect(isAbove(line, screen.getByText("Select your stack"))).toBe(true);
    expect(isAbove(line, screen.getByText("Use your own model key"))).toBe(true);
  });

  it("is the same node across the switch, not a second one somewhere else", async () => {
    // Both halves of "exactly one": the node survives the step change, and no
    // step contributes one of its own on either side of it.
    await reachHandback();
    await rounds(1);
    const before = traceLine();

    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
    await flush();
    expect(traceLine()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Back to the terminal command" }));
    await flush();
    expect(traceLine()).toBe(before);
  });

  it("holds the slot open before there is anything to say in it", async () => {
    // The line is absent until a project exists. The space it will take is
    // reserved from the first render, so pressing Create does not step the card
    // down — the smaller version of the complaint this layout fix is about.
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OnboardingPage />
      </QueryClientProvider>,
    );
    await flush();

    expect(
      screen.queryByText(/Waiting for your first trace|Your first trace arrived|Still no trace/),
    ).toBeNull();
    const slot = headerBlock().lastElementChild as HTMLElement;
    expect(slot.className).toContain("min-h-[33px]");
    expect(slot.childElementCount).toBe(0);
  });

  it("reports the arrival from the header, with the link to the trace", async () => {
    await reachHandback();
    await rounds(1);
    tracePage = [trace("t-run", "2026-05-01T10:05:00Z")];
    await rounds(1);

    const line = traceLine();
    expect(line.textContent).toContain("Your first trace arrived");
    expect(headerBlock().contains(line)).toBe(true);
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-run",
    );
  });

  it("reports the arrival from the header on the manual step too", async () => {
    await reachManual();
    await rounds(1);
    tracePage = [trace("t-manual", "2026-05-01T10:05:00Z")];
    await rounds(1);

    const line = traceLine();
    expect(line.textContent).toContain("Your first trace arrived");
    expect(headerBlock().contains(line)).toBe(true);
    expect(isAbove(line, screen.getByText("Set up tracing by hand"))).toBe(true);
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-manual",
    );
  });

  it("reports an empty wait from the header, on whichever step is open", async () => {
    await reachManual();
    for (let elapsed = 0; elapsed < WAIT_BUDGET_MS; elapsed += POLL_INTERVAL_MS) {
      await rounds(1);
    }

    const line = traceLine();
    expect(line.textContent).toContain("Still no trace");
    expect(headerBlock().contains(line)).toBe(true);
    expect(isAbove(line, screen.getByText("Set up tracing by hand"))).toBe(true);
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
  });
});
