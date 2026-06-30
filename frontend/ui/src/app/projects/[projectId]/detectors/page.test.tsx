// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

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
          sampleRate: 25,
          createTime: "2026-06-15T00:00:00.000Z",
          updateTime: "2026-06-15T00:00:00.000Z",
        },
      ],
      meta: { total: 1 },
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
