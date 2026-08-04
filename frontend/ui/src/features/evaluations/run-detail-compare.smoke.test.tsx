// @vitest-environment jsdom
/**
 * Compare-with on the run-detail page (task #4). Picking another run of the same
 * evaluation from the dropdown should: compute the comparison via the shared engine
 * (useCompareRuns → /evaluations/compare), show the comparison banner, drive the
 * results table's diff cells (vs-baseline delta + "≠ baseline" output marker), and
 * open the trace viewer straight into diff mode (defaultDiffOn) against the picked
 * run's matching case trace.
 *
 * Radix Select is mocked to a native <select> (portal/pointer events don't work in
 * jsdom); TraceViewerPanel is a prop recorder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", runId: "run1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

// Per-id trace stubs: candidate ("tr_cand") and baseline ("tr_base") are
// DISTINCT objects, so an assertion on the resolved trace's own identity can
// catch a wrong id being wired up (a single shared stub — as this used to be —
// makes `!!props.diffBaseline` unconditionally true regardless of which id, if
// any, was actually requested).
const candTraceState = {
  data: { trace_id: "tr_cand", spans: [] },
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
};
const baseTraceState = {
  data: { trace_id: "tr_base", spans: [] },
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
};
const noTraceState = { data: undefined, isFetching: false, isError: false, refetch: vi.fn() };
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  return {
    ...actual,
    useTrace: (_projectId: string, id: string) =>
      id === "tr_cand" ? candTraceState : id === "tr_base" ? baseTraceState : noTraceState,
  };
});

let lastPanel: {
  traceId?: string;
  defaultDiffOn?: boolean;
  diffBaseline?: { trace?: { trace_id?: string } };
} = {};
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: (props: {
    traceId: string;
    defaultDiffOn?: boolean;
    diffBaseline?: { trace?: { trace_id?: string } };
  }) => {
    lastPanel = {
      traceId: props.traceId,
      defaultDiffOn: props.defaultDiffOn,
      diffBaseline: props.diffBaseline,
    };
    return <div data-testid="trace-panel" />;
  },
}));

// Native-select stand-in for the Radix Select (jsdom can't drive the real one).
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="compare-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RunDetailView } from "./views/run-detail-view";

/**
 * Matches the innermost element whose *combined* text matches `re`. The run
 * number is interpolated (`Run #{n}`, `Comparing vs #{n} ·`), so it lands in its
 * own text node and a plain regex matcher never sees the whole string.
 */
const withText = (re: RegExp) => (_content: string, el: Element | null) =>
  !!el &&
  re.test(el.textContent ?? "") &&
  !Array.from(el.children).some((c) => re.test(c.textContent ?? ""));


const runRow = (id: string, runNumber: number, version: string, mainScore: number) => ({
  id,
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber,
  candidateVersion: version,
  environment: "evaluation",
  status: "completed",
  baselineRunId: null,
  mainScore,
  mainScoreName: "accuracy",
  caseCount: 1,
  scoredCount: 1,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  passedCount: 1,
  failedCount: 0,
  erroredCount: 0,
  notScoredCount: 0,
  scorers: [{ name: "accuracy", version: "v1" }],
  provenance: {
    git_repository: null,
    git_ref: null,
    git_commit: null,
    git_dirty: null,
    ci_provider: null,
    ci_build_id: null,
    sdk_language: null,
    sdk_version: null,
    declared_model: "claude-opus-4",
    declared_prompt_version: null,
  },
  startedAt: "2026-07-17T10:24:00Z",
  completedAt: "2026-07-17T10:30:00Z",
  evaluationName: "Billing routing",
  datasetName: "Billing routing",
  datasetVersionLabel: "v12",
  changeFromBaseline: null,
  errorCount: 0,
  baselineComparable: false,
  elapsedMs: 360000,
  cost: 0.01,
});

const emptyComparison = {
  available: false,
  trustworthy: false,
  state: "unavailable",
  reasons: ["no_baseline"],
  baseline: null,
  mainScore: { candidate: 1, baseline: null, delta: null },
  caseCounts: {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    changed: 0,
    unpaired: 1,
    not_comparable: 0,
  },
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
};

const RUN1 = { ...runRow("run1", 27, "v2", 1), comparison: emptyComparison };

const RESULT = {
  id: "res1",
  runId: "run1",
  evaluationId: "eval1",
  testCaseId: "case-1",
  traceId: "tr_cand",
  input: "I was charged twice for my July invoice",
  expectedOutput: "billing",
  candidateOutput: "billing",
  baselineOutput: null,
  status: "passed",
  mainScore: 1,
  change: null,
  taskError: null,
  durationMs: 2400,
  cost: 0.012,
  createTime: "2026-07-17T10:24:00Z",
  scores: [],
  humanScores: [],
  comparison: null,
};

// The compare response: this run (candidate, score 1) vs run #26 (baseline, score 0).
const COMPARE = {
  candidate: runRow("run1", 27, "v2", 1),
  baseline: runRow("run2", 26, "v1", 0),
  comparison: {
    available: true,
    trustworthy: true,
    state: "trustworthy",
    reasons: [],
    baseline: { runId: "run2", runNumber: 26, candidateVersion: "v1" },
    mainScore: { candidate: 1, baseline: 0, delta: 1 },
    caseCounts: {
      improved: 1,
      regressed: 0,
      unchanged: 0,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scoreCellCounts: {
      improved: 1,
      regressed: 0,
      unchanged: 0,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scorers: [],
    duration: { candidateMeanMs: 2400, baselineMeanMs: 2100, deltaMs: 300, pairedCount: 1 },
  },
  results: [
    {
      testCaseId: "case-1",
      input: "I was charged twice for my July invoice",
      expectedOutput: "billing",
      metadata: null,
      provenance: null,
      inputMatchesDataset: true,
      candidateStatus: "passed",
      baselineStatus: "failed",
      candidateOutput: "billing",
      baselineOutput: "account_management",
      candidateTraceId: "tr_cand",
      baselineTraceId: "tr_base",
      candidateCost: 0.012,
      baselineCost: 0.011,
      candidateTaskError: null,
      baselineTaskError: null,
      candidateScores: [],
      baselineScores: [],
      outputChanged: true,
      change: "improved",
      comparison: {
        caseChange: "improved",
        pairing: "paired",
        mainScore: { candidate: 1, baseline: 0, delta: 1 },
        baselineOutput: "account_management",
        durationMs: 2400,
        baselineDurationMs: 2100,
        durationDeltaMs: 300,
        baselineTraceId: "tr_base",
        scorerCells: [],
        regressedCellCount: 0,
        comparableCellCount: 1,
      },
    },
  ],
};

beforeEach(() => {
  lastPanel = {};
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    let body: unknown = { data: [], meta: { page: 0, limit: 50, total: 0 } };
    if (u.includes("/evaluations/runs/run1")) body = { run: RUN1, results: [RESULT] };
    else if (u.includes("/evaluations/compare")) body = COMPARE;
    else if (u.includes("/evaluations/runs")) {
      // sibling runs for the compare dropdown: this run + an earlier one.
      body = { data: [RUN1, runRow("run2", 26, "v1", 0)], meta: { page: 0, limit: 100, total: 2 } };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

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

const pickCompare = async () => {
  const select = (await screen.findByTestId("compare-select")) as HTMLSelectElement;
  // The earlier run (#26) is offered as a baseline option. Awaited, not sync:
  // the sibling-runs query lives in RunBody, which only mounts once the run has
  // loaded, so the options arrive a tick after the select does.
  expect(await within(select).findByText(withText(/#26/))).toBeDefined();
  fireEvent.change(select, { target: { value: "run2" } });
};

describe("run detail — compare with", () => {
  it("lists sibling runs and, on pick, shows the comparison banner", async () => {
    mount();
    await pickCompare();
    expect(await screen.findByText(withText(/Comparing vs #26/))).toBeDefined();
    expect(screen.getByText(/1 improved/)).toBeDefined();
    // The headline main-score stat gains its delta vs the baseline (candidate 1,
    // baseline 0 → +100.0pp); the space-free "pp" distinguishes it from the per-case
    // cell's "+100.0 pp".
    expect(screen.getByText(withText(/\+100\.0pp/))).toBeDefined();
  });

  it("drives the results table diff cells vs the picked run", async () => {
    mount();
    await pickCompare();
    // Header switches to the diff label, the main-score cell shows the +100 pp delta,
    // and the output is flagged as differing from the baseline.
    expect(await screen.findByText("vs baseline")).toBeDefined();
    expect(screen.getByText(/\+100\.0 pp/)).toBeDefined();
    expect(screen.getByText("≠ baseline")).toBeDefined();
  });

  it("opens the case trace straight into diff mode against the picked run", async () => {
    mount();
    await pickCompare();
    await screen.findByText(withText(/Comparing vs #26/));
    fireEvent.click(await screen.findByText(/charged twice/));
    expect(await screen.findByTestId("trace-panel")).toBeDefined();
    expect(lastPanel.defaultDiffOn).toBe(true);
    // Asserts identity, not just truthiness: the candidate's own trace (tr_cand)
    // is open, and the diff baseline resolved is the PICKED run's matching case
    // trace (tr_base, from the fixture's baselineTraceId), not some other trace.
    expect(lastPanel.traceId).toBe("tr_cand");
    expect(lastPanel.diffBaseline?.trace?.trace_id).toBe("tr_base");
  });

  it("shows no diff/change column until a run is picked", async () => {
    mount();
    await screen.findByText(/charged twice/);
    // The change column is redundant with no baseline — hidden entirely until compared.
    expect(screen.queryByText("vs baseline")).toBeNull();
    expect(screen.queryByText("Change")).toBeNull();
  });
});
