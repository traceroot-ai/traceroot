// @vitest-environment jsdom
/**
 * The setup step's watch for the first trace, driven through the real page.
 *
 * Its own file because driving the wait means fake timers, and the rest of the
 * onboarding suite leans on testing-library's waitFor, which polls on real
 * ones. The mocks stop at the API client, so the module that decides *which*
 * trace belongs to this run is the real one here — which is the point, because
 * what this page claims is that the question has only one possible answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  search: "projectId=proj-1",
  getProject: vi.fn(),
  firstTraceTime: vi.fn(),
  getTraces: vi.fn(),
  session: {
    data: { user: { id: "user-1", email: "kai@example.com" } },
    isPending: false,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => mocks.session, signOut: vi.fn() },
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHeaderContent: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({ getProject: mocks.getProject }));
vi.mock("@/lib/api/projects", () => ({ getProjectFirstTraceTime: mocks.firstTraceTime }));
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
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspaces: () => ({ data: [] }) }));
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
import { MAX_UNREADABLE_ROUNDS } from "@/features/onboarding/use-project-trace-wait";
import SetupStepPage from "./page";
import { latestSetup, rememberSetup } from "@/features/onboarding/setup-resume";

const resume = () => latestSetup("user-1");

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

function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SetupStepPage />
    </QueryClientProvider>,
  );
}

/** Open the step for the project the run created, as the connect step does. */
async function reachHandback() {
  mount();
  await flush();
}

/** The same, then on to the manual walkthrough. */
async function reachManual() {
  await reachHandback();
  fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.getProject.mockResolvedValue({
    id: "proj-1",
    name: "my-llm-project",
    workspace_id: "ws-1",
    read_at: "2026-05-01T10:03:00Z",
  });
  mocks.firstTraceTime.mockReset().mockResolvedValue("2026-05-01T10:00:00Z");
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
  mocks.getProject.mockReset();
  mocks.search = "projectId=proj-1";
  capture.mockReset();
  mocks.getTraces.mockReset();
});

describe("the hand-back step's first-trace watch", () => {
  it("watches the project it just made, and only that one", async () => {
    // The page made the project, so the id is already in hand and there is
    // nothing else to watch or rank.
    await reachHandback();
    await rounds(2);

    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();
    const watched = new Set(mocks.getTraces.mock.calls.map((call) => call[0]));
    expect([...watched]).toEqual(["proj-1"]);
  });

  it("shows that tracing is set up on a direct visit to a project with traces", async () => {
    // Creating a project is idempotent on its name within a workspace, so a run
    // that lands on a name already in use is handed the existing project back.
    // The first round draws the line; nothing older than it can win.
    tracePage = [trace("t-before", "2026-05-01T10:00:00Z")];
    await reachHandback();
    expect(screen.getByText("This project has already received traces.")).toBeDefined();
    expect(screen.getByRole("link", { name: "View traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
    expect(resume()).toBeNull();
    expect(screen.queryByText(/Waiting for your first trace/)).toBeNull();
    await rounds(3);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.getTraces).toHaveBeenCalledTimes(1);
  });

  it("keeps another interrupted project when revisiting one that already has traces", async () => {
    rememberSetup("user-1", "unfinished-project", "project");
    tracePage = [trace("t-old", "2025-05-01T10:00:00Z")];
    mocks.firstTraceTime.mockResolvedValue("2025-05-01T10:00:00Z");
    await reachHandback();
    expect(screen.getByRole("link", { name: "View traces" })).toBeDefined();
    expect(resume()).toMatchObject({ projectId: "unfinished-project", created: "project" });
  });

  it("opens the first trace ingested during the initial list request, even with a skewed producer clock", async () => {
    let reply!: (value: unknown) => void;
    mocks.getTraces.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));
    await reachHandback();
    expect(screen.getByText("Finish setting up in your terminal")).toBeDefined();
    tracePage = [trace("t-run", "2020-01-01T00:00:00Z")];
    mocks.firstTraceTime.mockResolvedValue("2026-05-01T10:04:00Z");
    expect(resume()?.projectId).toBe("proj-1");
    reply({ data: tracePage });
    await flush();
    expect(resume()).toBeNull();
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=t-run");
  });

  it("keeps the original visit time when reading the ingestion time needs a retry", async () => {
    tracePage = [trace("t-retry", "2020-01-01T00:00:00Z")];
    mocks.firstTraceTime
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("2026-05-01T10:04:00Z");
    await reachHandback();
    expect(mocks.push).not.toHaveBeenCalled();
    await rounds(1);
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=t-retry");
  });

  it("opens the trace that arrives", async () => {
    await reachHandback();
    await rounds(1);

    tracePage = [trace("t-run", "2026-05-01T10:05:00Z")];
    await rounds(1);

    // The wait ends where the person wanted to be: on the trace the run was
    // for, without having to ask for it.
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces?traceId=t-run");
    // Once. The effect is keyed on the wait object's identity, so a settled
    // wait that re-rendered would push again.
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

  it("keeps waiting when the command is only copied", async () => {
    // Copying is recorded and nothing else: the page has no trace to open
    // until the command has run, so it stays on the step, still watching.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    await reachHandback();
    await rounds(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy terminal snippet" }));
    await flush();
    await rounds(2);

    expect(capture).toHaveBeenCalledWith("setup_command_copied", {
      project_id: "proj-1",
      surface: "onboarding",
    });
    expect(traceLine().textContent).toBe(
      "Waiting for your first trace. This page updates when it arrives.",
    );
    expect(screen.getByText("Finish setting up in your terminal")).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("leaves both exits working while it waits", async () => {
    // The watch is additive. It must not become a thing the user has to wait
    // out before they can choose the manual path or leave.
    await reachHandback();
    await rounds(1);
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await flush();
    expect(screen.getByText(/Select your integration/)).toBeDefined();
    // Still watching on the manual step, where the trace is just as welcome.
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Using AI" }));
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
    // The run is still going wherever the command was run; only this page has
    // stopped watching, so the way out is still offered.
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
  });

  it("reads nothing at all until the project is known", async () => {
    // Nothing to watch before the step knows its project.
    mocks.getProject.mockReturnValue(new Promise(() => {}));
    mount();
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
    expect(isAbove(line, screen.getByText(/Select your integration/))).toBe(true);
    // And above the tabs themselves.
    expect(isAbove(line, screen.getByRole("tab", { name: "Manual" }))).toBe(true);
  });

  it("is the same node across the switch, not a second one somewhere else", async () => {
    // Both halves of "exactly one": the node survives the step change, and no
    // step contributes one of its own on either side of it.
    await reachHandback();
    await rounds(1);
    const before = traceLine();

    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await flush();
    expect(traceLine()).toBe(before);

    fireEvent.click(screen.getByRole("tab", { name: "Using AI" }));
    await flush();
    expect(traceLine()).toBe(before);
  });

  it("holds the slot open before there is anything to say in it", async () => {
    // The line is absent until the project is known. The space it will take is
    // reserved from the first render, so the card does not step down when it
    // appears.
    mocks.getProject.mockReturnValue(new Promise(() => {}));
    mount();
    await flush();

    expect(
      screen.queryByText(/Waiting for your first trace|Your first trace arrived|Still no trace/),
    ).toBeNull();
    const slot = headerBlock().lastElementChild as HTMLElement;
    expect(slot.className).toContain("min-h-[33px]");
    expect(slot.childElementCount).toBe(0);
  });

  it("announces it from one region, in the hand-back's own words, through the arrival", async () => {
    // These were the hand-back step's own tests while the step rendered the
    // line, and they hold just as much now that the page does. Announced rather
    // than merely shown, because the premise is that nobody is looking at this
    // tab; from one region that outlives its text, because a region mounted
    // alongside its content is not announced; and in this page's approved
    // sentence, since the device page shares the line and says it "opens it".
    await reachHandback();
    await rounds(1);

    const region = within(headerBlock()).getByRole("status");
    expect(
      screen.getByText("Waiting for your first trace. This page updates when it arrives."),
    ).toBeDefined();
    expect(region.textContent).toContain("Waiting for your first trace");

    tracePage = [trace("t-run", "2026-05-01T10:05:00Z")];
    await rounds(1);

    expect(within(headerBlock()).getByRole("status")).toBe(region);
    expect(region.textContent).toContain("Your first trace arrived");
    // Nothing about the arrival closes the step down: the link is the way
    // through until the page's own push lands, and neither alternative is
    // withdrawn.
    expect(screen.getByRole("tab", { name: "Manual" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
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
    expect(isAbove(line, screen.getByText(/Select your integration/))).toBe(true);
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
    expect(isAbove(line, screen.getByText(/Select your integration/))).toBe(true);
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
  });
});

describe("the setup step itself", () => {
  it("shows the project page's setup tabs in sign-up's own words, without GitHub or Slack", async () => {
    await reachHandback();

    expect(screen.getByRole("tab", { name: "Using AI" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      screen.getByText("Workspace and project created — the rest happens in your terminal"),
    ).toBeDefined();
    expect(screen.getByText("Finish setting up in your terminal")).toBeDefined();
    expect(screen.getByText(/Run it where my-llm-project's code lives\./)).toBeDefined();
    expect(document.querySelector("pre")?.textContent).toContain("--project proj-1");
    expect(screen.queryByText(/External integrations/)).toBeNull();
  });

  it("shows the manual walkthrough with no model key, and says so in the header", async () => {
    await reachManual();

    expect(
      screen.getByText("Workspace and project created — add tracing to your application"),
    ).toBeDefined();
    expect(screen.getByText(/Install SDK/)).toBeDefined();
    expect(screen.getByText("Needs Python 3.11 or later.")).toBeDefined();
    expect(screen.queryByText(/model key/i)).toBeNull();
    expect(screen.queryByText(/External integrations/)).toBeNull();
  });

  it("says only a project was made when the run added one to an existing workspace", async () => {
    mocks.search = "projectId=proj-1&created=project";
    await reachHandback();
    expect(screen.getByText("Project created — the rest happens in your terminal")).toBeDefined();
    cleanup();
    expect(resume()).toMatchObject({ projectId: "proj-1", created: "project" });
  });

  it("leaves a skipped account on its workspaces, and a manual one on its traces", async () => {
    await reachHandback();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.push).toHaveBeenCalledWith("/workspaces");
    expect(resume()).toBeNull();
    cleanup();
    await reachHandback();
    expect(resume()?.projectId).toBe("proj-1");

    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Go to my project" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces");
    expect(resume()).toBeNull();
  });

  it("says the step is unavailable for a project it cannot open", async () => {
    mocks.getProject.mockRejectedValue(new Error("Project not found"));
    await reachHandback();
    expect(screen.getByText("This step isn't available")).toBeDefined();
    expect(resume()).toBeNull();
    expect(screen.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe(
      "/workspaces",
    );
  });
});
