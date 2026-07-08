// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import type { Detector } from "../hooks/use-detectors";

const mocks = vi.hoisted(() => ({
  detector: undefined as Detector | undefined,
  mutate: vi.fn(),
  triggerEditorProps: [] as Array<{
    conditions: Array<{ field: string; op: string; value: unknown }>;
    onChange?: (conditions: Array<{ field: string; op: string; value: unknown }>) => void;
  }>,
}));

vi.mock("../hooks/use-detectors", () => ({
  detectorMutationErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error &&
    error.message === "triggerConditions[0].op must be one of =, != for environment"
      ? "Environment filters only support = or !=."
      : error instanceof Error
        ? error.message
        : fallback,
  isTriggerConditionMutationError: (message: string) =>
    message === "Environment filters only support = or !=." ||
    message.startsWith("triggerConditions"),
  useDetector: () => ({ data: mocks.detector }),
  useUpdateDetector: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("./trigger-editor", () => ({
  TriggerEditor: (props: (typeof mocks.triggerEditorProps)[number]) => {
    mocks.triggerEditorProps.push(props);
    return null;
  },
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
  mocks.mutate.mockReset();
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
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });

    const options = mocks.mutate.mock.calls[0][1] as { onSuccess: () => void };
    options.onSuccess();
    expect(onClose).toHaveBeenCalled();
  });

  it("does not overwrite unsupported legacy filter conditions on unrelated edits", () => {
    mocks.detector = {
      ...baseDetector,
      trigger: { conditions: [{ field: "duration", op: "gt", value: 1000 }] },
    };
    renderPanel();

    expect(screen.getByText(/hidden legacy filter conditions/i)).toBeDefined();
    expect(mocks.triggerEditorProps.at(-1)?.conditions).toEqual([]);

    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });
  });

  it("treats nullable environment filters as supported editable filters", () => {
    const nullableCondition = { field: "environment", op: "=", value: null };
    mocks.detector = {
      ...baseDetector,
      trigger: { conditions: [nullableCondition] },
    };
    renderPanel();

    expect(screen.queryByText(/hidden legacy filter conditions/i)).toBeNull();
    expect(mocks.triggerEditorProps.at(-1)?.conditions).toEqual([nullableCondition]);

    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });
  });

  it("saves a nullable environment filter edited from a string value", () => {
    const initialCondition = { field: "environment", op: "=", value: "production" };
    const nullableCondition = { field: "environment", op: "=", value: null };
    mocks.detector = {
      ...baseDetector,
      trigger: { conditions: [initialCondition] },
    };
    renderPanel();

    act(() => {
      mocks.triggerEditorProps.at(-1)?.onChange?.([nullableCondition]);
    });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      triggerConditions: [nullableCondition],
    });
  });

  it("sends an empty trigger replacement when discarding unsupported legacy filters", () => {
    mocks.detector = {
      ...baseDetector,
      trigger: { conditions: [{ field: "duration", op: "gt", value: 1000 }] },
    };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /discard hidden filters on save/i }));
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ triggerConditions: [] });
  });

  it("blocks hidden legacy filter replacement until discard is explicitly selected", () => {
    const visibleCondition = { field: "environment", op: "=", value: "production" };
    mocks.detector = {
      ...baseDetector,
      trigger: {
        conditions: [visibleCondition, { field: "duration", op: "gt", value: 1000 }],
      },
    };
    renderPanel();

    expect(mocks.triggerEditorProps.at(-1)?.conditions).toEqual([visibleCondition]);
    const replacementCondition = { field: "environment", op: "=", value: "staging" };
    act(() => {
      mocks.triggerEditorProps.at(-1)?.onChange?.([replacementCondition]);
    });
    fireEvent.click(saveButton());

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose Discard hidden filters on save before saving filter changes.",
    );
  });

  it("allows unrelated edits after a no-op legacy filter interaction", () => {
    const visibleCondition = { field: "environment", op: "=", value: "production" };
    mocks.detector = {
      ...baseDetector,
      trigger: {
        conditions: [visibleCondition, { field: "duration", op: "gt", value: 1000 }],
      },
    };
    renderPanel();

    act(() => {
      mocks.triggerEditorProps.at(-1)?.onChange?.([visibleCondition]);
    });
    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });
  });

  it("allows unrelated edits after a legacy filter edit is reverted", () => {
    const visibleCondition = { field: "environment", op: "=", value: "production" };
    const replacementCondition = { field: "environment", op: "=", value: "staging" };
    mocks.detector = {
      ...baseDetector,
      trigger: {
        conditions: [visibleCondition, { field: "duration", op: "gt", value: 1000 }],
      },
    };
    renderPanel();

    act(() => {
      mocks.triggerEditorProps.at(-1)?.onChange?.([replacementCondition]);
      mocks.triggerEditorProps.at(-1)?.onChange?.([visibleCondition]);
    });
    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });
  });

  it("replaces hidden mixed legacy filters after discard is explicitly selected", () => {
    const visibleCondition = { field: "environment", op: "=", value: "production" };
    mocks.detector = {
      ...baseDetector,
      trigger: {
        conditions: [visibleCondition, { field: "duration", op: "gt", value: 1000 }],
      },
    };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /discard hidden filters on save/i }));
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ triggerConditions: [visibleCondition] });
  });

  it("lets users undo hidden legacy filter discard before saving", () => {
    const visibleCondition = { field: "environment", op: "=", value: "production" };
    mocks.detector = {
      ...baseDetector,
      trigger: {
        conditions: [visibleCondition, { field: "duration", op: "gt", value: 1000 }],
      },
    };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /discard hidden filters on save/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep hidden filters/i }));
    fireEvent.change(promptBox(), { target: { value: "new prompt" } });
    fireEvent.click(saveButton());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ prompt: "new prompt" });
  });

  it("keeps the legacy filter warning visible while replacement edits are unsaved", () => {
    mocks.detector = {
      ...baseDetector,
      trigger: { conditions: [{ field: "duration", op: "gt", value: 1000 }] },
    };
    renderPanel();

    mocks.triggerEditorProps
      .at(-1)
      ?.onChange?.([{ field: "environment", op: "=", value: "production" }]);

    expect(screen.getByText(/hidden legacy filter conditions/i)).toBeDefined();
  });

  it("shows mutation validation errors inline when save fails", () => {
    mocks.detector = baseDetector;
    mocks.mutate.mockImplementation((_patch, options) => {
      options.onError(new Error("triggerConditions[0].op must be one of =, != for environment"));
    });
    renderPanel();

    act(() => {
      mocks.triggerEditorProps
        .at(-1)
        ?.onChange?.([{ field: "environment", op: ">", value: "production" }]);
    });
    fireEvent.click(saveButton());

    expect(screen.getByRole("alert").textContent).toContain(
      "Environment filters only support = or !=.",
    );
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
