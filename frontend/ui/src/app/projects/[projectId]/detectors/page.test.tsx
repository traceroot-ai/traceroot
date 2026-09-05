// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";

const mocks = vi.hoisted(() => ({ push: vi.fn(), useDetectorList: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));

// Controlled list state so the test asserts the exact range carried into the URL.
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: { id: "7d" }, customStartDate: null, customEndDate: null, keyword: "" },
    queryOptions: { page: 1, limit: 50 },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

const defaultDetectorList = {
  data: {
    data: [
      {
        id: "det-1",
        name: "My Detector",
        template: "failure",
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        sampleRate: 25,
        createTime: "2026-06-15T00:00:00.000Z",
        updateTime: "2026-06-15T00:00:00.000Z",
      },
      {
        id: "det-2",
        name: "Pinned Detector",
        template: "failure",
        detectionModel: "gpt-5.4",
        detectionProvider: "OpenAI",
        detectionSource: "system",
        sampleRate: 100,
        createTime: "2026-06-16T00:00:00.000Z",
        updateTime: "2026-06-16T00:00:00.000Z",
      },
      {
        id: "det-3",
        name: "BYOK Detector",
        template: "failure",
        detectionModel: null,
        detectionProvider: "Anthropic BYOK",
        detectionSource: "byok",
        sampleRate: 100,
        createTime: "2026-06-17T00:00:00.000Z",
        updateTime: "2026-06-17T00:00:00.000Z",
      },
      {
        id: "det-4",
        name: "Pinned BYOK Detector",
        template: "failure",
        detectionModel: "gpt-5.4",
        detectionProvider: "OpenAI BYOK",
        detectionSource: "byok",
        sampleRate: 100,
        createTime: "2026-06-18T00:00:00.000Z",
        updateTime: "2026-06-18T00:00:00.000Z",
      },
      {
        id: "det-5",
        name: "Legacy Detector",
        template: "failure",
        detectionModel: null,
        detectionProvider: null,
        detectionSource: null,
        sampleRate: 100,
        createTime: "2026-06-19T00:00:00.000Z",
        updateTime: "2026-06-19T00:00:00.000Z",
      },
    ],
    meta: { total: 5 },
  },
  isLoading: false,
  error: null,
  refetch: vi.fn(),
};

vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useDetectorList: (...args: unknown[]) => mocks.useDetectorList(...args),
  useDetectorCounts: () => ({ data: {}, isLoading: false }),
  useDeleteDetector: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: undefined }) }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({
    retentionDays: 15,
    showPricing: false,
    onUpgradeClick: vi.fn(),
    closePricing: vi.fn(),
    workspaceId: "ws-1",
    billingPlan: "free",
  }),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/detectors/components/delete-detector-dialog", () => ({
  DeleteDetectorDialog: () => null,
}));
vi.mock("@/features/detectors/components/detector-panel", () => ({ DetectorPanel: () => null }));

import DetectorsPage from "./page";

mocks.useDetectorList.mockReturnValue(defaultDetectorList);

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
  mocks.useDetectorList.mockReset();
  mocks.useDetectorList.mockReturnValue(defaultDetectorList);
});

describe("DetectorsPage", () => {
  it("shows the resolved detector default model, unadorned", () => {
    render(<DetectorsPage />);

    const defaultRow = screen.getByText("My Detector").closest("tr");
    expect(defaultRow).not.toBeNull();
    expect(defaultRow?.textContent).toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
    expect(defaultRow?.textContent).not.toContain("(default)");
  });

  it("shows the provider name for BYOK detectors without a model", () => {
    render(<DetectorsPage />);

    const byokRow = screen.getByText("BYOK Detector").closest("tr");
    expect(byokRow).not.toBeNull();
    expect(byokRow?.textContent).toContain("Anthropic BYOK");
    expect(byokRow?.textContent).not.toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("labels legacy null-source detectors with the screening default the worker uses", () => {
    render(<DetectorsPage />);

    const legacyRow = screen.getByText("Legacy Detector").closest("tr");
    expect(legacyRow).not.toBeNull();
    expect(legacyRow?.textContent).toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
    expect(legacyRow?.textContent).not.toContain("Auto-selected");
  });

  it("shows a pinned model id verbatim", () => {
    render(<DetectorsPage />);

    const pinnedRow = screen.getByText("Pinned Detector").closest("tr");
    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow?.textContent).toContain("gpt-5.4");
  });

  it("prefers a BYOK detector's pinned model over its provider name", () => {
    render(<DetectorsPage />);

    const pinnedByokRow = screen.getByText("Pinned BYOK Detector").closest("tr");
    expect(pinnedByokRow).not.toBeNull();
    expect(pinnedByokRow?.textContent).toContain("gpt-5.4");
    expect(pinnedByokRow?.textContent).not.toContain("OpenAI BYOK");
  });

  it("carries the selected time range into the detector detail URL on row click", () => {
    render(<DetectorsPage />);

    fireEvent.click(screen.getByText("My Detector"));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors/det-1?date_filter=7d");
  });

  it("shows the empty state with its glyph when the project has no detectors", () => {
    mocks.useDetectorList.mockReturnValue({
      data: { data: [], meta: { total: 0 } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<DetectorsPage />);

    const heading = screen.getByText("No detectors yet");
    expect(heading.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("shows the error state with a retry that refetches", () => {
    const refetch = vi.fn();
    mocks.useDetectorList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
      refetch,
    });

    render(<DetectorsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});
