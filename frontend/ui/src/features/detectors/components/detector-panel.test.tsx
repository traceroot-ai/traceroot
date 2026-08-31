// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import type { Detector } from "../hooks/use-detectors";

const mocks = vi.hoisted(() => ({
  detector: undefined as Detector | undefined,
  mutate: vi.fn(),
  selectorProps: null as Record<string, unknown> | null,
  editedConditions: [] as Array<Record<string, unknown>>,
}));

vi.mock("../hooks/use-detectors", () => ({
  useDetector: () => ({ data: mocks.detector }),
  useUpdateDetector: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
// Stands in for the filter editor: the button hands the panel the rows a user
// would have built, which is all the panel sees of it.
vi.mock("./trigger-editor", () => ({
  TriggerEditor: ({ onChange }: { onChange?: (c: Array<Record<string, unknown>>) => void }) => (
    <button type="button" onClick={() => onChange?.(mocks.editedConditions)}>
      edit filter
    </button>
  ),
}));
vi.mock("./agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: Record<string, unknown>) => {
    mocks.selectorProps = props;
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
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const nameBox = () => screen.getByDisplayValue(baseDetector.name) as HTMLInputElement;
const editFilter = () => fireEvent.click(screen.getByRole("button", { name: "edit filter" }));

/** A detector saved before the trigger registry existed, holding a row it rejects. */
const legacyDetector: Detector = {
  ...baseDetector,
  trigger: { conditions: [{ field: "cost", op: ">", value: "" }] },
};

afterEach(() => {
  cleanup();
  mocks.detector = undefined;
  mocks.mutate.mockReset();
  mocks.selectorProps = null;
  mocks.editedConditions = [];
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

  it("closes without a network call when nothing changed", () => {
    mocks.detector = baseDetector;
    const { onClose } = renderPanel();
    fireEvent.click(saveButton());
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // Passed unconditionally: it names the model an empty selection falls back
  // to, so a pinned detector gets it too — the pin just wins over it. Both
  // fixtures are listed so the unpinned case the prop exists for is covered.
  it.each([
    ["unpinned", { ...baseDetector, detectionModel: null }],
    ["pinned", baseDetector],
  ])("hands the screening-model picker the system-default model id (%s)", (_label, detector) => {
    mocks.detector = detector;
    renderPanel();
    expect(mocks.selectorProps?.defaultModelId).toBe(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("clears the form and disables Save while the loaded detector does not match the id", () => {
    mocks.detector = baseDetector;
    renderPanel("det-2");
    expect(promptBox().value).toBe("");
    expect(saveButton().disabled).toBe(true);
  });
});

describe("DetectorPanel — a stored filter row the registry now rejects", () => {
  it("still saves a rename, because the rename does not rewrite the row", () => {
    mocks.detector = legacyDetector;
    renderPanel();
    fireEvent.change(nameBox(), { target: { value: "Renamed" } });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ name: "Renamed" });
  });

  it("blocks the save once that row is edited, and says why on screen", () => {
    mocks.detector = legacyDetector;
    renderPanel();
    mocks.editedConditions = [{ field: "cost", op: ">=", value: "" }];
    editFilter();

    expect(screen.getByText("condition 1 requires a non-negative number")).toBeDefined();
    expect(saveButton().disabled).toBe(true);
  });
});

describe("DetectorPanel — the conditions it sends", () => {
  it("sends the metadata key without the whitespace around it", () => {
    mocks.detector = baseDetector;
    renderPanel();
    mocks.editedConditions = [{ field: "metadata", op: "=", value: "acme", key: " tenant " }];
    editFilter();
    fireEvent.click(saveButton());

    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      triggerConditions: [{ field: "metadata", op: "=", value: "acme", key: "tenant" }],
    });
  });

  it("sends a typed numeric value as a number", () => {
    mocks.detector = baseDetector;
    renderPanel();
    mocks.editedConditions = [{ field: "duration_ms", op: ">", value: "4500" }];
    editFilter();
    fireEvent.click(saveButton());

    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      triggerConditions: [{ field: "duration_ms", op: ">", value: 4500 }],
    });
  });
});
