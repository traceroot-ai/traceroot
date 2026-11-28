// @vitest-environment jsdom
/**
 * Result → real trace behavior (Phase F). Opening a result should:
 *  - open the REAL ingested trace directly when it's available (no synthetic override),
 *  - say why a reported trace failed to load (still ingesting, not available yet,
 *    signed out, no access, or a failed load) — never with a reconstruction,
 *  - fall back to a clearly-labeled reconstructed trace when none was emitted.
 *
 * TraceViewerPanel is stubbed to a prop recorder (it's a heavy component) and the
 * real-trace probe (useTrace) is controllable, so we assert the branch, not the panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", runId: "run1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

// Controllable real-trace probe (shares TraceViewerPanel's cache key in real code).
const traceState: {
  data: unknown;
  isFetching: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  errorUpdateCount: number;
  refetch: () => void;
} = {
  data: undefined,
  isFetching: false,
  isLoading: false,
  isError: false,
  error: null,
  errorUpdateCount: 0,
  refetch: vi.fn(),
};

/** Put the probe in react-query's settled error state for `error`. */
function failWith(error: unknown, failedLoads = 1) {
  traceState.data = undefined;
  traceState.isFetching = false;
  traceState.isLoading = false;
  traceState.isError = true;
  traceState.error = error;
  traceState.errorUpdateCount = failedLoads;
}
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  return { ...actual, useTrace: () => traceState };
});

// Record TraceViewerPanel props instead of mounting the real (heavy) panel.
let lastPanel: { traceId?: string; override?: boolean } = {};
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: (props: {
    traceId: string;
    traceOverride?: unknown;
    spanExtraTags?: () => React.ReactNode;
  }) => {
    lastPanel = { traceId: props.traceId, override: !!props.traceOverride };
    return (
      <div data-testid="trace-panel" data-traceid={props.traceId}>
        {props.spanExtraTags?.()}
      </div>
    );
  },
}));

import { RunDetailView } from "./views/run-detail-view";

const RUN = {
  id: "run1",
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber: 27,
  candidateVersion: "git:4a91c02",
  environment: "evaluation",
  status: "completed",
  baselineRunId: null,
  caseCount: 1,
  scoredCount: 1,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  erroredCount: 0,
  notScoredCount: 0,
  scorers: [{ name: "routing-accuracy", version: "v3" }],
  model: null,
  startedAt: "2026-07-17T10:24:00Z",
  completedAt: "2026-07-17T10:30:00Z",
  evaluationName: "Billing routing",
  datasetName: "Billing routing",
  datasetVersionLabel: "v12",
  changeFromBaseline: null,
  errorCount: 0,
  baselineComparable: false,
  elapsedMs: 360000,
  comparison: {
    available: false,
    trustworthy: false,
    reasons: ["no_baseline"],
    baseline: null,
    scoreCellCounts: {
      improved: 0,
      regressed: 0,
      unchanged: 0,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scorers: [],
    duration: { candidateMeanMs: null, baselineMeanMs: null, deltaMs: null, pairedCount: 0 },
  },
};

function makeResult(traceId: string | null, createTime = "2026-07-17T10:24:00Z") {
  return {
    id: "res1",
    runId: "run1",
    evaluationId: "eval1",
    testCaseId: "case-1",
    traceId,
    input: "I was charged twice for my July invoice",
    expectedOutput: "billing",
    candidateOutput: "billing",
    baselineOutput: null,
    status: "passed",
    change: null,
    taskError: null,
    durationMs: 2400,
    cost: 0.012,
    createTime,
    scores: [],
    comparison: {
      pairing: "candidate_only",
      scorerCells: [],
      regressedCellCount: 0,
      comparableCellCount: 0,
    },
  };
}

function stubFetch(result: ReturnType<typeof makeResult>) {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.includes("/evaluations/runs/run1")
      ? { run: RUN, results: [result] }
      : { data: [], meta: { page: 0, limit: 50, total: 0 } };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RunDetailView projectId="p1" runId="run1" />
      </ToastProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerender: () => view.rerender(tree()) };
}

async function openResult() {
  const cell = await screen.findByText(/charged twice/);
  fireEvent.click(cell);
}

/** An ISO timestamp `ms` ago, for a result recorded just now (or long ago). */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  lastPanel = {};
  traceState.data = undefined;
  traceState.isFetching = false;
  traceState.isLoading = false;
  traceState.isError = false;
  traceState.error = null;
  traceState.errorUpdateCount = 0;
  traceState.refetch = vi.fn();
});
afterEach(() => cleanup());

describe("result → real trace", () => {
  it("opens the REAL trace directly (no synthetic override) when it is available", async () => {
    traceState.data = { trace_id: "tr_1", spans: [] };
    stubFetch(makeResult("tr_1"));
    mount();
    await openResult();
    expect(await screen.findByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.traceId).toBe("tr_1");
    expect(lastPanel.override).toBe(false); // real trace, not a reconstruction
  });

  it("shows a pending state when a just-recorded result's trace isn't ingested yet (404)", async () => {
    failWith(new ApiError(404, "Trace not found"));
    stubFetch(makeResult("tr_1", ago(10_000)));
    mount();
    await openResult();
    expect(await screen.findByText(/still being ingested/i)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("stops promising ingestion for an old result's missing trace", async () => {
    failWith(new ApiError(404, "Trace not found"));
    stubFetch(makeResult("tr_1", ago(60 * 60_000)));
    mount();
    await openResult();
    expect(await screen.findByText("Trace isn't available yet")).toBeDefined();
    expect(screen.getByText(/may not have been exported/)).toBeDefined();
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("stops promising ingestion after repeated misses, even for a recent result", async () => {
    failWith(new ApiError(404, "Trace not found"), 3);
    stubFetch(makeResult("tr_1", ago(10_000)));
    mount();
    await openResult();
    expect(await screen.findByText("Trace isn't available yet")).toBeDefined();
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
  });

  it("asks to sign in on a 401, linking back to this run", async () => {
    failWith(new ApiError(401, "Browser session required"));
    stubFetch(makeResult("tr_1", ago(10_000)));
    mount();
    await openResult();
    expect(await screen.findByText("Sign in to view this trace")).toBeDefined();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/projects/p1/evaluations/run1")}`,
    );
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("says the account has no access on a 403", async () => {
    failWith(new ApiError(403, "No access to this project"));
    stubFetch(makeResult("tr_1", ago(10_000)));
    mount();
    await openResult();
    expect(await screen.findByText("You don't have access to this trace")).toBeDefined();
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("leaves a retention refusal to the real trace viewer's own banner", async () => {
    failWith(
      new ApiError(403, {
        message: "Data outside retention window",
        retention_days: 15,
        cutoff: "2026-06-29T00:00:00",
        plan: "free",
      }),
    );
    stubFetch(makeResult("tr_1"));
    mount();
    await openResult();
    expect(await screen.findByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.traceId).toBe("tr_1");
    expect(lastPanel.override).toBe(false);
    expect(screen.queryByText("You don't have access to this trace")).toBeNull();
  });

  it.each([
    ["a server error", new ApiError(500, "Internal Server Error")],
    ["a network failure", new TypeError("Failed to fetch")],
    ["a request that timed out", new DOMException("The operation timed out.", "TimeoutError")],
  ])("says the trace couldn't be loaded on %s, with retry", async (_label, error) => {
    failWith(error);
    stubFetch(makeResult("tr_1", ago(10_000)));
    mount();
    await openResult();
    expect(await screen.findByText("Couldn't load the trace")).toBeDefined();
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
    // Never a reconstruction for a result that reported a trace.
    expect(screen.queryByTestId("trace-panel")).toBeNull();
    expect(screen.queryByText(/Reconstructed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(traceState.refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure panel up while a retry is in flight", async () => {
    failWith(new ApiError(500, "Internal Server Error"));
    stubFetch(makeResult("tr_1", ago(10_000)));
    const view = mount();
    await openResult();
    expect(await screen.findByText("Couldn't load the trace")).toBeDefined();

    // A retry of a never-loaded trace resets the query to pending and clears its error.
    traceState.isError = false;
    traceState.error = null;
    traceState.isFetching = true;
    traceState.isLoading = true;
    view.rerender();
    expect(screen.getByText("Couldn't load the trace")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("trace-panel")).toBeNull();

    // The retry lands: the real trace replaces the panel.
    traceState.isFetching = false;
    traceState.isLoading = false;
    traceState.data = { trace_id: "tr_1", spans: [] };
    view.rerender();
    expect(screen.getByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.override).toBe(false);
    expect(screen.queryByText("Couldn't load the trace")).toBeNull();
  });

  it("keeps the real trace panel (loading) rather than the pending panel while fetching", async () => {
    traceState.data = undefined; // still loading, no error
    stubFetch(makeResult("tr_1"));
    mount();
    await openResult();
    // The real panel stays mounted (shows its own loading) — no pending swap/remount.
    expect(await screen.findByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.override).toBe(false);
    expect(screen.queryByText(/still being ingested/i)).toBeNull();
  });

  it("falls back to a clearly-labeled reconstructed trace when none was emitted", async () => {
    stubFetch(makeResult(null)); // no trace id → fully-local result
    mount();
    await openResult();
    expect(await screen.findByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.override).toBe(true); // synthetic override
    expect(screen.getByText(/Reconstructed/)).toBeDefined();
  });
});
