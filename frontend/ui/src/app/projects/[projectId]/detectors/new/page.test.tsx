// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import { getTemplate } from "@/features/detectors/templates";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ id: "det-1" }),
  selectorProps: null as Record<string, unknown> | null,
  editedConditions: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useCreateDetector: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => null,
}));
vi.mock("@/features/ai-assistant/components/model-selector", () => ({
  ModelSelector: (props: Record<string, unknown>) => {
    mocks.selectorProps = props;
    return null;
  },
}));
// Stands in for the filter editor: the button hands the page the rows a user
// would have built, which is all the page sees of it.
vi.mock("@/features/detectors/components/trigger-editor", () => ({
  TriggerEditor: ({ onChange }: { onChange?: (c: Array<Record<string, unknown>>) => void }) => (
    <button type="button" onClick={() => onChange?.(mocks.editedConditions)}>
      edit filter
    </button>
  ),
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
  mocks.selectorProps = null;
  mocks.editedConditions = [];
});

const createButton = () =>
  screen.getByRole("button", { name: "Create Detector" }) as HTMLButtonElement;
const editFilter = () => fireEvent.click(screen.getByRole("button", { name: "edit filter" }));

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

  it("renders the screening-model picker with a system-default model id (no auto-pick)", () => {
    render(<NewDetectorPage />);
    expect(mocks.selectorProps?.defaultModelId).toBe(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
  });
});

describe("NewDetectorPage — an incomplete filter row", () => {
  it("says on screen why Create is blocked", () => {
    render(<NewDetectorPage />);
    mocks.editedConditions = [{ field: "metadata", op: "=", value: "acme", key: " " }];
    editFilter();

    expect(screen.getByText("condition 1 requires a metadata key")).toBeDefined();
    expect(createButton().disabled).toBe(true);
  });
});

describe("NewDetectorPage — the conditions it submits", () => {
  it("submits the metadata key without the whitespace around it", async () => {
    render(<NewDetectorPage />);
    mocks.editedConditions = [{ field: "metadata", op: "=", value: "acme", key: " tenant " }];
    editFilter();
    fireEvent.click(createButton());

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      triggerConditions: [{ field: "metadata", op: "=", value: "acme", key: "tenant" }],
    });
  });

  it("submits a typed numeric value as a number", async () => {
    render(<NewDetectorPage />);
    mocks.editedConditions = [{ field: "duration_ms", op: ">", value: "4500" }];
    editFilter();
    fireEvent.click(createButton());

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      triggerConditions: [{ field: "duration_ms", op: ">", value: 4500 }],
    });
  });
});
