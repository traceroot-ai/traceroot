// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createWorkspace: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
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

  it("still surfaces creation errors on step one", async () => {
    mocks.createWorkspace.mockRejectedValue(new Error("workspace boom"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("workspace boom")).toBeDefined());
    expect(screen.queryByTestId("add-detectors-step")).toBeNull();
  });
});
