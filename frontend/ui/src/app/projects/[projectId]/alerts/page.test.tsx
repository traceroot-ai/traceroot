// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { AlertCapacity } from "@/features/alerts/capacity";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useAlertList: vi.fn(),
  capacity: undefined as AlertCapacity | undefined,
  keyword: "",
  deleteMutate: vi.fn(),
  statusMutate: vi.fn(),
  useDeleteAlert: vi.fn(),
  useSetAlertStatus: vi.fn(),
  deleteFailure: null as Error | null,
  statusFailure: null as Error | null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));

// Controlled list state so the empty-project and empty-search branches are
// separable: only a keyword tells them apart.
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { keyword: mocks.keyword },
    queryOptions: { page: 0, limit: 50, search_query: mocks.keyword || undefined },
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

const alertRow = {
  id: "alert-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: "2026-07-01T00:00:00.000Z",
  updateTime: "2026-07-01T00:00:00.000Z",
  creator: "Ada",
};

const listOf = (rows: unknown[]) => ({
  data: { data: rows, meta: { page: 0, limit: 50, total: rows.length } },
  isLoading: false,
  error: null,
});

const populatedList = listOf([alertRow]);
const emptyList = listOf([]);
const failedList = (error: Error) => ({ data: undefined, isLoading: false, error });

vi.mock("@/features/alerts/hooks/use-alerts", () => ({
  useAlertList: (...args: unknown[]) => mocks.useAlertList(...args),
  // The cap is its own query, so it is its own control here: the list's meta
  // cannot stand in for it.
  useAlertCapacity: () => ({ data: mocks.capacity }),
  useDeleteAlert: () => mocks.useDeleteAlert(),
  useSetAlertStatus: () => mocks.useSetAlertStatus(),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
// The page resolves the workspace per row badge. Unresolved here: reason shows, link does not.
vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: undefined }) }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/alerts/components/delete-alert-dialog", () => ({
  // The stub surfaces whatever failure it is handed, wherever the page reports it.
  DeleteAlertDialog: ({
    alertName,
    onConfirm,
    error,
  }: {
    alertName: string;
    onConfirm: () => void;
    error?: Error | string | null;
  }) => (
    <div data-testid="delete-dialog">
      {alertName}
      {error ? <p>{typeof error === "string" ? error : error.message}</p> : null}
      <button onClick={onConfirm}>Confirm delete</button>
    </div>
  ),
}));
vi.mock("@/features/alerts/components/alerts-onboarding", () => ({
  AlertsOnboarding: ({ projectId }: { projectId: string }) => (
    <div data-testid="onboarding">{projectId}</div>
  ),
}));

import AlertsPage from "./page";

interface MutationCallbacks {
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (error: Error, variables: unknown) => void;
}

/** Stands in for a react-query mutation: `mutate` reports through callbacks and `error`. */
function useFakeMutation(failure: Error | null, spy: (variables: unknown) => void) {
  const [error, setError] = useState<Error | null>(null);

  const mutate = (variables: unknown, callbacks?: MutationCallbacks) => {
    spy(variables);
    if (failure) {
      setError(failure);
      callbacks?.onError?.(failure, variables);
      return;
    }
    setError(null);
    callbacks?.onSuccess?.(undefined, variables);
  };

  return { mutate, isPending: false, error, isError: error !== null };
}

const resetMutationMocks = () => {
  mocks.deleteFailure = null;
  mocks.statusFailure = null;
  mocks.useDeleteAlert.mockImplementation(() =>
    useFakeMutation(mocks.deleteFailure, mocks.deleteMutate),
  );
  mocks.useSetAlertStatus.mockImplementation(() =>
    useFakeMutation(mocks.statusFailure, mocks.statusMutate),
  );
};

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
  mocks.deleteMutate.mockClear();
  mocks.statusMutate.mockClear();
  mocks.keyword = "";
  mocks.capacity = undefined;
  mocks.useAlertList.mockReset();
  mocks.useAlertList.mockReturnValue(populatedList);
  resetMutationMocks();
});

mocks.useAlertList.mockReturnValue(populatedList);
resetMutationMocks();

const openRowMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: "Actions for P95 latency" }));

const showPaused = () =>
  mocks.useAlertList.mockReturnValue(listOf([{ ...alertRow, status: "PAUSED" }]));

describe("AlertsPage", () => {
  it("shows the onboarding splash, and no list chrome, while the project has no alerts", () => {
    mocks.useAlertList.mockReturnValue(emptyList);

    render(<AlertsPage />);

    expect(screen.getByTestId("onboarding").textContent).toBe("proj-1");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByPlaceholderText("Search...")).toBeNull();
    expect(screen.queryByRole("button", { name: "New Alert" })).toBeNull();
  });

  it("shows the table and the list chrome once the project has an alert", () => {
    render(<AlertsPage />);

    expect(screen.queryByTestId("onboarding")).toBeNull();
    expect(screen.getByText("P95 latency")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search...")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New Alert" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/alerts/new");
  });

  it("shows a no-match message rather than onboarding when a search empties the list", () => {
    mocks.keyword = "checkout";
    mocks.useAlertList.mockReturnValue(emptyList);

    render(<AlertsPage />);

    expect(screen.queryByTestId("onboarding")).toBeNull();
    expect(screen.getByText(/No alerts match/)).toBeTruthy();
  });

  it("shows a loading state instead of the empty splash while the list is in flight", () => {
    mocks.useAlertList.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(<AlertsPage />);

    expect(screen.queryByTestId("onboarding")).toBeNull();
    expect(screen.getByText("Loading alerts...")).toBeTruthy();
  });

  it("pauses and resumes an alert from its row menu", () => {
    render(<AlertsPage />);
    openRowMenu();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(mocks.statusMutate).toHaveBeenCalledWith({ alertId: "alert-1", status: "PAUSED" });

    cleanup();
    showPaused();
    render(<AlertsPage />);
    openRowMenu();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(mocks.statusMutate).toHaveBeenCalledWith({ alertId: "alert-1", status: "ACTIVE" });
  });

  it("asks for ACTIVE on a parked alert, rather than pausing a rule already stopped", () => {
    mocks.useAlertList.mockReturnValue(listOf([{ ...alertRow, status: "PARKED" }]));

    render(<AlertsPage />);
    openRowMenu();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(mocks.statusMutate).toHaveBeenCalledWith({ alertId: "alert-1", status: "ACTIVE" });
  });

  it("opens the delete confirmation dialog instead of deleting on click", () => {
    render(<AlertsPage />);

    expect(screen.queryByTestId("delete-dialog")).toBeNull();
    openRowMenu();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByTestId("delete-dialog").textContent).toContain("P95 latency");
    expect(mocks.deleteMutate).not.toHaveBeenCalled();
  });

  describe("when the list fails to load", () => {
    it("says why, instead of showing the empty splash or a table", () => {
      mocks.useAlertList.mockReturnValue(
        failedList(new Error("You do not have access to this project")),
      );

      render(<AlertsPage />);

      expect(screen.queryByTestId("onboarding")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText(/You do not have access to this project/)).toBeTruthy();
    });

    it("does not make a permission failure and an outage read the same", () => {
      // The hook extracts the server's reason; a page that discards it leaves a
      // 403 and a database outage looking like the same problem.
      mocks.useAlertList.mockReturnValue(
        failedList(new Error("You do not have access to this project")),
      );
      const { container: forbidden } = render(<AlertsPage />);
      const forbiddenText = forbidden.textContent ?? "";

      cleanup();

      mocks.useAlertList.mockReturnValue(failedList(new Error("Database is unreachable")));
      const { container: outage } = render(<AlertsPage />);

      expect(forbiddenText).not.toBe(outage.textContent);
    });
  });

  describe("when a row action fails", () => {
    it("tells the user a resume did not take, rather than leaving the row reading Paused", () => {
      mocks.statusFailure = new Error("Alert is locked by another workspace");
      showPaused();

      render(<AlertsPage />);
      openRowMenu();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));

      expect(screen.getByText(/Alert is locked by another workspace/)).toBeTruthy();
    });

    it("tells the user a delete did not take", () => {
      mocks.deleteFailure = new Error("Alert is referenced by a running workflow");

      render(<AlertsPage />);
      openRowMenu();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

      expect(screen.getByText(/Alert is referenced by a running workflow/)).toBeTruthy();
    });

    it("says nothing when the action succeeds", () => {
      render(<AlertsPage />);
      openRowMenu();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));

      expect(screen.queryByText(/locked|failed|error/i)).toBeNull();
    });
  });

  describe("the per-project cap", () => {
    const newAlertButton = () => screen.getByRole("button", { name: "New Alert" });
    const notice = (used: number, max: number) =>
      `This project has ${used} of ${max} alerts. Delete one to make room — paused alerts still count toward the limit.`;

    it("holds New Alert off at the cap even while a search narrows the list to three rows", () => {
      mocks.keyword = "checkout";
      mocks.useAlertList.mockReturnValue({
        data: { data: [alertRow], meta: { page: 0, limit: 50, total: 3 } },
        isLoading: false,
        error: null,
      });
      mocks.capacity = { used: 100, max: 100 };

      render(<AlertsPage />);

      // The keyword's total is 3 and the project's count is 100: a control read
      // off the list total is enabled here, and the create then 409s.
      expect(newAlertButton().hasAttribute("disabled")).toBe(true);
    });

    it("says why the control is off, naming both numbers", () => {
      mocks.capacity = { used: 100, max: 100 };
      render(<AlertsPage />);

      expect(screen.getByText(/This project has/).textContent).toBe(notice(100, 100));

      cleanup();
      // A different cap has to read differently, or the numbers are literals.
      mocks.capacity = { used: 12, max: 12 };
      render(<AlertsPage />);

      expect(screen.getByText(/This project has/).textContent).toBe(notice(12, 12));
    });

    it("leaves New Alert on, and says nothing, while the capacity is unknown", () => {
      render(<AlertsPage />);

      expect(newAlertButton().hasAttribute("disabled")).toBe(false);
      expect(screen.queryByText(/This project has/)).toBeNull();
    });

    it("counts the last ten slots down and stays quiet above them", () => {
      mocks.capacity = { used: 91, max: 100 };
      render(<AlertsPage />);

      expect(screen.getByText("91 of 100 alerts used")).toBeTruthy();

      cleanup();
      mocks.capacity = { used: 90, max: 100 };
      render(<AlertsPage />);

      expect(screen.queryByText(/alerts used/)).toBeNull();
    });
  });
});
