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
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  createProject: vi.fn(),
  getWorkspaces: vi.fn(),
  getProjects: vi.fn(),
  getTraces: vi.fn(),
  createCliHandoff: vi.fn(),
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
  useRouter: () => ({ push: mocks.push }),
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
  updateWorkspace: mocks.updateWorkspace,
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
// The hand-back step's command carries a one-time code that signs the pasted
// terminal in, so the step mints one as soon as there is a project. Mocked for
// the same reason the trace read is: no test here should reach the network to
// find out what the printed line says.
vi.mock("@/lib/api/cli-handoff", () => ({
  createCliHandoff: (projectId: string) => mocks.createCliHandoff(projectId),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/traces/components/GettingStarted/ApiKeyBlock", () => ({
  ApiKeyBlock: () => <div data-testid="api-key-block" />,
}));
// The manual step asks whose model key to use, above the walkthrough. Stood in
// for so the binding the picker hands it can be read off the DOM, and so this
// suite does not reach the network to find out — the form's own behaviour is
// covered in ModelProviderBlock.test.tsx and in manual-setup-step.test.tsx.
vi.mock("@/features/traces/components/GettingStarted/ModelProviderBlock", () => ({
  ModelProviderBlock: ({ providerKey }: { providerKey: { kind: string; adapter?: string } }) => (
    <div
      data-testid="model-provider-block"
      data-kind={providerKey.kind}
      data-adapter={providerKey.adapter ?? ""}
    />
  ),
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
// Shaped like POST /api/cli/handoff answers it: `trh_` and 43 base64url chars.
const HANDOFF_CODE = "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABC";
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

// The form is withheld until the workspace check settles, so submitting means
// waiting for it first.
async function clickCreate() {
  const create = await waitFor(() => screen.getByRole("button", { name: "Create" }));
  fireEvent.click(create);
}

// The command lives in a `<pre>` whose line is split into spans for syntax
// colouring, so it is read off that element rather than matched as one string.
function shownCommand(): string {
  return document.querySelector("pre")?.textContent ?? "";
}

async function reachHandback() {
  await clickCreate();
  await waitFor(() => expect(screen.getByText("Finish setting up in your terminal")).toBeDefined());
}

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

async function clickSignOut() {
  const signOut = await waitFor(() => screen.getByRole("button", { name: "Not you? Sign out" }));
  fireEvent.click(signOut);
}

async function reachManualStep() {
  await reachHandback();
  fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
  await waitFor(() => expect(screen.getByText("Set up tracing by hand")).toBeDefined());
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
  // What POST /api/cli/handoff answers: `trh_` and 43 base64url characters,
  // redeemable for ten minutes.
  mocks.createCliHandoff.mockResolvedValue({
    code: HANDOFF_CODE,
    expiresIn: 600,
    expiresAt: "2026-10-17T18:31:00.000Z",
  });
  // `{ data, error }` rather than nothing, because that is what the better-auth
  // client resolves with: it reports a failed sign-out in `error` instead of
  // rejecting, so a mock that resolves bare cannot tell the two apart.
  mocks.signOut.mockResolvedValue(SIGNED_OUT);
  // Only reached when a project create collides, so an empty list is the honest
  // default: a test that expects an adoption says what the workspace holds.
  mocks.getProjects.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.updateWorkspace.mockReset();
  mocks.createProject.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.getTraces.mockReset();
  mocks.createCliHandoff.mockReset();
  mocks.layoutAccess.mockReset();
  mocks.signOut.mockReset();
  mocks.getProjects.mockReset();
  mocks.params = new URLSearchParams();
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

  it("ends a browser-first run on the command that continues it in a terminal", async () => {
    // The last thing the browser can usefully say. Everything left to do is
    // against a checkout the dashboard cannot see, so the page stops asking
    // and hands over the one command that does all of it — carrying the
    // project it has just made, which the user would otherwise have to name
    // from memory.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
    expect(mocks.createProject).toHaveBeenCalledWith("ws-1", "my-llm-project");
    expect(shownCommand()).toContain("npx -y traceroot-cli@0.6.1 setup");
    expect(shownCommand()).toContain("--project proj-1");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("signs the terminal in through the command rather than a second page", async () => {
    // The point of the handoff. Without a code on the line, the terminal this
    // command is pasted into has no credential, so `setup` opens a second
    // browser page to sign in — for the account that signed in in this one a
    // moment ago — and both pages then wait for the same first trace. The code
    // is minted against the project this run just created.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    await waitFor(() => expect(shownCommand()).toContain(`--handoff ${HANDOFF_CODE}`));
    expect(mocks.createCliHandoff).toHaveBeenCalledWith("proj-1");
    // Unquoted, and beside the project flag rather than instead of it.
    expect(shownCommand()).not.toContain(`'${HANDOFF_CODE}'`);
    expect(shownCommand()).toContain("--project proj-1");
  });

  it("prints the working command, and says nothing, when the mint fails", async () => {
    // A failed mint degrades to the status quo: the command without a handoff
    // is what this page printed before handoffs existed, and it works — by way
    // of the second browser page. What it must never degrade to is a blank
    // step, an error, or a command the user cannot run.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    mocks.createCliHandoff.mockRejectedValue(new ApiError(500, "mint unavailable"));
    renderPage();
    await reachHandback();

    expect(shownCommand()).toContain("--project proj-1");
    expect(shownCommand()).not.toContain("--handoff");
    expect(screen.queryByText(/handoff/i)).toBeNull();
    expect(screen.queryByText(/mint unavailable/)).toBeNull();
    // And the step is still the step: both ways out are still offered.
    expect(screen.getByRole("button", { name: "Set up manually" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
  });

  it("mints nothing before there is a project to mint against", async () => {
    // Nothing to record a handoff against, and a user who abandons the form
    // has cost the mint nothing.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Create" }));

    expect(mocks.createCliHandoff).not.toHaveBeenCalled();
  });

  it("shows the manual walkthrough as a step of the flow, not a page away from it", async () => {
    // "Set up manually" used to navigate to the project's traces page, where
    // this same walkthrough lives. The content was right and the exit was the
    // surprise: signing up ended mid-sentence, with nothing to say which part
    // was still onboarding. So the walkthrough is a third step in the same
    // frame — same heading, same card — and nothing is routed anywhere until
    // the user asks.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachManualStep();

    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Let's get started" })).toBeDefined();
    // The real walkthrough, rendered rather than reimplemented: its own steps,
    // the key block, and above it the stack picker and the model-key field that
    // both routes to a first trace share — all carrying the project this run
    // just created. Matched without the step numbers — inserting a step into
    // the walkthrough renumbers the ones below it, and that is not this page's
    // business.
    expect(screen.getByText(/Create an API key/)).toBeDefined();
    expect(screen.getByTestId("api-key-block")).toBeDefined();
    expect(screen.getByText(/Select your stack/)).toBeDefined();
    expect(screen.getByRole("radio", { name: "OpenAI" })).toBeDefined();
    expect(screen.getByText(/Use your own model key/)).toBeDefined();
    expect(screen.getByTestId("model-provider-block").dataset.adapter).toBe("openai");
    expect(screen.getByText(/External integrations/)).toBeDefined();
    // And the terminal is no longer what is being asked of this user, so the
    // frame stops saying it is.
    expect(
      screen.getByText(/Workspace and project created — add tracing to your application/),
    ).toBeDefined();
    expect(screen.queryByText("Finish setting up in your terminal")).toBeNull();
  });

  it("lets a user who changed their mind back to the terminal command", async () => {
    // Choosing "manually" and then thinking better of it is ordinary, and the
    // command carries the project id this user would otherwise have to
    // remember — so the step before this one has to still be reachable.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachManualStep();

    fireEvent.click(screen.getByRole("button", { name: "Back to the terminal command" }));

    await waitFor(() =>
      expect(screen.getByText("Finish setting up in your terminal")).toBeDefined(),
    );
    expect(shownCommand()).toContain("--project proj-1");
    expect(screen.queryByText("Set up tracing by hand")).toBeNull();
    // Nothing navigated in either direction: both steps are this page.
    expect(mocks.push).not.toHaveBeenCalled();
    // The project was created once, by the form, and going back does not
    // re-run it.
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it("ends the manual step on the project whose traces it is setting up", async () => {
    // Onboarding has to end somewhere that works for an account that has not
    // instrumented anything yet. The project's traces page is that: it is
    // where the first trace lands, and until one does it keeps this same
    // walkthrough on screen — so leaving part-way through is not a dead end.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachManualStep();

    fireEvent.click(screen.getByRole("button", { name: "Go to my project" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces");
  });

  it("offers the manual step to an account adding a project to a workspace it owns", async () => {
    // Project-only mode is the same first run arriving from `?workspaceId=`,
    // so it gets the same three steps — and the heading says what this run
    // actually created rather than claiming a workspace it did not make.
    setParams({ workspaceId: "ws-existing", workspaceName: "Example" });
    mocks.createProject.mockResolvedValue({ id: "proj-2", name: "my-llm-project" });
    renderPage();
    await reachManualStep();

    expect(screen.getByText(/^Project created — add tracing to your application$/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Go to my project" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-2/traces");
  });

  it("leaves a skipped account somewhere it can act, not back in onboarding", async () => {
    // Skipping is a way out of signing up, so it has to land on a page that
    // works: the workspace list, which is where the already-onboarded check
    // sends an account with nobody waiting. The project exists either way, so
    // no route sends this user back through onboarding.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.push).toHaveBeenCalledWith("/workspaces");
  });

  it("hands straight back to a waiting caller instead of showing it the command", async () => {
    // `traceroot setup` is holding a terminal open on the device approval this
    // page runs ahead of. Telling that user to run `traceroot setup` is telling
    // them to start the run they are already in the middle of, so the hand-back
    // step is withheld and the terminal is released instead.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await clickCreate();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(screen.queryByText("Finish setting up in your terminal")).toBeNull();
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

    await clickCreate();

    // Workspace request in flight: the account still owns nothing.
    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalledWith("Example"));
    expect(mocks.push).not.toHaveBeenCalled();

    workspace.resolve({ id: "ws-1" });

    // Project request in flight: the workspace exists but is empty, which is the
    // same dead end for the CLI from the other side.
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalledWith("ws-1", "my-llm-project"));
    expect(mocks.push).not.toHaveBeenCalled();

    project.resolve({ id: "proj-1", name: "my-llm-project" });

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("does not hand back when the project could not be created", async () => {
    // A terminal released against a workspace with no project is the same dead
    // end from the other direction.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValue(new Error("project creation failed"));
    renderPage();

    await clickCreate();

    await waitFor(() => expect(screen.getByText(/project creation failed/)).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("refuses an off-origin callback and falls back to the normal flow", async () => {
    // The value arrives in a query string anyone can craft a link with, so an
    // unvalidated redirect here would bounce a freshly-created account to a
    // foreign site at the exact moment it trusts the page.
    setParams({ callbackUrl: "https://evil.example/steal" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await clickCreate();

    // A rejected value means there is nowhere to hand back to, which is the
    // same position as a user who arrived on their own — so the normal flow
    // continues and nothing is pushed. Asserting `push("/")` here used to pass
    // only because the validator answered a rejected value with its fallback,
    // which sent a new account to the root instead of its traces.
    await waitFor(() =>
      expect(screen.getByText("Finish setting up in your terminal")).toBeDefined(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("shows the form to a viewer whose only workspace is empty, instead of bouncing back", async () => {
    // The seam between this page and /device. /device sends this account here
    // rather than to project-only mode because creating a project needs MEMBER
    // or higher, so the workspace it already belongs to is no help. If this page
    // then counts that same workspace as done, the two disagree and every
    // "Continue setup" click lands the user straight back on /device: a loop
    // with no form in it.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.getWorkspaces.mockResolvedValue([VIEWER_EMPTY_WORKSPACE]);
    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
    // The workspace field is theirs to fill: the way out is a workspace of
    // their own, not the read-only one they cannot add to.
    expect(screen.getByPlaceholderText("Acme Inc")).toBeDefined();
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
    // Nothing offers a duplicate workspace in the meantime.
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
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
    renderPage(queryClient);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("stays on the hand-back page after the refetch reports the new project", async () => {
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
    expect(screen.getByText("Finish setting up in your terminal")).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sends an already-onboarded account with nobody waiting to its workspaces", async () => {
    mocks.getWorkspaces.mockResolvedValue([READY_WORKSPACE]);
    renderPage();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/workspaces"));
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("withholds the form until the workspace check settles", async () => {
    // Rendering the form while the check is in flight is the whole hazard: a
    // submit landing first creates the duplicate workspace the check exists to
    // prevent.
    const workspaces = deferred<{ id: string; name: string }[]>();
    mocks.getWorkspaces.mockReturnValue(workspaces.promise);
    renderPage();

    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();

    workspaces.resolve([]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("still lets a first-run account onboard when the workspace check fails", async () => {
    // A duplicate workspace is recoverable; an account that cannot reach this
    // form at all can never finish signing up. So a failed check shows the form.
    mocks.getWorkspaces.mockRejectedValue(new Error("workspaces unavailable"));
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeDefined());
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
    // Retrying under the error used to re-create the workspace. With the name
    // unchanged that hit `uq_workspace_created_by_name` and the route answered
    // 409, so the retry could not succeed; with the name edited it created a
    // second workspace and orphaned the first.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValueOnce(new Error("project boom"));
    renderPage();
    await clickCreate();
    await waitFor(() => expect(screen.getByText("project boom")).toBeDefined());

    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    await clickCreate();
    await waitFor(() =>
      expect(screen.getByText("Finish setting up in your terminal")).toBeDefined(),
    );

    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(2);
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, "ws-1", "my-llm-project");
  });

  it("renames the workspace it already made when the name is edited before a retry", async () => {
    // Reusing the workspace must not mean ignoring the field. The alternatives
    // are both wrong: a second workspace under the new name, or a workspace the
    // user has just told us they want called something else.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValueOnce(new Error("project boom"));
    mocks.updateWorkspace.mockResolvedValue({ id: "ws-1", name: "Acme" });
    renderPage();
    await clickCreate();
    await waitFor(() => expect(screen.getByText("project boom")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText("Acme Inc"), { target: { value: "Acme" } });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    await clickCreate();

    await waitFor(() => expect(mocks.updateWorkspace).toHaveBeenCalledWith("ws-1", "Acme"));
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, "ws-1", "my-llm-project");
  });

  it("does not rename the workspace when the name is unchanged on a retry", async () => {
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValueOnce(new Error("project boom"));
    renderPage();
    await clickCreate();
    await waitFor(() => expect(screen.getByText("project boom")).toBeDefined());

    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    await clickCreate();
    await waitFor(() =>
      expect(screen.getByText("Finish setting up in your terminal")).toBeDefined(),
    );

    expect(mocks.updateWorkspace).not.toHaveBeenCalled();
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
    // Nothing was created twice and nothing was renamed: the name is the one
    // that collided, so there is nothing to rename it to.
    expect(mocks.createWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorkspace).not.toHaveBeenCalled();
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
    await clickCreate();

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
    await clickCreate();

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
    await clickCreate();

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
    await clickCreate();

    await waitFor(() => expect(screen.getByText("workspace service unavailable")).toBeDefined());
    // Once, for the check that let the form render.
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

    await reachHandback();

    expect(mocks.getProjects).toHaveBeenCalledWith("ws-1");
    expect(shownCommand()).toContain("--project proj-existing");
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
    await clickCreate();

    await waitFor(() =>
      expect(screen.getByText("A project with this name already exists")).toBeDefined(),
    );
  });

  it("does not go looking for a project when the create failed for another reason", async () => {
    // A 500 says nothing about whether a project exists under this name, and
    // adopting one found anyway would hand the user a project this attempt has
    // no claim on.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1", name: "My Workspace" });
    mocks.createProject.mockRejectedValue(new ApiError(500, "project service unavailable"));
    renderPage();
    await clickCreate();

    await waitFor(() => expect(screen.getByText("project service unavailable")).toBeDefined());
    expect(mocks.getProjects).not.toHaveBeenCalled();
  });

  it("shows the derived workspace name once a pending session resolves", async () => {
    // `authClient.useSession()` starts pending on mount, and the hooks above
    // the loading gate run on that first render — so `useForm` captures its
    // defaults while the email is still unknown, i.e. "My Workspace" rather
    // than the company the address names. Something has to carry the real value
    // in afterwards, and the `values` prop is what does. Removing it without
    // putting a dirty-guarded `setValue` effect in its place silently sends
    // every company-domain account through setup under the wrong workspace
    // name, and no other test on this page would notice.
    setSession({ data: undefined, isPending: true });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    expect(screen.getByText("Loading...")).toBeDefined();

    act(() => {
      signedInAs("user-1", "kai@example.com");
    });

    const workspaceInput = await screen.findByPlaceholderText<HTMLInputElement>("Acme Inc");
    await waitFor(() => expect(workspaceInput.value).toBe("Example"));
  });

  it("still surfaces creation errors on step one", async () => {
    mocks.createWorkspace.mockRejectedValue(new Error("workspace boom"));
    renderPage();
    await clickCreate();

    await waitFor(() => expect(screen.getByText("workspace boom")).toBeDefined());
    expect(screen.queryByText("Finish setting up in your terminal")).toBeNull();
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
    await clickCreate();

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

    await waitFor(() => expect(screen.getByText("Could not sign out. Please try again.")));
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

    await waitFor(() => expect(screen.getByText("Could not sign out. Please try again.")));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Not you? Sign out" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("drops the way out once the project exists", async () => {
    // The hand-back step is about the project this account now owns, and the
    // app — user menu included — is one click away from it.
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    expect(screen.queryByRole("button", { name: "Not you? Sign out" })).toBeNull();
  });
});
