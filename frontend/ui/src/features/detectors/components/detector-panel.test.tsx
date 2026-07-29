// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Detector } from "../hooks/use-detectors";

const mocks = vi.hoisted(() => ({
  detector: undefined as Detector | undefined,
  mutate: vi.fn(),
  workspaceData: undefined as { role: string } | undefined,
  mutateIsError: false,
  mutateError: null as Error | null,
}));

vi.mock("../hooks/use-detectors", () => ({
  useDetector: () => ({ data: mocks.detector }),
  useUpdateDetector: () => ({
    mutate: mocks.mutate,
    isPending: false,
    isError: mocks.mutateIsError,
    error: mocks.mutateError,
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspaceData }),
}));
vi.mock("./trigger-editor", () => ({
  TriggerEditor: () => null,
}));
vi.mock("./agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: () => null,
}));
vi.mock("./rca-toggle", () => ({
  RcaToggle: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      data-testid="rca-toggle"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

import { DetectorPanel } from "./detector-panel";

const baseDetector: Detector = {
  id: "det-1",
  projectId: "proj-1",
  name: "Latency spikes",
  template: "custom",
  prompt: "Find slow spans",
  outputSchema: [],
  sampleRate: 50,
  enableRca: true,
  detectionModel: "model-a",
  detectionProvider: "provider-a",
  detectionSource: "system",
  createTime: "2026-06-01T00:00:00Z",
  updateTime: "2026-06-01T00:00:00Z",
  trigger: { conditions: [] },
};

function renderPanel(detectorId = "det-1") {
  const onClose = vi.fn();
  const view = render(
    <DetectorPanel detectorId={detectorId} projectId="proj-1" onClose={onClose} />,
  );
  const rerender = () =>
    view.rerender(<DetectorPanel detectorId={detectorId} projectId="proj-1" onClose={onClose} />);
  return { onClose, rerender };
}

const rcaToggle = () => screen.getByTestId("rca-toggle") as HTMLInputElement;
const promptBox = () => document.querySelector("textarea") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });

afterEach(() => {
  cleanup();
  mocks.detector = undefined;
  mocks.workspaceData = undefined;
  mocks.mutateIsError = false;
  mocks.mutateError = null;
  mocks.mutate.mockReset();
});

describe("DetectorPanel", () => {
  it("populates the form from the loaded detector", () => {
    mocks.detector = baseDetector;
    renderPanel();
    expect(screen.getByDisplayValue("Latency spikes")).toBeDefined();
    expect(promptBox().value).toBe("Find slow spans");
    expect(rcaToggle().checked).toBe(true);
  });

  it("adopts a remote toggle change while preserving an in-progress prompt edit", () => {
    mocks.detector = baseDetector;
    const { rerender } = renderPanel();
    fireEvent.change(promptBox(), { target: { value: "my draft" } });

    mocks.detector = { ...baseDetector, enableRca: false };
    rerender();

    expect(rcaToggle().checked).toBe(false);
    expect(promptBox().value).toBe("my draft");
  });

  it("saves only the fields the user changed", () => {
    mocks.detector = baseDetector;
    mocks.workspaceData = { role: "MEMBER" };
    const { onClose } = renderPanel();
    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });

    const options = mocks.mutate.mock.calls[0][1] as { onSuccess: () => void };
    options.onSuccess();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without a network call when nothing changed", () => {
    mocks.detector = baseDetector;
    mocks.workspaceData = { role: "MEMBER" };
    const { onClose } = renderPanel();
    fireEvent.click(saveButton());
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("clears the form and disables Save while the loaded detector does not match the id", () => {
    mocks.detector = baseDetector;
    renderPanel("det-2");
    expect(promptBox().value).toBe("");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Save for VIEWER role", () => {
    mocks.detector = baseDetector;
    mocks.workspaceData = { role: "VIEWER" };
    renderPanel();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows error message when Save fails", () => {
    mocks.detector = baseDetector;
    mocks.workspaceData = { role: "MEMBER" };
    mocks.mutateIsError = true;
    mocks.mutateError = new Error("Server error");
    renderPanel();
    expect(screen.getByText("Server error")).toBeDefined();
  });
});
