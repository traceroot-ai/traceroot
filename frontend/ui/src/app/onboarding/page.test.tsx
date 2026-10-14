// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
  getWorkspaces: vi.fn(),
  params: new URLSearchParams(),
}));

function setParams(init: Record<string, string>) {
  mocks.params = new URLSearchParams(init);
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.params,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { email: "kai@example.com" } },
      isPending: false,
    }),
  },
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHeaderContent: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  createWorkspace: mocks.createWorkspace,
  createProject: mocks.createProject,
  getWorkspaces: mocks.getWorkspaces,
}));
vi.mock("@/features/detectors/components/add-detectors-step", () => ({
  AddDetectorsStep: ({
    projectId,
    projectName,
    onDone,
  }: {
    projectId: string;
    projectName: string;
    onDone: () => void;
  }) => (
    <div data-testid="add-detectors-step" data-project-id={projectId}>
      <span>{projectName}</span>
      <button onClick={onDone}>mock-done</button>
    </div>
  ),
}));

import OnboardingPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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

async function completeStepOne() {
  await clickCreate();
  await waitFor(() => expect(screen.getByTestId("add-detectors-step")).toBeDefined());
}

beforeEach(() => {
  // The page refuses to onboard an account that already owns a workspace, so
  // every test that exercises the form is a first-run account unless it says
  // otherwise.
  mocks.getWorkspaces.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.createProject.mockReset();
  mocks.getWorkspaces.mockReset();
  mocks.params = new URLSearchParams();
});

describe("OnboardingPage", () => {
  it("shows the detectors step after workspace + project creation instead of redirecting", async () => {
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await completeStepOne();

    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
    expect(mocks.createProject).toHaveBeenCalledWith("ws-1", "my-llm-project");
    expect(screen.getByTestId("add-detectors-step").dataset.projectId).toBe("proj-1");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("navigates to traces when the detectors step finishes", async () => {
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();
    await completeStepOne();

    fireEvent.click(screen.getByRole("button", { name: "mock-done" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/traces");
  });

  it("hands straight back to a waiting caller instead of asking about detectors", async () => {
    // `traceroot setup` is holding a terminal open on the device approval this
    // page runs ahead of. Detectors only ever run on trace ingest, so asking now
    // produces nothing and delays the handoff behind a judgement call the user
    // has no basis to make yet.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    await clickCreate();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(screen.queryByTestId("add-detectors-step")).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId("add-detectors-step")).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("hands an account that already owns a workspace straight back to the caller", async () => {
    // The Google button on /auth/sign-up routes through here, and better-auth
    // has no social sign-up to distinguish from social sign-in — so an existing
    // account, or an email account linked to the same Google identity, arrives
    // on this page without being new. It owns the workspace the terminal was
    // waiting for, so there is nothing to do but hand back.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.getWorkspaces.mockResolvedValue([{ id: "ws-existing", name: "Example" }]);
    renderPage();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("sends an already-onboarded account with nobody waiting to its workspaces", async () => {
    mocks.getWorkspaces.mockResolvedValue([{ id: "ws-existing", name: "Example" }]);
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
    await completeStepOne();
    expect(mocks.createWorkspace).toHaveBeenCalledWith("Example");
  });

  it("does not check for a workspace when adding a project to one", async () => {
    // `?workspaceId=` means "add a project to this workspace I already own", so
    // owning one is the precondition here rather than a reason to leave.
    setParams({ workspaceId: "ws-existing", workspaceName: "Example" });
    mocks.createProject.mockResolvedValue({ id: "proj-2", name: "my-llm-project" });
    renderPage();

    await completeStepOne();
    expect(mocks.getWorkspaces).not.toHaveBeenCalled();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith("ws-existing", "my-llm-project");
  });

  it("still surfaces creation errors on step one", async () => {
    mocks.createWorkspace.mockRejectedValue(new Error("workspace boom"));
    renderPage();
    await clickCreate();

    await waitFor(() => expect(screen.getByText("workspace boom")).toBeDefined());
    expect(screen.queryByTestId("add-detectors-step")).toBeNull();
  });
});
