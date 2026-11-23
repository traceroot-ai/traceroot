// @vitest-environment jsdom
/**
 * A comparison case opens in the trace panel on the candidate's real trace, in diff mode
 * against the baseline's, the two drawn as one tree. A result that reported no trace is
 * rebuilt from the result, as run detail does; a trace still being ingested waits with a
 * retry; a run with no result says so. Only the open case's two traces are fetched.
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, SpanIO, TraceDetail } from "@/types/api";
import { fixtureResult, fixtureRun } from "./compare/__tests__/paired-fixture";
import type { RunBundle } from "./compare/model";
import type { InspectedCase } from "./compare/inspector/use-case-inspector";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);

/** Each stored trace by id (one missing here is still being ingested: its fetch fails),
 *  and each span's I/O by "traceId/spanId". */
const traces = vi.hoisted(() => ({
  byId: new Map<string, unknown>(),
  io: new Map<string, unknown>(),
  useTrace: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  return {
    ...actual,
    useTrace: traces.useTrace,
    useSpanIO: (_p: string, traceId: string, spanId: string | null) => ({
      data: spanId ? traces.io.get(`${traceId}/${spanId}`) : undefined,
      isLoading: false,
    }),
  };
});
// The panel fetches the trace it shows itself, from the same store.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getTrace: async (_p: string, traceId: string) => {
    const trace = traces.byId.get(traceId);
    if (!trace) throw new Error("not ingested yet");
    return trace;
  },
}));
// The trace panel's parts that need a browser or a server.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32, size: 32 })),
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock("@/features/traces/hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: undefined }),
  useRca: () => ({ data: undefined }),
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: undefined, isPending: false }) }));

import { CompareRunsView } from "./views/compare-runs-view";

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
  start: number,
  end: number,
  extra?: Partial<Span>,
];

function traceOf(traceId: string, rows: Row[]): TraceDetail {
  return {
    trace_id: traceId,
    project_id: "p1",
    name: "evaluation-item",
    trace_start_time: at(0),
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "evaluation",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans: rows.map(([span_id, parent_span_id, name, span_kind, start, end, extra]) => ({
      span_id,
      trace_id: traceId,
      parent_span_id,
      name,
      span_kind,
      span_start_time: at(start),
      span_end_time: at(end),
      status: SpanStatus.OK,
      status_message: null,
      error_type: "",
      model_name: null,
      cost: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      git_source_file: null,
      git_source_line: null,
      git_source_function: null,
      ...extra,
    })),
  };
}

const llm = (input: number, output: number, cost: number): Partial<Span> => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  cost,
  model_name: "gpt-4o-mini",
});

/** An evaluation trace: the task, which may search before it answers, and a judge's LLM
 *  call under a scorer, whose tokens are the evaluation's, not the task's. */
const evaluation = (traceId: string, p: string, task: [number, number], searches: boolean) =>
  traceOf(traceId, [
    [`${p}r`, null, "evaluation-item", SpanKind.EVALUATION, 0, 1000],
    [`${p}t`, `${p}r`, "task", SpanKind.TASK, 10, 600],
    ...(searches
      ? ([[`${p}s`, `${p}t`, "web_search", SpanKind.TOOL, 20, 100]] satisfies Row[])
      : []),
    [`${p}a`, `${p}t`, "answer", SpanKind.LLM, 110, 590, llm(task[0], task[1], 0.004)],
    [`${p}j0`, `${p}r`, "faithfulness", SpanKind.SCORER, 610, 990],
    [
      `${p}j`,
      `${p}j0`,
      "judge",
      SpanKind.LLM,
      620,
      980,
      { ...llm(300, 0, 0.001), model_name: "judge-model" },
    ],
  ]);

const BASE = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z");
const CAND = fixtureRun("run-2", 2, "candidate-v2", "2026-11-02T10:00:00.000Z");
// sso: both real traces, the candidate no longer searches. refund: the baseline reported no
// trace; the candidate's isn't ingested yet. billing: the candidate reported no trace.
// export: only the baseline has a result.
const BUNDLES: RunBundle[] = [
  {
    run: BASE,
    results: [
      fixtureResult("run-1", "sso", "Reset SSO", [], {
        traceId: "trace-b1",
        durationMs: 1000,
        cost: 0.01,
      }),
      fixtureResult("run-1", "refund", "Refund me", [], { traceId: null, durationMs: null }),
      fixtureResult("run-1", "billing", "Billing", [], { traceId: "trace-b3" }),
      fixtureResult("run-1", "export", "Export as CSV", [], { traceId: "trace-b4" }),
    ],
  },
  {
    run: CAND,
    results: [
      fixtureResult("run-2", "sso", "Reset SSO", [], {
        traceId: "trace-c1",
        durationMs: 1200,
        cost: 0.02,
      }),
      fixtureResult("run-2", "refund", "Refund me", [], { traceId: "trace-c2", cost: null }),
      fixtureResult("run-2", "billing", "Billing", [], { traceId: null }),
    ],
  },
];

beforeEach(() => {
  traces.byId = new Map([
    ["trace-b1", evaluation("trace-b1", "b", [1000, 200], true)],
    ["trace-c1", evaluation("trace-c1", "c", [1100, 350], false)],
    ["trace-b3", evaluation("trace-b3", "x", [10, 10], false)],
    ["trace-b4", evaluation("trace-b4", "y", [10, 10], false)],
  ]);
  traces.io = new Map<string, Partial<SpanIO>>([
    ["trace-b1/ba", { input: '"Reset SSO"', output: '"Open Settings, then SSO."' }],
    ["trace-c1/ca", { input: '"Reset SSO"', output: '"Open Settings, then SSO, then Reset."' }],
  ]);
  traces.useTrace.mockReset();
  traces.refetch.mockReset();
  traces.useTrace.mockImplementation((_p: string, traceId: string, enabled: boolean) => {
    const data = enabled ? traces.byId.get(traceId) : undefined;
    return {
      data,
      isLoading: false,
      isFetching: false,
      isError: enabled && !data,
      refetch: traces.refetch,
    };
  });
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: BUNDLES.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
});
afterEach(() => cleanup());

function Page({ initial }: { initial: InspectedCase | null }) {
  const [inspected, setInspected] = React.useState(initial);
  return (
    <CompareRunsView
      projectId="p1"
      runIds={[BASE.id, CAND.id]}
      baselineId={null}
      onChangeBaseline={vi.fn()}
      onChangeRuns={vi.fn()}
      inspected={inspected}
      onInspect={setInspected}
    />
  );
}

const withQueries = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
const open = (caseId: string) =>
  withQueries(<Page initial={{ caseToken: `id:${caseId}`, pair: null }} />);
const inspector = () => screen.getByRole("dialog");
/** The trace ids fetched so far. */
const fetched = () =>
  traces.useTrace.mock.calls.filter(([, , enabled]) => enabled).map(([, traceId]) => traceId);
/** The tree's rows in diff mode, as [state, name]. */
const treeRows = () =>
  [...inspector().querySelectorAll<HTMLElement>("[data-diff-state]")]
    .filter((r) => r.querySelector("[data-span-name]"))
    .map((r) => [r.dataset.diffState, r.querySelector("[data-span-name]")!.textContent]);
const divergence = () => inspector().querySelector("[data-diff-summary]")?.textContent;
/** Wait for the panel to draw the candidate's trace, which it fetches itself. */
const traceShown = () => waitFor(() => expect(treeRows().length).toBeGreaterThan(0));

describe("A comparison case in the trace panel", () => {
  it("opens the candidate's real trace, as one tree with the baseline's", async () => {
    open("sso");
    await traceShown();
    expect(
      within(inspector()).getByRole("button", { name: "Diff" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(treeRows()).toEqual([
      ["matched", "evaluation-item"],
      ["matched", "task"],
      ["removed", "web_search"],
      ["matched", "answer"],
      ["matched", "faithfulness"],
      ["matched", "judge"],
    ]);
    expect(divergence()).toBe("3 matched · 0 added · 1 removed");
  });

  it("compares a selected span's input and output with the baseline's", async () => {
    open("sso");
    await traceShown();
    const answer = [...inspector().querySelectorAll<HTMLElement>("[data-diff-state]")].find(
      (r) => r.querySelector("[data-span-name]")?.textContent === "answer",
    )!;
    fireEvent.click(answer);
    const output = within(inspector()).getByRole("region", { name: "Output" });
    expect([...output.querySelectorAll("[data-word='add']")].map((w) => w.textContent)).toEqual([
      ", then Reset",
    ]);
    // Each side is named by its run.
    expect(within(output).getByRole("heading", { name: "Baseline · #1" })).toBeTruthy();
    expect(within(output).getByRole("heading", { name: "Candidate · #2" })).toBeTruthy();
  });

  it("shows the plain trace of the candidate with diff mode off", async () => {
    open("sso");
    await traceShown();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Diff" }));
    expect(treeRows()).toEqual([]);
    // Only the candidate's own spans: the search was the baseline's.
    expect(within(inspector()).queryAllByText("web_search")).toHaveLength(0);
    expect(within(inspector()).getAllByText("answer").length).toBeGreaterThan(0);
    expect(within(inspector()).queryByRole("combobox", { name: "Baseline run" })).toBeNull();
  });

  it("shows the baseline's trace after a swap", async () => {
    open("sso");
    await traceShown();
    fireEvent.click(
      within(inspector()).getByRole("button", { name: "Swap baseline and candidate" }),
    );
    await waitFor(() => expect(divergence()).toBe("3 matched · 1 added · 0 removed"));
  });

  it("offers the trace and its timeline, without detectors", async () => {
    open("sso");
    await traceShown();
    expect(within(inspector()).getByRole("button", { name: "Trace" })).toBeTruthy();
    expect(within(inspector()).getByRole("button", { name: "Timeline" })).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: "Detectors" })).toBeNull();
  });

  it("opens the candidate's trace on its own in a new tab, but not a rebuilt one", async () => {
    const newTab = vi.spyOn(window, "open").mockReturnValue(null);
    open("sso");
    await traceShown();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open in new tab" }));
    expect(newTab).toHaveBeenCalledTimes(1);
    expect(String(newTab.mock.calls[0][0])).toContain("traceId=trace-c1");
    cleanup();
    open("billing");
    expect(within(inspector()).queryByRole("button", { name: "Open in new tab" })).toBeNull();
    newTab.mockRestore();
  });

  it("rebuilds the trace of a result that reported none, as run detail does", () => {
    open("billing");
    expect(
      within(inspector()).getByText("Reconstructed — no telemetry was emitted for this result"),
    ).toBeTruthy();
    expect(treeRows().map(([, name]) => name)).toContain("task");
  });

  it("waits, with a retry, for a trace that hasn't been ingested yet", () => {
    open("refund");
    expect(within(inspector()).getByText("Trace is still being ingested")).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Retry" }));
    expect(traces.refetch).toHaveBeenCalled();
  });

  it("says so when the candidate has no result", () => {
    open("export");
    expect(within(inspector()).getByText("#2 has no result for this case.")).toBeTruthy();
  });

  it("says why there is no baseline trace to compare with", async () => {
    // The baseline of `refund` reported no trace either, so it is rebuilt; swapped, the
    // candidate's trace still being ingested is the baseline's.
    withQueries(<Page initial={{ caseToken: "id:refund", pair: [CAND.id, BASE.id] }} />);
    expect(divergence()).toBe("#2's trace is still being ingested");
  });

  it("stays in diff mode while stepping through cases", async () => {
    open("sso");
    await traceShown();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    expect(screen.getByRole("dialog", { name: "Case 2 of 4" })).toBeTruthy();
    expect(
      within(inspector()).getByRole("button", { name: "Diff" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("fetches the traces of the open case only", () => {
    withQueries(<Page initial={null} />);
    expect(fetched()).toEqual([]);
    cleanup();
    open("sso");
    expect(new Set(fetched())).toEqual(new Set(["trace-b1", "trace-c1"]));
  });
});
