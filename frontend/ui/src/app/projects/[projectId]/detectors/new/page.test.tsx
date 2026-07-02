// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { getTemplate } from "@/features/detectors/templates";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ id: "det-1" }),
  resetMutation: vi.fn(),
  createError: null as Error | null,
  workspaceRole: "MEMBER" as string | undefined,
  workspaceLoading: false,
  workspaceError: null as Error | null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useCreateDetector: () => ({
    mutateAsync: mocks.mutateAsync,
    reset: mocks.resetMutation,
    isPending: false,
    isError: !!mocks.createError,
    error: mocks.createError,
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({
    data: mocks.workspaceRole ? { role: mocks.workspaceRole } : undefined,
    isLoading: mocks.workspaceLoading,
    error: mocks.workspaceError,
  }),
}));
vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: () => null,
}));
vi.mock("@/features/detectors/components/trigger-editor", () => ({
  TriggerEditor: () => null,
}));
vi.mock("@/features/detectors/components/agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/detectors/components/rca-toggle", () => ({
  RcaToggle: () => null,
}));

import NewDetectorPage from "./page";

afterEach(() => {
  cleanup();
  mocks.mutateAsync.mockClear();
  mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
  mocks.resetMutation.mockClear();
  mocks.push.mockClear();
  mocks.createError = null;
  mocks.workspaceRole = "MEMBER";
  mocks.workspaceLoading = false;
  mocks.workspaceError = null;
});

describe("NewDetectorPage", () => {
  it("submits the selected template's defaults", async () => {
    render(<NewDetectorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    const failure = getTemplate("failure")!;
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      name: "Failure Detector",
      template: "failure",
      prompt: failure.prompt,
      outputSchema: failure.outputSchema,
      triggerConditions: failure.defaultConditions,
      sampleRate: 25,
      enabled: true,
      enableRca: true,
      detectionModel: undefined,
      detectionProvider: undefined,
      detectionSource: "system",
    });
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors");
  });

  it("renders API permission errors when create fails", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("Members and admins can create detectors"));
    mocks.createError = new Error("Members and admins can create detectors");

    render(<NewDetectorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain(
      "Members and admins can create detectors",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("submits user-edited name and prompt over the template defaults", async () => {
    render(<NewDetectorPage />);
    fireEvent.change(screen.getByDisplayValue("Failure Detector"), {
      target: { value: "My detector" },
    });
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: "my prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      name: "My detector",
      prompt: "my prompt",
      template: "failure",
    });
  });

  it("does not expose the create form to viewers", () => {
    mocks.workspaceRole = "VIEWER";
    render(<NewDetectorPage />);

    expect(screen.queryByRole("button", { name: "Create Detector" })).toBeNull();
    expect(
      screen.getByText("Members and admins can create detectors for this project."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Back to Detectors" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors");
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not expose the create form while detector permissions are loading", () => {
    mocks.workspaceRole = undefined;
    mocks.workspaceLoading = true;

    render(<NewDetectorPage />);

    expect(screen.queryByRole("button", { name: "Create Detector" })).toBeNull();
    expect(screen.getByText("Checking detector permissions...")).toBeDefined();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });
});
