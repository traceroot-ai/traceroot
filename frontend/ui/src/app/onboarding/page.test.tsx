// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Real usage of better-auth's `useSession` is a subscription: it starts pending
// and resolves later, in its own render, independent of every query on the
// page. A static value cannot express that transition — and the transition is
// where the workspace name is decided — so the mocked hook reads a store the
// tests move, rather than a constant.
type SessionState = {
  data: { user: { id: string; email: string } } | undefined;
  isPending: boolean;
};

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
  getWorkspaces: vi.fn(),
  getProjects: vi.fn(),
  getTraces: vi.fn(),
  params: new URLSearchParams(),
  signOut: vi.fn(),
  // Carries an id, because the page caches the workspace list per account: a
  // session without one would key every account's list together, which is the
  // bug these tests would then be blind to.
  session: {
    state: {
      data: { user: { id: "user-1", email: "kai@example.com" } },
      isPending: false,
    } as SessionState,
    listeners: new Set<() => void>(),
  },
  layoutAccess: vi.fn(),
}));

// Shaped like GET /api/workspaces answers it (see app/api/workspaces/route.ts).
// `role` and `project_count` are what the handoff decision reads, so a stub
// without them would prove nothing about the real payload.
const READY_WORKSPACE = { id: "ws-existing", name: "Example", role: "ADMIN", project_count: 1 };
const EMPTY_WORKSPACE = { id: "ws-empty", name: "Example", role: "ADMIN", project_count: 0 };
const VIEWER_EMPTY_WORKSPACE = { ...EMPTY_WORKSPACE, role: "VIEWER" };
// Every account joins the public demo as a VIEWER at sign-up, and it has a project.
const DEMO_WORKSPACE = { ...READY_WORKSPACE, id: "ws-demo", role: "VIEWER", is_demo: true };

// Shaped like better-auth's client results (see @better-fetch/fetch): a cleared
// session, and a sign-out the server answered with an error.
const SIGNED_OUT = { data: { success: true }, error: null };
const SIGN_OUT_REFUSED = {
  data: null,
  error: { status: 429, statusText: "Too Many Requests", message: "Too many requests" },
};

function setParams(init: Record<string, string>) {
  mocks.params = new URLSearchParams(init);
}

function subscribeSession(listener: () => void) {
  mocks.session.listeners.add(listener);
  return () => mocks.session.listeners.delete(listener);
}
function sessionSnapshot() {
  return mocks.session.state;
}
function setSession(next: SessionState) {
  mocks.session.state = next;
  mocks.session.listeners.forEach((listener) => listener());
}

function signedInAs(id: string, email: string) {
  setSession({ data: { user: { id, email } }, isPending: false });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => useSyncExternalStore(subscribeSession, sessionSnapshot),
    signOut: mocks.signOut,
  },
}));
// Left in place, but only to catch the page reaching for it. This page renders
// outside the app shell (see lib/chromeless-routes), where `useLayout` hands
// back the context's inert defaults — so a `setHeaderContent` call here writes
// a title into a header that is never rendered, and reads as working in a test
// while showing nothing in a browser.
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => {
    mocks.layoutAccess();
    return { setHeaderContent: vi.fn() };
  },
}));
vi.mock("@/lib/api", () => ({
  createWorkspace: mocks.createWorkspace,
  createProject: mocks.createProject,
  getWorkspaces: mocks.getWorkspaces,
  getProjects: mocks.getProjects,
}));
// Not mocked, and deliberately: the page tells a name collision from any other
// refusal by the status on this class, so a stand-in shape would let the page
// read a 409 off something the API layer never produces.
import { ApiError } from "@/lib/api/errors";
// The manual step renders the getting-started panel's own walkthrough, so the
// page's tests inherit its edges: a project lookup, a key that can only be
// minted once, and two external-service rows that each fetch. Stubbed the same
// way that walkthrough's own test stubs them — the structure it renders is what
// matters here, and the structure is still the real component's.
// The hand-back step watches the new project for its first trace. This suite
// runs on real timers, so it only ever sees the first read; what the watch then
// does with it is driven under fake timers in page.first-trace.test.tsx. Mocked
// so that no test here reaches for the network to find out.
vi.mock("@/lib/api/traces", () => ({
  getTraces: mocks.getTraces,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/traces/components/GettingStarted/ApiKeyBlock", () => ({
  ApiKeyBlock: () => <div data-testid="api-key-block" />,
}));
// The demo workspace the "Using AI" tab offers. Its own read of the list, so
// stood in for: this page's workspace checks are counted through `getWorkspaces`.
const demo = vi.hoisted(() => ({ workspaces: [] as { id: string; is_demo?: boolean }[] }));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspaces: () => ({ data: demo.workspaces }),
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));
import OnboardingPage from "./page";

// What POST /api/workspaces answers when `uq_workspace_created_by_name` refuses
// the write (see app/api/workspaces/route.ts, which maps Prisma's P2002 to it).
const NAME_TAKEN = () => new ApiError(409, "A workspace with this name already exists");
// And what POST /api/workspaces/[workspaceId]/projects answers when
// `uq_project_workspace_live_name` refuses the write (see that route, which maps
// the same P2002 to it).
const PROJECT_NAME_TAKEN = () => new ApiError(409, "A project with this name already exists");
// Shaped like that route's GET answers it: live projects only, each carrying the
// `delete_time` the page checks.
const LIVE_PROJECT = {
  id: "proj-existing",
  name: "my-llm-project",
  trace_ttl_days: null,
  delete_time: null,
  create_time: "2026-01-01T00:00:00.000Z",
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// `queryClient` is a parameter so one test can mount the page twice against the
// same cache, which is what an account switch inside the app looks like.
function renderPage(queryClient: QueryClient = makeQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <OnboardingPage />
    </QueryClientProvider>,
  );
}

// A promise this test resolves by hand, so "did the page wait for this?" can be
// asserted rather than inferred from call order.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Creating starts by itself; after a failure, Try again is what starts it again.
async function clickTryAgain() {
  const retry = await waitFor(() => screen.getByRole("button", { name: "Try again" }));
  fireEvent.click(retry);
}

/** Wait for the page to move on to the questions step; answers where. */
async function reachHandback(): Promise<string> {
  await waitFor(() =>
    expect(mocks.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/onboarding\/questions\?/)),
  );
  return mocks.replace.mock.calls.at(-1)![0] as string;
}

// Where the questions step hands a waiting terminal back to.
const QUESTIONS_THEN_DEVICE =
  "/onboarding/questions?projectId=proj-1&callbackUrl=%2Fdevice%3Fuser_code%3DABCD1234";

// The sign-out round trip, read back from what the page pushed rather than
// string-matched. What has to hold is that a sign-in landing on this URL comes
// back to this page carrying the *same* hand-back — and comparing against the
// same expression the page builds would pass for any encoding that is merely
// self-consistent with itself, including one no browser would decode this way.
function switchAccountRoundTrip(pushed: string) {
  const signIn = new URL(pushed, "http://test.invalid");
  const back = new URL(signIn.searchParams.get("callbackUrl") ?? "", "http://test.invalid");
  return {
    signInPath: signIn.pathname,
    backTo: back.pathname,
    handBack: back.searchParams.get("callbackUrl"),
    workspaceId: back.searchParams.get("workspaceId"),
  };
}

// The way out is held while creating, so it is used once creating has stopped:
// in these tests, because it failed (the default below).
async function clickSignOut() {
  const signOut = await waitFor(() => {
    const button = screen.getByRole("button", { name: "Not you? Sign out" });
    expect(button.hasAttribute("disabled")).toBe(false);
    return button;
  });
  fireEvent.click(signOut);
}

beforeEach(() => {
  // Reset explicitly: `signedInAs` mutates a store that outlives the test that
  // called it, so a later test would otherwise inherit whichever account the
  // previous one switched to.
  signedInAs("user-1", "kai@example.com");
  // The page refuses to onboard an account that already owns a workspace, so
  // every test that exercises the form is a first-run account unless it says
  // otherwise.
  mocks.getWorkspaces.mockResolvedValue([]);
  mocks.getTraces.mockResolvedValue({ data: [], meta: { page: 0, limit: 1, total: 0 } });
  // `{ data, error }` rather than nothing, because that is what the better-auth
  // client resolves with: it reports a failed sign-out in `error` instead of
  // rejecting, so a mock that resolves bare cannot tell the two apart.
  mocks.signOut.mockResolvedValue(SIGNED_OUT);
  // Only reached when a project create collides, so an empty list is the honest
  // default: a test that expects an adoption says what the workspace holds.
  mocks.getProjects.mockResolvedValue([]);
  // Creating starts by itself, so a test that does not say how it goes sees it
  // fail, and the page stop on its error.
  mocks.createWorkspace.mockRejectedValue(new Error("workspace create not set up"));
  mocks.createProject.mockRejectedValue(new Error("project create not set up"));
});

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.createProject.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.getTraces.mockReset();
  mocks.layoutAccess.mockReset();
  mocks.signOut.mockReset();
  mocks.getProjects.mockReset();
  mocks.params = new URLSearchParams();
  demo.workspaces = [];
  signedInAs("user-1", "kai@example.com");
});

describe("OnboardingPage", () => {
  it("does not reach for the app shell's layout context", async () => {
    // This page renders with no shell around it, so there is no header to put a
    // title in and no rail to collapse. Depending on the shell's context is how
    // the two drift back apart: the call succeeds against the context defaults
    // and nothing shows, which is invisible until someone opens the page.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    expect(mocks.layoutAccess).not.toHaveBeenCalled();
  });

  it("creates the workspace and project with default names, then moves on to the questions", async () => {
    // Nothing to fill in: both are made as soon as the account is known to
    // need them, named from the address, and renamed later in settings.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    const to = await reachHandback();

    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
    expect(mocks.createProject).toHaveBeenCalledWith("ws-1", "my-llm-project");
    // On to the questions, with the project in the address so a refresh there
    // creates nothing again. Replaced, so Back does not land here.
    expect(to).toBe("/onboarding/questions?projectId=proj-1");
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("moves an account adding a project to the questions, saying only a project was made", async () => {
    // Project-only mode is the same first run arriving from `?workspaceId=`, so
    // it gets the same steps — and they say what this run actually created
    // rather than claiming a workspace it did not make.
    setParams({ workspaceId: "ws-existing", workspaceName: "Example" });
    mocks.createProject.mockResolvedValue({ id: "proj-2", name: "my-llm-project" });
    renderPage();

    expect(await reachHandback()).toBe("/onboarding/questions?projectId=proj-2&created=project");
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith("ws-existing", "my-llm-project");
  });
  it("carries a waiting caller's hand-back through the questions", async () => {
    // `traceroot setup` is holding a terminal open on the device approval this
    // page runs ahead of. The questions come first, and they hand the terminal
    // back, skipping the connect and setup steps, which are about a run already
    // underway.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    expect(await reachHandback()).toBe(QUESTIONS_THEN_DEVICE);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("holds the handoff open until both the workspace and the project exist", async () => {
    // The whole point of the change: the terminal is released last. Ordering the
    // *calls* does not say that — it passes for code that puts both requests on
    // the wire and pushes without awaiting the second, which is the original bug
    // exactly. So drive the two promises by hand and assert nothing is pushed
    // while either is still in flight.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    const workspace = deferred<{ id: string }>();
    const project = deferred<{ id: string; name: string }>();
    mocks.createWorkspace.mockReturnValue(workspace.promise);
    mocks.createProject.mockReturnValue(project.promise);
    renderPage();

    // Workspace request in flight: the account still owns nothing.
    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalledWith("Example"));
    expect(mocks.push).not.toHaveBeenCalled();

    workspace.resolve({ id: "ws-1" });

    // Project request in flight: the workspace exists but is empty, which is the
    // same dead end for the CLI from the other side.
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalledWith("ws-1", "my-llm-project"));
    expect(mocks.push).not.toHaveBeenCalled();

    project.resolve({ id: "proj-1", name: "my-llm-project" });

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(QUESTIONS_THEN_DEVICE));
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });

  it("does not hand back when the project could not be created", async () => {
    // A terminal released against a workspace with no project is the same dead
    // end from the other direction.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValue(new Error("project creation failed"));
    renderPage();

    await waitFor(() => expect(screen.getByText(/project creation failed/)).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("refuses an off-origin callback and falls back to the normal flow", async () => {
    // The value arrives in a query string anyone can craft a link with, so an
    // unvalidated redirect here would bounce a freshly-created account to a
    // foreign site at the exact moment it trusts the page.
    setParams({ callbackUrl: "https://evil.example/steal" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    // A rejected value means there is nowhere to hand back to, which is the
    // same position as a user who arrived on their own — so the normal flow
    // continues, with no hand-back on it.
    expect(await reachHandback()).toBe("/onboarding/questions?projectId=proj-1");
  });

  it("hands an account that already has a project straight back to the caller", async () => {
    // The Google button on /auth/sign-up routes through here, and better-auth
    // has no social sign-up to distinguish from social sign-in — so an existing
    // account, or an email account linked to the same Google identity, arrives
    // on this page without being new. It owns what the terminal was waiting
    // for, so there is nothing to do but hand back.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.getWorkspaces.mockResolvedValue([READY_WORKSPACE]);
    renderPage();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("makes a viewer whose only workspace is empty a workspace of its own, instead of bouncing back", async () => {
    // The seam between this page and /device. /device sends this account here
    // rather than to project-only mode because creating a project needs MEMBER
    // or higher, so the workspace it already belongs to is no help. If this page
    // then counts that same workspace as done, the two disagree and every
    // "Continue setup" click lands the user straight back on /device: a loop
    // with nothing to do in it.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.getWorkspaces.mockResolvedValue([VIEWER_EMPTY_WORKSPACE]);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    // The way out is a workspace of their own, not the read-only one they
    // cannot add to.
    expect(await reachHandback()).toBe(QUESTIONS_THEN_DEVICE);
    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("asks a member with an empty workspace for the project alone, not a second workspace", async () => {
    // Same missing project, different answer: this account can add one to the
    // workspace it already has, so the page redirects itself into project-only
    // mode — the destination /device uses for this case — and carries the
    // waiting terminal along.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.getWorkspaces.mockResolvedValue([{ ...EMPTY_WORKSPACE, role: "MEMBER" }]);
    renderPage();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        `/onboarding?workspaceId=ws-empty&workspaceName=Example&callbackUrl=${encodeURIComponent(
          "/device?user_code=ABCD1234",
        )}`,
      ),
    );
    // Nothing makes a duplicate workspace in the meantime.
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("redirects to project-only mode with no callbackUrl when nobody is waiting", async () => {
    // Same case arrived at directly rather than from a terminal: there is
    // nothing to hand back to, so the URL says so instead of carrying an empty
    // `callbackUrl=`. This page would survive one (`safeCallbackUrl` answers a
    // blank value with its fallback, and `|| null` turns that back into "nobody
    // waiting"), but the shared builder is also used by /device, and a caller
    // that tests for the parameter's presence would read an empty one as a
    // caller to return to.
    mocks.getWorkspaces.mockResolvedValue([{ ...EMPTY_WORKSPACE, role: "MEMBER" }]);
    renderPage();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/onboarding?workspaceId=ws-empty&workspaceName=Example",
      ),
    );
  });

  it("does not let the previous account's cached list mark a new account onboarded", async () => {
    // Signing out from /device's "Not you? Sign out" stays inside the app, so
    // the QueryClient — and everything in it — survives the account switch. A
    // list cached under a bare "workspaces" key would then answer for the next
    // account: a brand-new one gets handed straight back to the terminal that
    // is waiting for the workspace it still does not have.
    const queryClient = makeQueryClient();
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    // Account A is set up, so its visit hands back and leaves its list in the
    // cache.
    signedInAs("user-a", "kai@example.com");
    mocks.getWorkspaces.mockResolvedValue([{ ...READY_WORKSPACE, id: "ws-a" }]);
    const first = renderPage(queryClient);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    first.unmount();

    // Account B in the same tab owns nothing.
    mocks.push.mockReset();
    signedInAs("user-b", "new@example.com");
    mocks.getWorkspaces.mockResolvedValue([]);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-b" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage(queryClient);

    expect(await reachHandback()).toBe(QUESTIONS_THEN_DEVICE);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("moves on to the questions, not the workspace list, after the refetch reports the new project", async () => {
    // Creating the workspace and project invalidates the very list this page
    // gates itself on, so the refetch comes back describing an account that is
    // now set up. Unless what this page created is excluded, the handoff effect
    // fires the moment that refetch lands and replaces the command the user is
    // about to copy with a redirect to /workspaces. The second value carries
    // `project_count`, or the refetched account would read as unfinished and
    // the test would pass without exercising anything.
    mocks.getWorkspaces
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...READY_WORKSPACE, id: "ws-1" }]);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await reachHandback();

    // Two fetches is also the proof that invalidating the shared "workspaces"
    // key still reaches the per-account entry this page reads: if the two
    // stopped matching, the refetch would never happen and this stays at one.
    await waitFor(() => expect(mocks.getWorkspaces).toHaveBeenCalledTimes(2));
    // Only on to the questions: never to /workspaces, as a finished account would be.
    expect(mocks.replace.mock.calls.map(([to]) => to)).toEqual([
      "/onboarding/questions?projectId=proj-1",
    ]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sets up an account whose only workspace is the demo", async () => {
    // A new account arrives here already in the demo. If its project counted,
    // this page would send the account to /workspaces, where it has nothing of
    // its own.
    mocks.getWorkspaces.mockResolvedValue([DEMO_WORKSPACE]);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sends an already-onboarded account with nobody waiting to its workspaces", async () => {
    mocks.getWorkspaces.mockResolvedValue([READY_WORKSPACE]);
    renderPage();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/workspaces"));
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("creates nothing until the workspace check settles", async () => {
    // Creating while the check is in flight is the whole hazard: it makes the
    // duplicate workspace the check exists to prevent.
    const workspaces = deferred<{ id: string; name: string }[]>();
    mocks.getWorkspaces.mockReturnValue(workspaces.promise);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.createWorkspace).not.toHaveBeenCalled();

    workspaces.resolve([]);

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("still lets a first-run account onboard when the workspace check fails", async () => {
    // A duplicate workspace is recoverable; an account that cannot reach this
    // page at all can never finish signing up. So a failed check still creates.
    mocks.getWorkspaces.mockRejectedValue(new Error("workspaces unavailable"));
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
  });

  it("does not check for a workspace when adding a project to one", async () => {
    // `?workspaceId=` means "add a project to this workspace I already own", so
    // owning one is the precondition here rather than a reason to leave.
    setParams({ workspaceId: "ws-existing", workspaceName: "Example" });
    mocks.createProject.mockResolvedValue({ id: "proj-2", name: "my-llm-project" });
    renderPage();

    await reachHandback();
    expect(mocks.getWorkspaces).not.toHaveBeenCalled();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith("ws-existing", "my-llm-project");
  });

  it("reuses the workspace it already made when a failed attempt is retried", async () => {
    // Retrying under the error used to re-create the workspace, which hit
    // `uq_workspace_created_by_name` and the route answered 409, so the retry
    // could not succeed.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValueOnce(new Error("project boom"));
    renderPage();
    await waitFor(() => expect(screen.getByText("project boom")).toBeDefined());

    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    await clickTryAgain();
    await reachHandback();

    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, "ws-1", "my-llm-project");
  });

  it("finishes the workspace a lost response left behind instead of dead-ending on it", async () => {
    // The case the id in `createdWorkspace` cannot cover: the POST commits and
    // the response never arrives — a dropped connection, a proxy answering 502
    // after the write — so the page holds no id and the retry submits the same
    // name. That is the 409 the issue describes, and pressing Create is the only
    // recovery this page offers, so the collision has to resolve to the
    // workspace it collided with.
    mocks.getWorkspaces.mockResolvedValueOnce([]).mockResolvedValue([EMPTY_WORKSPACE]);
    mocks.createWorkspace.mockRejectedValue(NAME_TAKEN());
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await reachHandback();

    expect(mocks.createProject).toHaveBeenCalledWith("ws-empty", "my-llm-project");
    // Nothing was created twice.
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("A workspace with this name already exists")).toBeNull();
  });

  it("does not put the project anywhere until it knows which workspace collided", async () => {
    // The adopted id comes out of a request, so the project step has to wait for
    // it. Call order cannot say that — it passes for a page that fires the
    // lookup and creates the project against a stale id without awaiting
    // either — so the lookup is resolved by hand and the assertion is that
    // nothing was created while it was in flight.
    const lookup = deferred<{ id: string; name: string; role: string }[]>();
    mocks.getWorkspaces.mockResolvedValueOnce([]).mockReturnValue(lookup.promise);
    mocks.createWorkspace.mockRejectedValue(NAME_TAKEN());
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalled());
    expect(mocks.createProject).not.toHaveBeenCalled();

    lookup.resolve([EMPTY_WORKSPACE]);

    await waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith("ws-empty", "my-llm-project"),
    );
  });

  it("keeps the collision when the name belongs to somebody else's workspace", async () => {
    // A workspace this account only reads is not one it created — the create
    // makes its caller an ADMIN member — and it is not somewhere a project can
    // go either. Adopting it would hand the user's first project to a workspace
    // that is not theirs, so the refusal stands and says what it refused.
    mocks.getWorkspaces.mockResolvedValueOnce([]).mockResolvedValue([VIEWER_EMPTY_WORKSPACE]);
    mocks.createWorkspace.mockRejectedValue(NAME_TAKEN());
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("A workspace with this name already exists")).toBeDefined(),
    );
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("keeps the collision when two workspaces answer to the name", async () => {
    // One of them is the account's own; the other is one it was promoted in.
    // Nothing in the list payload says which — `createdBy` is not in it — so
    // there is no answer to act on, and guessing would be the same mistake with
    // a 50% chance of looking fine.
    mocks.getWorkspaces
      .mockResolvedValueOnce([])
      .mockResolvedValue([EMPTY_WORKSPACE, { ...EMPTY_WORKSPACE, id: "ws-other" }]);
    mocks.createWorkspace.mockRejectedValue(NAME_TAKEN());
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("A workspace with this name already exists")).toBeDefined(),
    );
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("does not go looking for a workspace when the create failed for another reason", async () => {
    // A 500 says nothing about whether a workspace exists under this name, and
    // a lookup that found one anyway would adopt a workspace this attempt has no
    // claim on.
    mocks.getWorkspaces.mockResolvedValue([]);
    mocks.createWorkspace.mockRejectedValue(new ApiError(500, "workspace service unavailable"));
    renderPage();

    await waitFor(() => expect(screen.getByText("workspace service unavailable")).toBeDefined());
    // Once, for the check that let creating start.
    expect(mocks.getWorkspaces).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("finishes the project a lost response left behind instead of dead-ending on it", async () => {
    // The workspace half of this one step later, and the worse half: the
    // project POST commits, the response never arrives, and the retry reuses
    // the workspace and submits the same project name into it. That collides
    // with `uq_project_workspace_live_name`, and this is the last screen of
    // sign-up — so the collision has to resolve to the project it collided
    // with rather than leave the account on a button that cannot work.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1", name: "My Workspace" });
    mocks.createProject.mockRejectedValue(PROJECT_NAME_TAKEN());
    mocks.getProjects.mockResolvedValue([LIVE_PROJECT]);
    renderPage();

    const to = await reachHandback();

    expect(mocks.getProjects).toHaveBeenCalledWith("ws-1");
    expect(to).toBe("/onboarding/questions?projectId=proj-existing");
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("A project with this name already exists")).toBeNull();
  });

  it("keeps the collision when the workspace has no live project under the name", async () => {
    // A 409 whose project the listing cannot produce is not one to act on: the
    // row may have been soft-deleted between the two requests, or the status may
    // have come to mean something this page does not know about. Either way the
    // refusal stands and says what it refused.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1", name: "My Workspace" });
    mocks.createProject.mockRejectedValue(PROJECT_NAME_TAKEN());
    mocks.getProjects.mockResolvedValue([
      { ...LIVE_PROJECT, delete_time: "2026-01-02T00:00:00.000Z" },
      { ...LIVE_PROJECT, id: "proj-other", name: "something-else" },
    ]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("A project with this name already exists")).toBeDefined(),
    );
  });

  it("keeps the collision rather than adopting a project in a workspace it did not make", async () => {
    // Project-only mode adds a project to a workspace that already existed, and
    // such a workspace can be shared. With the project named `my-llm-project`
    // by default, a 409 there is at least as likely to be a teammate's
    // project as a lost response of this user's own — and adopting it would
    // report success, hand the terminal that project, and send this user's
    // traces into someone else's.
    setParams({ workspaceId: "ws-shared", workspaceName: "Example" });
    mocks.createProject.mockRejectedValue(PROJECT_NAME_TAKEN());
    mocks.getProjects.mockResolvedValue([LIVE_PROJECT]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("A project with this name already exists")).toBeDefined(),
    );
    // Not even looked for: the refusal is settled before the listing is read.
    expect(mocks.getProjects).not.toHaveBeenCalled();
  });

  it("does not go looking for a project when the create failed for another reason", async () => {
    // A 500 says nothing about whether a project exists under this name, and
    // adopting one found anyway would hand the user a project this attempt has
    // no claim on.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1", name: "My Workspace" });
    mocks.createProject.mockRejectedValue(new ApiError(500, "project service unavailable"));
    renderPage();

    await waitFor(() => expect(screen.getByText("project service unavailable")).toBeDefined());
    expect(mocks.getProjects).not.toHaveBeenCalled();
  });

  it("names the workspace from the address once a pending session resolves", async () => {
    // `authClient.useSession()` starts pending on mount. Creating then would
    // name the workspace "My Workspace" rather than the company the address
    // names, so nothing is created until the session is known.
    setSession({ data: undefined, isPending: true });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    expect(screen.getByText("Loading...")).toBeDefined();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();

    act(() => {
      signedInAs("user-1", "kai@example.com");
    });

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
  });

  it.each([
    ["kai@gmail.com", "My Workspace"],
    ["kai@proton.me", "My Workspace"],
    ["kai@acme.io", "Acme"],
  ])("names %s's workspace %s", async (email, name) => {
    signedInAs("user-1", email);
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledWith(name);
  });

  it("creates once, however often the page renders", async () => {
    const workspace = deferred<{ id: string }>();
    mocks.createWorkspace.mockReturnValue(workspace.promise);
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    const view = renderPage();
    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalled());
    view.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <OnboardingPage />
      </QueryClientProvider>,
    );
    workspace.resolve({ id: "ws-1" });

    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it("says why creating failed, and offers to try again", async () => {
    mocks.createWorkspace.mockRejectedValueOnce(new Error("workspace boom"));
    renderPage();

    await waitFor(() => expect(screen.getByText("workspace boom")).toBeDefined());
    expect(mocks.replace).not.toHaveBeenCalled();

    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    await clickTryAgain();
    await reachHandback();
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(2);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      "back to a waiting terminal",
      { callbackUrl: "/device?user_code=ABCD1234" },
      "/device?user_code=ABCD1234",
    ],
    ["to the workspace list when nobody is waiting", {}, "/workspaces"],
  ])("cancels %s", async (_where, params, destination) => {
    // With the rail gone, Cancel was the one exit left that dropped the
    // hand-back: the workspace list is an empty state for this account, and
    // nothing on it leads back to /device, so the terminal polled until the
    // code expired. Offered once creating has failed.
    setParams(params);
    mocks.createWorkspace.mockRejectedValue(new Error("workspace boom"));
    renderPage();

    const cancel = await waitFor(() => screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(cancel);

    expect(mocks.push).toHaveBeenCalledWith(destination);
  });

  it("names the account it is setting up", async () => {
    // Without the shell there is no user menu, so nothing else on the page says
    // which account this is — and being signed in as the wrong one is the
    // likeliest reason a user wants out of here.
    renderPage();

    await waitFor(() => expect(screen.getByText("as kai@example.com")).toBeDefined());
  });

  it("signs out and returns here, keeping a waiting terminal's hand-back", async () => {
    // The shell's user menu was the only way out of this page and it is gone.
    // Navigating away to find a sign-out is what drops `callbackUrl`, which
    // leaves `traceroot setup` polling for the whole device-code lifetime with
    // nothing left pointing back at the approval.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    renderPage();

    await clickSignOut();

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    expect(switchAccountRoundTrip(mocks.push.mock.calls[0][0])).toEqual({
      signInPath: "/auth/sign-in",
      backTo: "/onboarding",
      handBack: "/device?user_code=ABCD1234",
      workspaceId: null,
    });
  });

  it("does not leave for sign-in until the sign-out has gone through", async () => {
    // Pushing with the sign-out still in flight lands the new sign-in on top of
    // the old session: better-auth's sign-out clears the cookie when it
    // *returns*, so the race leaves the user signed in as the account they just
    // asked to leave, on a page that looks like it worked. Call order cannot
    // say this — it passes for a page that fires both and awaits neither — so
    // the sign-out is resolved by hand.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    const signOut = deferred<typeof SIGNED_OUT>();
    mocks.signOut.mockReturnValue(signOut.promise);
    renderPage();

    await clickSignOut();

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();

    signOut.resolve(SIGNED_OUT);

    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
  });

  it("comes back without the workspace the account being left owns", async () => {
    // `?workspaceId=` is an invitation to add a project to that workspace. It
    // belongs to the account signing out, and the whole point of the round trip
    // is to come back as somebody else — who cannot add anything to it. The
    // hand-back still has to survive, so this is not simply "/onboarding".
    setParams({
      workspaceId: "ws-existing",
      workspaceName: "Example",
      callbackUrl: "/device?user_code=ABCD1234",
    });
    renderPage();

    await clickSignOut();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    expect(switchAccountRoundTrip(mocks.push.mock.calls[0][0])).toEqual({
      signInPath: "/auth/sign-in",
      backTo: "/onboarding",
      handBack: "/device?user_code=ABCD1234",
      workspaceId: null,
    });
  });

  it("carries no empty hand-back when nobody is waiting", async () => {
    // A user who opened setup themselves has nowhere to be returned to, and an
    // empty `callbackUrl=` reads as a caller to someone testing for the
    // parameter's presence.
    renderPage();

    await clickSignOut();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/auth/sign-in?callbackUrl=%2Fonboarding"),
    );
  });

  it("refuses to sign out from under a workspace that is being created", async () => {
    // Between the workspace and the project is the one window where leaving
    // costs something: the workspace is created under an account the user is
    // walking away from, and nothing has it yet.
    const workspace = deferred<{ id: string }>();
    mocks.createWorkspace.mockReturnValue(workspace.promise);
    renderPage();

    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalled());
    const signOut = screen.getByRole("button", { name: "Not you? Sign out" });
    expect(signOut.hasAttribute("disabled")).toBe(true);
    fireEvent.click(signOut);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("says so when the sign-out fails instead of stranding the button", async () => {
    mocks.signOut.mockRejectedValue(new Error("network down"));
    renderPage();

    await clickSignOut();

    await waitFor(() =>
      expect(screen.getByText("Could not sign out. Please try again.")).toBeDefined(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Not you? Sign out" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("stays here when the sign-out comes back refused rather than thrown", async () => {
    // A rate limit or a proxy error resolves with an `error` instead of
    // rejecting, and the session cookie survives it. Leaving for sign-in on
    // that reaches a live session, which hands the user back here as the same
    // account they asked to leave, with no sign anything went wrong.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signOut.mockResolvedValue(SIGN_OUT_REFUSED);
    renderPage();

    await clickSignOut();

    await waitFor(() =>
      expect(screen.getByText("Could not sign out. Please try again.")).toBeDefined(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Not you? Sign out" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("holds the way out while it moves on to the next step", async () => {
    // The hand-back step is about the project this account now owns, and the
    // app — user menu included — is one click away from it.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    // Held while the page moves on: a sign-out now would strand the new project's step.
    expect(
      (screen.getByRole("button", { name: "Not you? Sign out" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
