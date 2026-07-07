// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import type { Detector } from "../hooks/use-detectors";

const mocks = vi.hoisted(() => ({
  detector: undefined as Detector | undefined,
  mutate: vi.fn(),
  modelSelectorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("../hooks/use-detectors", () => ({
  useDetector: () => ({ data: mocks.detector }),
  useUpdateDetector: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("./trigger-editor", () => ({
  TriggerEditor: () => null,
}));
vi.mock("./agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: Record<string, unknown>) => {
    mocks.modelSelectorProps.push(props);
    return null;
  },
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
  mocks.mutate.mockReset();
  mocks.modelSelectorProps = [];
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
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });

    const options = mocks.mutate.mock.calls[0][1] as { onSuccess: () => void };
    options.onSuccess();
    expect(onClose).toHaveBeenCalled();
  });

  it("does not allow fallback model auto-pick in the detector edit selector", () => {
    mocks.detector = baseDetector;
    renderPanel();
    expect(mocks.modelSelectorProps.at(-1)).toMatchObject({
      includeFallbackModels: false,
      hideUnsupportedModels: true,
    });
  });

  it("saves a complete model tuple when a legacy detector gets selector fields backfilled", () => {
    mocks.detector = {
      ...baseDetector,
      detectionModel: null,
      detectionProvider: null,
      detectionSource: null,
    };
    renderPanel();
    const selectorProps = mocks.modelSelectorProps.at(-1) as {
      onChange: (selection: {
        model: string;
        provider: string;
        source: "system" | "byok";
        adapter: string;
      }) => void;
    };

    act(() => {
      selectorProps.onChange({
        model: "model-a",
        provider: "provider-a",
        source: "system",
        adapter: "anthropic",
      });
    });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        detectionModel: "model-a",
        detectionProvider: "provider-a",
        detectionSource: "system",
      },
      expect.any(Object),
    );
  });

  it("shows update API errors inline without closing the panel", async () => {
    mocks.detector = baseDetector;
    const { onClose } = renderPanel();
    mocks.mutate.mockImplementation((_patch, options: { onError: (error: Error) => void }) => {
      options.onError(new Error("Selected BYOK model is not supported by Traceroot"));
    });

    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Selected BYOK model is not supported by Traceroot",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without a network call when nothing changed", () => {
    mocks.detector = baseDetector;
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
});
