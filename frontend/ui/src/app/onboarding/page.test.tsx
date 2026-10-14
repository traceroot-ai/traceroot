// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
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

async function completeStepOne() {
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(screen.getByTestId("add-detectors-step")).toBeDefined());
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.createWorkspace.mockReset();
  mocks.createProject.mockReset();
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

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    expect(screen.queryByTestId("add-detectors-step")).toBeNull();
  });

  it("hands back only after both the workspace and the project exist", async () => {
    // The whole point of the change: the terminal is released last. Asserting
    // that `push` was called with the device URL does not say this — hoisting
    // the push above both awaits satisfies that and reintroduces the bug.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockResolvedValue({ id: "proj-1", name: "my-llm-project" });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/device?user_code=ABCD1234"));
    const pushedAt = mocks.push.mock.invocationCallOrder[0] as number;
    expect(mocks.createWorkspace.mock.invocationCallOrder[0]).toBeLessThan(pushedAt);
    expect(mocks.createProject.mock.invocationCallOrder[0]).toBeLessThan(pushedAt);
  });

  it("does not hand back when the project could not be created", async () => {
    // A terminal released against a workspace with no project is the same dead
    // end from the other direction.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.createWorkspace.mockResolvedValue({ id: "ws-1" });
    mocks.createProject.mockRejectedValue(new Error("project creation failed"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // A rejected value means there is nowhere to hand back to, which is the
    // same position as a user who arrived on their own — so the normal flow
    // continues and nothing is pushed. Asserting `push("/")` here used to pass
    // only because the validator answered a rejected value with its fallback,
    // which sent a new account to the root instead of its traces.
    await waitFor(() => expect(screen.getByTestId("add-detectors-step")).toBeDefined());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("still surfaces creation errors on step one", async () => {
    mocks.createWorkspace.mockRejectedValue(new Error("workspace boom"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("workspace boom")).toBeDefined());
    expect(screen.queryByTestId("add-detectors-step")).toBeNull();
  });
});
