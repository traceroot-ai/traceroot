// @vitest-environment jsdom
/**
 * A comparison case can open while the baseline's trace is still being ingested. The panel
 * keeps that trace live, as it does the candidate's, so a baseline span that lands later is
 * matched in the diff instead of reading as added. Each trace shown has one live connection,
 * closed when the panel moves to another case.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";
import { fixtureResult, fixtureRun } from "./compare/__tests__/paired-fixture";
import type { RunBundle } from "./compare/model";
import type { InspectedCase } from "./compare/inspector/use-case-inspector";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);

/** The stored traces by id, read by the real trace fetches. */
const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getTrace: async (_p: string, traceId: string) => stored.get(traceId),
}));
// Signed in, so the case's own trace fetches run.
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "user@example.com" } }, isPending: false }),
}));
// The trace panel's parts that need a browser or a server, apart from its live stream.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32, size: 32 })),
    scrollToIndex: vi.fn(),
  }),
}));
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

import { CompareRunsView } from "./views/compare-runs-view";

let connections: FakeEventSource[] = [];

/** A live connection the page opened, in place of the browser's EventSource. */
class FakeEventSource {
  closed = false;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, (event: { data: string }) => void>();
  constructor(readonly url: string) {
    connections.push(this);
  }
  addEventListener(type: string, handler: (event: { data: string }) => void) {
    this.handlers.set(type, handler);
  }
  close() {
    this.closed = true;
  }
  /** The server sends an event of `type`. */
  send(type: string, data: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) });
  }
}

/** The ids of the traces with a live connection open. */
const liveTraces = () =>
  connections
    .filter((c) => !c.closed)
    .map((c) => /\/traces\/(.+)\/live$/.exec(c.url)?.[1])
    .sort();

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

function span(
  traceId: string,
  span_id: string,
  parent_span_id: string | null,
  name: string,
  span_kind: Span["span_kind"],
  [start, end]: [number, number],
): Span {
  return {
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
  };
}

/** An evaluation trace's spans: the task, and the LLM call it answers with. */
const evaluationSpans = (traceId: string, p: string) => [
  span(traceId, `${p}r`, null, "evaluation-item", SpanKind.EVALUATION, [0, 1000]),
  span(traceId, `${p}t`, `${p}r`, "task", SpanKind.TASK, [10, 600]),
  span(traceId, `${p}a`, `${p}t`, "answer", SpanKind.LLM, [110, 590]),
];

const traceOf = (traceId: string, spans: Span[]): TraceDetail => ({
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
  spans,
});

const BASE = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z");
const CAND = fixtureRun("run-2", 2, "candidate-v2", "2026-11-02T10:00:00.000Z");
// sso: both runs reported a trace. refund: the baseline reported none, so it's rebuilt.
const BUNDLES: RunBundle[] = [
  {
    run: BASE,
    results: [
      fixtureResult("run-1", "sso", "Reset SSO", [], { traceId: "trace-b1" }),
      fixtureResult("run-1", "refund", "Refund me", [], { traceId: null }),
    ],
  },
  {
    run: CAND,
    results: [
      fixtureResult("run-2", "sso", "Reset SSO", [], { traceId: "trace-c1" }),
      fixtureResult("run-2", "refund", "Refund me", [], { traceId: "trace-c2" }),
    ],
  },
];

/** The baseline's answer, which hasn't been ingested yet when the case opens. */
const lateAnswer = evaluationSpans("trace-b1", "b").find((s) => s.name === "answer")!;

beforeEach(() => {
  connections = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  stored.clear();
  stored.set(
    "trace-b1",
    traceOf(
      "trace-b1",
      evaluationSpans("trace-b1", "b").filter((s) => s.span_id !== lateAnswer.span_id),
    ),
  );
  stored.set("trace-c1", traceOf("trace-c1", evaluationSpans("trace-c1", "c")));
  stored.set("trace-c2", traceOf("trace-c2", evaluationSpans("trace-c2", "d")));
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: BUNDLES.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Page({ caseId }: { caseId: string }) {
  const [inspected, setInspected] = React.useState<InspectedCase | null>({
    caseToken: `id:${caseId}`,
    pair: null,
  });
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

const open = (caseId: string) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page caseId={caseId} />
    </QueryClientProvider>,
  );
const inspector = () => screen.getByRole("dialog");
/** The tree's rows in diff mode, as [state, name]. */
const treeRows = () =>
  [...inspector().querySelectorAll<HTMLElement>("[data-diff-state]")]
    .filter((r) => r.querySelector("[data-span-name]"))
    .map((r) => [r.dataset.diffState, r.querySelector("[data-span-name]")!.textContent]);

describe("A comparison case whose baseline trace is still being ingested", () => {
  it("matches a baseline span that lands after the case opens", async () => {
    open("sso");
    await waitFor(() => expect(treeRows()).toContainEqual(["added", "answer"]));
    await act(async () => {
      for (const c of connections.filter((c) => !c.closed && c.url.includes("/trace-b1/"))) {
        c.send("spans", { spans: [lateAnswer] });
      }
    });
    await waitFor(() =>
      expect(treeRows()).toEqual([
        ["matched", "evaluation-item"],
        ["matched", "task"],
        ["matched", "answer"],
      ]),
    );
  });

  it("keeps one live connection per trace shown, and moves them with the case", async () => {
    open("sso");
    await waitFor(() => expect(treeRows().length).toBeGreaterThan(0));
    // The candidate's is the panel's own; the baseline's is the comparison's.
    expect(liveTraces()).toEqual(["trace-b1", "trace-c1"]);
    expect(connections).toHaveLength(2);
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    // The next case's baseline is rebuilt from its result: there is no trace of it to stream.
    expect(liveTraces()).toEqual(["trace-c2"]);
  });
});
