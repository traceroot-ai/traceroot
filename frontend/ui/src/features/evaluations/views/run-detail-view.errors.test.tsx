// @vitest-environment jsdom
/**
 * The run page tells "not found", "no access" and a temporary failure apart.
 * `useEvaluationRun` is mocked; the view reads the status off the error message
 * ("Request failed: <status>", as getJson throws it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", runId: "run1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  return {
    ...actual,
    useTrace: () => ({ data: undefined, isFetching: false, isError: false, refetch: vi.fn() }),
  };
});
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: () => <div data-testid="trace-panel" />,
}));

const runState: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useEvaluationRun: () => runState };
});

import { RunDetailView } from "./run-detail-view";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tree = () => (
  <QueryClientProvider client={qc}>
    <ToastProvider>
      <RunDetailView projectId="p1" runId="run1" />
    </ToastProvider>
  </QueryClientProvider>
);
function mount() {
  return render(tree());
}

beforeEach(() => {
  runState.data = undefined;
  runState.isLoading = false;
  runState.error = null;
  runState.refetch = vi.fn();
});
afterEach(cleanup);

describe("run detail error states", () => {
  it("shows not-found with a back link on a 404", () => {
    runState.error = new Error("Request failed: 404");
    mount();
    expect(screen.getByText("Evaluation run not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to evaluations" })).toBeTruthy();
  });

  it.each([401, 403])("shows the access copy on a %i", (status) => {
    runState.error = new Error(`Request failed: ${status}`);
    mount();
    expect(screen.getByText("You don't have access to this run")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to evaluations" })).toBeTruthy();
    expect(screen.queryByText("Evaluation run not found")).toBeNull();
  });

  it("shows a retry on a 500 and calls refetch once", () => {
    runState.error = new Error("Request failed: 500");
    mount();
    expect(screen.getByText("Couldn't load this run")).toBeTruthy();
    expect(screen.queryByText("Evaluation run not found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(runState.refetch).toHaveBeenCalledTimes(1);
  });

  it("treats a network failure as a temporary failure", () => {
    runState.error = new TypeError("Failed to fetch");
    mount();
    expect(screen.getByText("Couldn't load this run")).toBeTruthy();
  });

  it("renders the page, not the error, when data is present", () => {
    runState.error = new Error("Request failed: 500");
    runState.data = { run: { evaluationName: "Billing routing", scorers: [] }, results: [] };
    mount();
    expect(screen.queryByText("Couldn't load this run")).toBeNull();
    expect(screen.queryByText("Evaluation run not found")).toBeNull();
    expect(screen.getByText("Billing routing")).toBeTruthy();
  });

  describe("with a cached run", () => {
    beforeEach(() => {
      runState.data = { run: { evaluationName: "Billing routing", scorers: [] }, results: [] };
    });

    it.each([401, 403])("shows the access copy instead of the data on a %i", (status) => {
      runState.error = new Error(`Request failed: ${status}`);
      mount();
      expect(screen.getByText("You don't have access to this run")).toBeTruthy();
      expect(screen.queryByText("Billing routing")).toBeNull();
    });

    it("shows not-found instead of the data on a 404", () => {
      runState.error = new Error("Request failed: 404");
      mount();
      expect(screen.getByText("Evaluation run not found")).toBeTruthy();
      expect(screen.queryByText("Billing routing")).toBeNull();
    });

    it("keeps the data on screen on a 500", () => {
      runState.error = new Error("Request failed: 500");
      mount();
      expect(screen.queryByText("Couldn't load this run")).toBeNull();
      expect(screen.getByText("Billing routing")).toBeTruthy();
    });
  });

  describe("with a result open in the trace panel", () => {
    const result = {
      id: "res1",
      runId: "run1",
      testCaseId: "case-1",
      traceId: null,
      input: "I was charged twice for my July invoice",
      expectedOutput: "billing",
      candidateOutput: "billing",
      status: "passed",
      taskError: null,
      durationMs: 2400,
      cost: 0.012,
      createTime: "2026-07-17T10:24:00Z",
      scores: [],
    };

    function openPanel() {
      runState.data = {
        run: { evaluationName: "Billing routing", scorers: [] },
        results: [result],
      };
      const view = mount();
      fireEvent.click(screen.getByText(/charged twice/));
      expect(screen.getByTestId("trace-panel")).toBeTruthy();
      return view;
    }

    it.each([401, 403])("closes the panel when a refetch answers %i", (status) => {
      const view = openPanel();
      runState.error = new Error(`Request failed: ${status}`);
      view.rerender(tree());
      expect(screen.queryByTestId("trace-panel")).toBeNull();
      expect(screen.getByText("You don't have access to this run")).toBeTruthy();
    });

    it("closes the panel when a refetch answers 404", () => {
      const view = openPanel();
      runState.error = new Error("Request failed: 404");
      view.rerender(tree());
      expect(screen.queryByTestId("trace-panel")).toBeNull();
      expect(screen.getByText("Evaluation run not found")).toBeTruthy();
    });

    it("keeps the panel when a refetch answers 500", () => {
      const view = openPanel();
      runState.error = new Error("Request failed: 500");
      view.rerender(tree());
      expect(screen.getByTestId("trace-panel")).toBeTruthy();
    });
  });
});
