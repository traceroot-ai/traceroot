// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { getTemplate } from "@/features/detectors/templates";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ id: "det-1" }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useCreateDetector: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role: "MEMBER" } }),
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
  mocks.push.mockClear();
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
});
