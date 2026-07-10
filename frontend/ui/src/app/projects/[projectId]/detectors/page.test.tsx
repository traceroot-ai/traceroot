// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  deleteMutate: vi.fn(),
  deleteReset: vi.fn(),
  deleteError: null as Error | null,
  workspaceRole: "ADMIN",
}));

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

vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useDetectorList: () => ({
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
  }),
  useDetectorCounts: () => ({ data: {}, isLoading: false }),
  useDeleteDetector: () => ({
    mutate: mocks.deleteMutate,
    reset: mocks.deleteReset,
    isPending: false,
    isError: !!mocks.deleteError,
    error: mocks.deleteError,
  }),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role: mocks.workspaceRole } }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/detectors/components/delete-detector-dialog", () => ({
  DeleteDetectorDialog: ({
    detectorName,
    isOpen,
    onConfirm,
    errorMessage,
  }: {
    detectorName: string;
    isOpen: boolean;
    onConfirm: () => void;
    errorMessage?: string;
  }) =>
    isOpen ? (
      <div>
        <p>Delete {detectorName}</p>
        {errorMessage && <p role="alert">{errorMessage}</p>}
        <button onClick={onConfirm}>Confirm delete</button>
      </div>
    ) : null,
}));
vi.mock("@/features/detectors/components/detector-panel", () => ({ DetectorPanel: () => null }));

import DetectorsPage from "./page";

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
  mocks.deleteMutate.mockReset();
  mocks.deleteReset.mockReset();
  mocks.deleteError = null;
  mocks.workspaceRole = "ADMIN";
});

describe("DetectorsPage", () => {
  it("shows the resolved detector default model with a default marker", () => {
    render(<DetectorsPage />);

    const defaultRow = screen.getByText("My Detector").closest("tr");
    expect(defaultRow).not.toBeNull();
    expect(defaultRow?.textContent).toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
    expect(defaultRow?.textContent).not.toContain("System default:");
    expect(defaultRow?.textContent).toContain("(default)");
  });

  it("does not label BYOK detectors without a model as a default", () => {
    render(<DetectorsPage />);

    const byokRow = screen.getByText("BYOK Detector").closest("tr");
    expect(byokRow).not.toBeNull();
    expect(byokRow?.textContent).toContain("Anthropic BYOK");
    expect(byokRow?.textContent).not.toContain("BYOK provider:");
    expect(byokRow?.textContent).not.toContain("(default)");
    expect(byokRow?.textContent).not.toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("keeps legacy null-source detector labels availability-aware", () => {
    render(<DetectorsPage />);

    const legacyRow = screen.getByText("Legacy Detector").closest("tr");
    expect(legacyRow).not.toBeNull();
    expect(legacyRow?.textContent).toContain("Auto-selected");
    expect(legacyRow?.textContent).not.toContain("Auto-selected default");
    expect(legacyRow?.textContent).toContain("(default)");
    expect(legacyRow?.textContent).not.toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("shows pinned detector models without the default marker", () => {
    render(<DetectorsPage />);

    const pinnedRow = screen.getByText("Pinned Detector").closest("tr");
    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow?.textContent).toContain("gpt-5.4");
    expect(pinnedRow?.textContent).not.toContain("System pinned:");
    expect(pinnedRow?.textContent).not.toContain("System default:");
    expect(pinnedRow?.textContent).not.toContain("(default)");
  });

  it("shows pinned BYOK detector models without source prefixes", () => {
    render(<DetectorsPage />);

    const pinnedByokRow = screen.getByText("Pinned BYOK Detector").closest("tr");
    expect(pinnedByokRow).not.toBeNull();
    expect(pinnedByokRow?.textContent).toContain("gpt-5.4");
    expect(pinnedByokRow?.textContent).not.toContain("BYOK (OpenAI BYOK):");
    expect(pinnedByokRow?.textContent).not.toContain("(default)");
  });

  it("carries the selected time range into the detector detail URL on row click", () => {
    render(<DetectorsPage />);

    fireEvent.click(screen.getByText("My Detector"));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors/det-1?date_filter=7d");
  });

  it("hides detector mutation controls from viewers", () => {
    mocks.workspaceRole = "VIEWER";
    render(<DetectorsPage />);

    expect(screen.queryByRole("button", { name: "New Detector" })).toBeNull();
    expect(screen.queryByText("Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for My Detector" })).toBeNull();
  });

  it("shows edit but not delete actions to members", () => {
    mocks.workspaceRole = "MEMBER";
    render(<DetectorsPage />);

    expect(screen.getByRole("button", { name: "New Detector" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Actions for My Detector" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows delete actions to admins", () => {
    render(<DetectorsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Actions for My Detector" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("passes delete permission errors into the delete dialog", () => {
    mocks.deleteError = new Error("Admins can delete detectors for this project.");
    render(<DetectorsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Actions for My Detector" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByText("Delete My Detector")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "Admins can delete detectors for this project.",
    );
  });
});
