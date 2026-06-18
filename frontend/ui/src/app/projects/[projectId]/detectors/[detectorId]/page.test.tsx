// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", detectorId: "det-1" }),
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => ({ get: () => null }),
}));

// Controlled list state so the test asserts the exact range carried back to the list.
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
  useDetector: () => ({ data: { name: "My Detector" } }),
}));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useFindings: () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false, error: null }),
  useRuns: () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false, error: null }),
  describeRcaStatus: () => ({ label: "", className: "" }),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({ TraceViewerPanel: () => null }));

import DetectorDetailPage from "./page";

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
});

describe("DetectorDetailPage", () => {
  it("carries the selected time range back to the list via the Detectors link", () => {
    render(<DetectorDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Detectors" }));

    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors?date_filter=7d");
  });
});
