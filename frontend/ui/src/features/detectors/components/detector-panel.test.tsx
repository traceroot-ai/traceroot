// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Detector } from "../hooks/use-detectors";

const mocks = vi.hoisted(() => ({
  detector: undefined as Detector | undefined,
  mutate: vi.fn(),
  resetMutation: vi.fn(),
  updateError: null as Error | null,
  modelSelectorProps: [] as Array<{ disabled?: boolean }>,
  triggerEditorProps: [] as Array<{ readOnly?: boolean }>,
}));

vi.mock("../hooks/use-detectors", () => ({
  useDetector: () => ({ data: mocks.detector }),
  useUpdateDetector: () => ({
    mutate: mocks.mutate,
    reset: mocks.resetMutation,
    isPending: false,
    isError: !!mocks.updateError,
    error: mocks.updateError,
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("./trigger-editor", () => ({
  TriggerEditor: (props: { readOnly?: boolean }) => {
    mocks.triggerEditorProps.push(props);
    return <input data-testid="trigger-editor" disabled={props.readOnly} readOnly />;
  },
}));
vi.mock("./agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: { disabled?: boolean }) => {
    mocks.modelSelectorProps.push(props);
    return <button disabled={props.disabled}>Select model</button>;
  },
}));
vi.mock("./rca-toggle", () => ({
  RcaToggle: ({
    id,
    checked,
    onCheckedChange,
    disabled,
  }: {
    id: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      data-testid="rca-toggle"
      id={id}
      checked={checked}
      disabled={disabled}
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

function renderPanel(detectorId = "det-1", canEdit = true) {
  const onClose = vi.fn();
  const view = render(
    <DetectorPanel
      detectorId={detectorId}
      projectId="proj-1"
      canEdit={canEdit}
      onClose={onClose}
    />,
  );
  const rerender = () =>
    view.rerender(
      <DetectorPanel
        detectorId={detectorId}
        projectId="proj-1"
        canEdit={canEdit}
        onClose={onClose}
      />,
    );
  return { onClose, rerender };
}

const rcaToggle = () => screen.getByTestId("rca-toggle") as HTMLInputElement;
const promptBox = () => document.querySelector("textarea") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });

afterEach(() => {
  cleanup();
  mocks.detector = undefined;
  mocks.mutate.mockReset();
  mocks.resetMutation.mockReset();
  mocks.updateError = null;
  mocks.modelSelectorProps = [];
  mocks.triggerEditorProps = [];
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
    const { onClose } = renderPanel();
    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.resetMutation).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });

    const options = mocks.mutate.mock.calls[0][1] as { onSuccess: () => void };
    options.onSuccess();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without a network call when nothing changed", () => {
    mocks.detector = baseDetector;
    const { onClose } = renderPanel();
    fireEvent.click(saveButton());
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renders API permission errors when save fails", () => {
    mocks.detector = baseDetector;
    mocks.updateError = new Error("Members and admins can edit detectors");
    renderPanel();

    expect(screen.getByRole("alert").textContent).toContain(
      "Members and admins can edit detectors",
    );
  });

  it("clears the form and disables Save while the loaded detector does not match the id", () => {
    mocks.detector = baseDetector;
    renderPanel("det-2");
    expect(promptBox().value).toBe("");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a read-only message when editing is not allowed", () => {
    mocks.detector = baseDetector;
    renderPanel("det-1", false);

    expect(
      screen.getByText("Members and admins can edit detectors for this project."),
    ).toBeDefined();
    expect((screen.getByDisplayValue("Latency spikes") as HTMLInputElement).disabled).toBe(true);
    expect(promptBox().disabled).toBe(true);
    expect(rcaToggle().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Select model" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId("trigger-editor") as HTMLInputElement).disabled).toBe(true);
    expect(mocks.modelSelectorProps[mocks.modelSelectorProps.length - 1]?.disabled).toBe(true);
    expect(mocks.triggerEditorProps[mocks.triggerEditorProps.length - 1]?.readOnly).toBe(true);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
