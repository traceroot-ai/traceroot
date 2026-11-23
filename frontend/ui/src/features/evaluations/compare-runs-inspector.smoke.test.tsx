// @vitest-environment jsdom
/**
 * A comparison row opens its case (click or Enter) in the trace panel, named in the URL;
 * Escape or Close closes it and puts focus back on the row; previous/next walk the rows in
 * the table's current order. The panel compares two of the runs, picked and swapped inside
 * it without touching the table's baseline.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
  fixtureResult,
  fixtureRun,
} from "./compare/__tests__/paired-fixture";
import type { InspectedCase } from "./compare/inspector/use-case-inspector";
import { runsLegendNow } from "./compare/__tests__/runs-menu";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  // No trace has loaded yet.
  const pending = { data: undefined, isLoading: true, isFetching: true, isError: false };
  return {
    ...actual,
    useTrace: () => ({ ...pending, refetch: vi.fn() }),
    useSpanIO: () => ({ data: undefined, isLoading: false }),
  };
});
// The trace panel's parts that need a browser or a server: its rows are virtualized (no
// layout in jsdom), it streams spans and looks up findings, and its details link out.
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
// The app shell's assistant rail: the trace panel claims its slot while open.
const layout = vi.hoisted(() => ({ registerAiHost: vi.fn(), release: vi.fn() }));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ registerAiHost: layout.registerAiHost }),
}));
// Each run's line the table renders, counted so a test can tell which cases re-rendered.
const lines = vi.hoisted(() => ({ renders: 0 }));
vi.mock("./compare/case-line", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compare/case-line")>();
  return {
    ...actual,
    CaseLine: (props: React.ComponentProps<typeof actual.CaseLine>) => {
      lines.renders += 1;
      return <actual.CaseLine {...props} />;
    },
  };
});

import { CompareRunsView } from "./views/compare-runs-view";

const BASE = BASELINE_RUN.id;
const CAND = CANDIDATE_RUN.id;
const FAST = FAST_RUN.id;
const RUN_IDS = [BASE, CAND, FAST];

beforeEach(() => {
  // Radix Select measures and captures the pointer, which jsdom lacks.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  layout.registerAiHost.mockReset().mockImplementation(() => layout.release);
  layout.release.mockReset();
  // Like the real hook, the same value from render to render until the runs change.
  const details = new Map<string, unknown>();
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) => {
    const key = ids.join(",");
    if (!details.has(key)) {
      details.set(
        key,
        ids.map((id) => ({
          data: PAIRED_FIXTURE.find((b) => b.run.id === id),
          isLoading: false,
          isError: false,
        })),
      );
    }
    return details.get(key);
  });
});
afterEach(() => cleanup());

/** The page's part: the open case lives in the URL, written back by `onInspect`. */
function Page({
  initial = null,
  onInspect,
  onChangeBaseline,
}: {
  initial?: InspectedCase | null;
  onInspect: (next: InspectedCase | null) => void;
  onChangeBaseline: (baselineId: string | null) => void;
}) {
  const [inspected, setInspected] = React.useState(initial);
  return (
    <CompareRunsView
      projectId="p1"
      runIds={RUN_IDS}
      baselineId={null}
      onChangeBaseline={onChangeBaseline}
      onChangeRuns={vi.fn()}
      inspected={inspected}
      onInspect={(next) => {
        onInspect(next);
        setInspected(next);
      }}
    />
  );
}

const mount = (initial: InspectedCase | null = null, onChangeBaseline = vi.fn()) => {
  const onInspect = vi.fn();
  // The app shell defines the size variables full screen reads (--app-header-h, --app-nav-w).
  render(
    <QueryClientProvider client={new QueryClient()}>
      <div data-testid="app-shell">
        <Page initial={initial} onInspect={onInspect} onChangeBaseline={onChangeBaseline} />
      </div>
    </QueryClientProvider>,
  );
  return onInspect;
};

/** The case's group of lines. */
const groupOf = (input: string) => rowOf(input).closest("tbody") as HTMLElement;
/** The comparison table's row whose input reads `input`: its case's first line. */
const rowOf = (input: string) => {
  const table = screen.getAllByRole("table")[0];
  const row = within(table)
    .getAllByRole("row")
    .find((r) => within(r).queryByText(input, { exact: true }));
  if (!row) throw new Error(`no row for ${input}`);
  return row;
};
const inspector = () => screen.getByRole("dialog");

describe("CompareRunsView — a case in the trace panel", () => {
  it("opens a case from its row and names it in the URL", () => {
    const onInspect = mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(groupOf("Ticket 3")).getAllByText("run-2 output")[0]);
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [BASE, CAND] });
    expect(screen.getByRole("dialog", { name: "Case 3 of 12" })).toBeTruthy();
    // Diffed against the baseline.
    expect(
      within(inspector()).getByRole("button", { name: "Diff" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(rowOf("Ticket 3").getAttribute("aria-current")).toBe("true");
  });

  it("opens the focused row with Enter, and the row says how", () => {
    mount();
    const row = rowOf("Ticket 4");
    expect(row.getAttribute("role")).toBeNull();
    expect(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Press Enter to open this case.",
    );
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Case 4 of 12" })).toBeTruthy();
  });

  it("opens the focused row with Space too, on the default pair", () => {
    const onInspect = mount();
    const row = rowOf("Ticket 5");
    row.focus();
    fireEvent.keyDown(row, { key: " " });
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-5", pair: [BASE, CAND] });
    expect(screen.getByRole("dialog", { name: "Case 5 of 12" })).toBeTruthy();
  });

  it("opens from a label that only shows a tooltip, on that label's run", () => {
    const onInspect = mount();
    // "Task error" is focusable only to show the error message on hover or focus.
    fireEvent.click(within(groupOf("Ticket 6")).getAllByText("Task error")[0]);
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-6", pair: [BASE, CAND] });
    expect(screen.getByRole("dialog", { name: "Case 6 of 12" })).toBeTruthy();
  });

  it("leaves the case closed when a click ends a text selection", () => {
    const onInspect = mount();
    const selection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ toString: () => "run-2 output" } as Selection);
    fireEvent.click(within(groupOf("Ticket 3")).getAllByText("run-2 output")[0]);
    selection.mockRestore();
    expect(onInspect).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts on the panel when it opens, never on an action in its header", async () => {
    mount();
    fireEvent.click(rowOf("Ticket 3"));
    await waitFor(() => expect(document.activeElement).toBe(inspector()));
  });

  it("announces the case it moves to", () => {
    mount();
    fireEvent.click(rowOf("Ticket 3"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    const live = within(inspector()).getByRole("status");
    expect(live.textContent).toBe("Case 4 of 12");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("does not announce again when the search moves the open case's position", () => {
    mount();
    fireEvent.click(rowOf("Ticket 3"));
    const live = within(inspector()).getByRole("status");
    expect(live.textContent).toBe("Case 3 of 12");
    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "ticket 3" } });
    expect(screen.getByRole("dialog", { name: "Case 1 of 1" })).toBeTruthy();
    expect(within(inspector()).getByRole("status")).toBe(live);
    expect(live.textContent).toBe("Case 3 of 12");
  });

  it("takes the assistant's slot while open, so the page's assistant rail stays clear of it", () => {
    mount();
    expect(layout.registerAiHost).not.toHaveBeenCalled();
    fireEvent.click(rowOf("Ticket 3"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    expect(layout.registerAiHost).toHaveBeenCalledTimes(1);
    expect(layout.release).not.toHaveBeenCalled();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Close" }));
    expect(layout.release).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape and puts focus back on the row", async () => {
    const onInspect = mount();
    fireEvent.click(rowOf("Ticket 5"));
    expect(inspector()).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onInspect).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(rowOf("Ticket 5")));
  });

  it("closes from its Close button", async () => {
    const onInspect = mount();
    fireEvent.click(rowOf("Ticket 2"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Close" }));
    expect(onInspect).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(document.activeElement).toBe(rowOf("Ticket 2")));
  });

  it("scrolls the table only as far as the row needs when focus goes back to it", async () => {
    mount();
    fireEvent.click(rowOf("Ticket 5"));
    const scrolled = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
    scrolled.mockClear();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(rowOf("Ticket 5")));
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("walks to the previous and next case in the table's order", () => {
    const onInspect = mount();
    fireEvent.click(rowOf("Ticket 1"));
    const previous = within(inspector()).getByRole("button", { name: "Previous case" });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-2", pair: [BASE, CAND] });
    expect(screen.getByRole("dialog", { name: "Case 2 of 12" })).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Previous case" }));
    expect(screen.getByRole("dialog", { name: "Case 1 of 12" })).toBeTruthy();
  });

  it("follows the rows the search leaves, in their order", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "ticket 1" } });
    // Ticket 10 comes last: only the candidate and the third run have it.
    fireEvent.click(rowOf("Ticket 12"));
    expect(screen.getByRole("dialog", { name: "Case 3 of 4" })).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    expect(
      screen.getByRole("dialog", { name: "Case 4 of 4", description: "Ticket 10" }),
    ).toBeTruthy();
    const next = within(inspector()).getByRole("button", { name: "Next case" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("reopens the case the URL names, and stays closed for one no case has", () => {
    mount({ caseToken: "id:case-5", pair: null });
    expect(screen.getByRole("dialog", { name: "Case 5 of 12" })).toBeTruthy();
    cleanup();
    mount({ caseToken: "id:no-such-case", pair: null });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("names a case lined up by input by a hash of its input, and reopens it from that", () => {
    // A run on another dataset brings a case the baseline doesn't have: its row is known by
    // its input alone.
    const other = fixtureRun("run-9", 9, "other-v1", "2026-11-04T10:00:00.000Z", {
      datasetId: "ds2",
      datasetName: "tickets-v2",
      datasetVersionId: "dv2",
    });
    const bundles = [
      PAIRED_FIXTURE.find((b) => b.run.id === BASE)!,
      {
        run: other,
        results: [
          fixtureResult(other.id, "x-1", "Ticket 1", []),
          fixtureResult(other.id, "x-99", "Ticket 99", []),
        ],
      },
    ];
    const queries = bundles.map((data) => ({ data, isLoading: false, isError: false }));
    hooks.useEvaluationRunDetails.mockImplementation(() => queries);
    const view = (inspected: InspectedCase | null, onInspect = vi.fn()) => (
      <QueryClientProvider client={new QueryClient()}>
        <CompareRunsView
          projectId="p1"
          runIds={[BASE, other.id]}
          baselineId={null}
          onChangeBaseline={vi.fn()}
          onChangeRuns={vi.fn()}
          inspected={inspected}
          onInspect={onInspect}
        />
      </QueryClientProvider>
    );
    const onInspect = vi.fn();
    render(view(null, onInspect));
    fireEvent.click(rowOf("Ticket 99"));
    const token = onInspect.mock.lastCall?.[0]?.caseToken as string;
    expect(token).toMatch(/^h:[0-9a-f]{16}$/);
    cleanup();
    render(view({ caseToken: token, pair: null }));
    expect(screen.getByRole("dialog", { description: "Ticket 99" })).toBeTruthy();
  });

  it("renders inside the page, where the app shell's size variables resolve", () => {
    mount({ caseToken: "id:case-1", pair: null });
    // Portalled to <body>, full screen's top and width would read undefined variables.
    expect(screen.getByTestId("app-shell").contains(inspector())).toBe(true);
  });

  it("widens to full screen and back", () => {
    mount({ caseToken: "id:case-1", pair: null });
    fireEvent.click(within(inspector()).getByRole("button", { name: "Expand to full screen" }));
    expect(inspector().className).toContain("w-[calc(100%-var(--app-nav-w))]");
    expect(inspector().className).toContain("top-[var(--app-header-h)]");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Restore default size" }));
    expect(inspector().className).toContain("md:w-[70vw]");
    expect(inspector().className).toContain("md:min-w-[720px]");
  });
});

/** The trace panel's run picker for one side. */
const sidePicker = (side: "Baseline" | "Candidate") =>
  within(inspector()).getByRole("combobox", { name: `${side} run` });

describe("CompareRunsView — the trace panel's two runs", () => {
  it("opens with the run whose value was clicked as the candidate", () => {
    const onInspect = mount();
    fireEvent.click(within(groupOf("Ticket 3")).getByText("run-3 output"));
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [BASE, FAST] });
    expect(sidePicker("Baseline").textContent).toBe("#1 baseline-v1");
    expect(sidePicker("Candidate").textContent).toBe("#3 fast-v3");
  });

  it("opens with the first run after the baseline when the click names no run", () => {
    const onInspect = mount();
    // Every run has the same input, so the cell shows it once.
    fireEvent.click(rowOf("Ticket 3").querySelector("td")!);
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [BASE, CAND] });
  });

  it("opens with the last candidate shown when the click names no run", () => {
    const onInspect = mount();
    fireEvent.click(within(groupOf("Ticket 3")).getByText("run-3 output"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Close" }));
    fireEvent.click(rowOf("Ticket 4").querySelector("td")!);
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-4", pair: [BASE, FAST] });
  });

  it("swaps the two runs without changing the table's baseline", () => {
    const onChangeBaseline = vi.fn();
    const onInspect = mount({ caseToken: "id:case-3", pair: null }, onChangeBaseline);
    fireEvent.click(
      within(inspector()).getByRole("button", { name: "Swap baseline and candidate" }),
    );
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [CAND, BASE] });
    expect(onChangeBaseline).not.toHaveBeenCalled();
    expect(sidePicker("Baseline").textContent).toBe("#2 candidate-v2");
    expect(sidePicker("Candidate").textContent).toBe("#1 baseline-v1");
    // The table still compares against #1.
    const legend = runsLegendNow();
    expect(within(legend).getByRole("button", { name: /#1 baseline-v1/ }).textContent).toContain(
      "Baseline",
    );
  });

  it("picks either side from the runs compared, never the run on the other side", async () => {
    const onInspect = mount({ caseToken: "id:case-3", pair: null });
    fireEvent.click(sidePicker("Candidate"));
    const baselineOption = await screen.findByRole("option", { name: "#1 baseline-v1" });
    expect(baselineOption.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "#3 fast-v3" }));
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [BASE, FAST] });
    fireEvent.click(sidePicker("Baseline"));
    fireEvent.click(await screen.findByRole("option", { name: "#2 candidate-v2" }));
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-3", pair: [CAND, FAST] });
  });

  it("keeps the pair while stepping through cases", () => {
    const onInspect = mount({ caseToken: "id:case-3", pair: [FAST, CAND] });
    fireEvent.click(within(inspector()).getByRole("button", { name: "Next case" }));
    expect(onInspect).toHaveBeenLastCalledWith({ caseToken: "id:case-4", pair: [FAST, CAND] });
  });

  it("restores the pair the URL names, and the default for one it can't use", () => {
    mount({ caseToken: "id:case-3", pair: [FAST, CAND] });
    expect(sidePicker("Baseline").textContent).toBe("#3 fast-v3");
    expect(sidePicker("Candidate").textContent).toBe("#2 candidate-v2");
    cleanup();
    mount({ caseToken: "id:case-3", pair: ["run-gone", CAND] });
    expect(sidePicker("Baseline").textContent).toBe("#1 baseline-v1");
    expect(sidePicker("Candidate").textContent).toBe("#2 candidate-v2");
  });
});

describe("CompareRunsView — table rows", () => {
  it("re-renders only the cases a change is about, not every case", () => {
    mount();
    lines.renders = 0;
    // A search every case matches leaves every case as it was.
    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "Ticket" } });
    expect(lines.renders).toBe(0);
    // Opening a case re-renders its lines alone; opening another, the two cases that changed.
    fireEvent.click(rowOf("Ticket 3"));
    expect(lines.renders).toBe(RUN_IDS.length);
    lines.renders = 0;
    fireEvent.click(rowOf("Ticket 4"));
    expect(lines.renders).toBe(2 * RUN_IDS.length);
  });
});
