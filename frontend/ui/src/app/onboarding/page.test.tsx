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
  params: new URLSearchParams(),
  // The user carries an id as well as an email, because the page caches the
  // workspace list per account: a session without one would key every
  // account's list together, which is the bug these tests would then be blind
  // to.
  session: {
    state: {
      data: { user: { id: "user-1", email: "kai@example.com" } },
      isPending: false,
    } as SessionState,
    listeners: new Set<() => void>(),
  },
}));

// Shaped like GET /api/workspaces answers it (see app/api/workspaces/route.ts).
// `role` and `project_count` are what the handoff decision reads, so a stub
// without them would prove nothing about the real payload.
const READY_WORKSPACE = { id: "ws-existing", name: "Example", role: "ADMIN", project_count: 1 };
const EMPTY_WORKSPACE = { id: "ws-empty", name: "Example", role: "ADMIN", project_count: 0 };
const VIEWER_EMPTY_WORKSPACE = { ...EMPTY_WORKSPACE, role: "VIEWER" };

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
  },
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHeaderContent: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  createWorkspace: mocks.createWorkspace,
  updateWorkspace: mocks.updateWorkspace,
  createProject: mocks.createProject,
  getWorkspaces: mocks.getWorkspaces,
}));
import OnboardingPage from "./page";

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

beforeEach(() => {
  // Reset explicitly: `signedInAs` mutates a store that outlives the test that
  // called it, so a later test would otherwise inherit whichever account the
  // previous one switched to.
  signedInAs("user-1", "kai@example.com");
  // The page refuses to onboard an account that already owns a workspace, so
  // every test that exercises the form is a first-run account unless it says
  // otherwise.
  mocks.getWorkspaces.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.updateWorkspace.mockReset();
  mocks.createProject.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.params = new URLSearchParams();
  signedInAs("user-1", "kai@example.com");
});

describe("OnboardingPage", () => {
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
    expect(shownCommand()).toContain("npx -y traceroot-cli@latest setup");
    expect(shownCommand()).toContain("--project proj-1");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sends a user who would rather not run the command to the manual walkthrough", async () => {
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await reachHandback();

    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces");
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
    // POST /api/workspaces has no name-uniqueness check, so the retry under the
    // error re-created the workspace and left a second, identically-named
    // orphan behind — invisible to the user who caused it, and
    // indistinguishable from the real one on the workspace list.
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
});
