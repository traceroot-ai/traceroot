// @vitest-environment jsdom
/**
 * Result → real trace behavior (Phase F). Opening a result should:
 *  - open the REAL ingested trace directly when it's available (no synthetic override),
 *  - show a pending state while the trace is still ingesting,
 *  - fall back to a clearly-labeled reconstructed trace when none was emitted.
 *
 * TraceViewerPanel is stubbed to a prop recorder (it's a heavy component) and the
 * real-trace probe (useTrace) is controllable, so we assert the branch, not the panel.
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

// Controllable real-trace probe (shares TraceViewerPanel's cache key in real code).
const traceState: { data: unknown; isFetching: boolean; isError: boolean; refetch: () => void } = {
  data: undefined,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
};
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
  passedCount: 1,
  failedCount: 0,
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

function makeResult(traceId: string | null) {
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
    createTime: "2026-07-17T10:24:00Z",
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
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RunDetailView projectId="p1" runId="run1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openResult() {
  const cell = await screen.findByText(/charged twice/);
  fireEvent.click(cell);
}

beforeEach(() => {
  lastPanel = {};
  traceState.data = undefined;
  traceState.isFetching = false;
  traceState.isError = false;
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

  it("shows a pending state when a reported trace hasn't been ingested (404)", async () => {
    traceState.data = undefined;
    traceState.isError = true; // fetch failed → not ingested yet
    stubFetch(makeResult("tr_1"));
    mount();
    await openResult();
    expect(await screen.findByText(/still being ingested/i)).toBeDefined();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
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
