// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

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
  useDeleteDetector: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: undefined }) }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/detectors/components/delete-detector-dialog", () => ({
  DeleteDetectorDialog: () => null,
}));
vi.mock("@/features/detectors/components/detector-panel", () => ({ DetectorPanel: () => null }));

import DetectorsPage from "./page";

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
});

describe("DetectorsPage", () => {
  it("carries the selected time range into the detector detail URL on row click", () => {
    render(<DetectorsPage />);

    fireEvent.click(screen.getByText("My Detector"));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors/det-1?date_filter=7d");
  });
});
