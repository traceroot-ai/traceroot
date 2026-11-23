// @vitest-environment jsdom
/**
 * The case at the root of the inspector's trace panel, in diff mode: the case's input and
 * expected output once (or per run when they differ), both runs' full outputs side by side
 * or as one inline diff (or the candidate against the expected output), each copyable, and
 * a scores table with each side's value, explanation and error and the change between them.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fixtureResult,
  fixtureRun,
  fixtureScore,
  scorerManifest,
} from "./compare/__tests__/paired-fixture";
import type { RunBundle } from "./compare/model";
import type { InspectedCase } from "./compare/inspector/use-case-inspector";
import type { ScoreRow } from "./types";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn() }));
vi.mock("./hooks", () => hooks);
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
  // No trace has loaded: the inspector's usage reads as pending.
  const pending = { data: undefined, isLoading: true, isFetching: true, isError: false };
  return {
    ...actual,
    useTrace: () => ({ ...pending, refetch: vi.fn() }),
    useSpanIO: () => ({ data: undefined, isLoading: false }),
  };
});
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

const scorers = scorerManifest([
  { name: "quality", version: "1" },
  { name: "policy_violations", version: "1", value_type: "numeric", direction: "lower_is_better" },
  { name: "tone", version: "1", value_type: "categorical" },
  { name: "exact", version: "1" },
]);
const BASE = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z", { scorers });
const CAND = fixtureRun("run-2", 2, "candidate-v2", "2026-11-02T10:00:00.000Z", { scorers });

const score = (name: string, value: number | string | null, extra: Partial<ScoreRow> = {}) => ({
  ...fixtureScore(name, value),
  ...extra,
});

const SSO_INPUT = JSON.stringify({ question: "How do I reset SSO?" });
const EXPECTED = JSON.stringify("Settings → SSO → Reset");

const BUNDLES: RunBundle[] = [
  {
    run: BASE,
    results: [
      fixtureResult(
        "run-1",
        "sso",
        SSO_INPUT,
        [
          score("quality", 0.6, { explanation: "Misses the reset step." }),
          score("policy_violations", 3),
          score("tone", "warm"),
          score("exact", 0),
        ],
        {
          expectedOutput: EXPECTED,
          candidateOutput: JSON.stringify({ answer: "Open Settings", steps: ["Settings", "SSO"] }),
        },
      ),
      fixtureResult("run-1", "refund", "Refund me", [], { candidateOutput: "Refund issued." }),
      fixtureResult("run-1", "billing", "Billing question", []),
      fixtureResult("run-1", "empty", "Say nothing", [], { candidateOutput: "Nothing." }),
      // Genuine strings, stored JSON-encoded, that read as the same number once decoded twice.
      fixtureResult("run-1", "price", "Price?", [], { candidateOutput: JSON.stringify("1.50") }),
      fixtureResult("run-1", "same", "Same?", [], { candidateOutput: '{"a":1,"b":2}' }),
      fixtureResult("run-1", "partial", "Partial?", [], { candidateOutput: "full answer" }),
    ],
  },
  {
    run: CAND,
    results: [
      fixtureResult(
        "run-2",
        "sso",
        SSO_INPUT,
        [
          score("quality", 0.9, { explanation: "Covers every step." }),
          score("policy_violations", 0),
          score("tone", null, { error: "judge timed out" }),
          score("exact", 1, { scorerVersion: "2" }),
        ],
        {
          expectedOutput: EXPECTED,
          // Same answer, keys in another order, one more step.
          candidateOutput: JSON.stringify({
            steps: ["Settings", "SSO", "Reset"],
            answer: "Open Settings",
          }),
        },
      ),
      fixtureResult("run-2", "refund", "Refund me", [], {
        status: "errored",
        taskError: "Upstream timeout",
        candidateOutput: null,
      }),
      fixtureResult("run-2", "empty", "Say nothing", [], { candidateOutput: null }),
      fixtureResult("run-2", "price", "Price?", [], { candidateOutput: JSON.stringify("1.5") }),
      fixtureResult("run-2", "same", "Same?", [], { candidateOutput: '{"b":2,"a":1}' }),
      // The task failed after writing part of its output.
      fixtureResult("run-2", "partial", "Partial?", [], {
        status: "errored",
        taskError: "Ran out of time",
        candidateOutput: "partial answer",
      }),
    ],
  },
];

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
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
  const [inspected, setInspected] = React.useState<InspectedCase | null>(initial);
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
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const open = (caseId: string) =>
  withQueries(<Page initial={{ caseToken: `id:${caseId}`, pair: null }} />);
const inspector = () => screen.getByRole("dialog");
/** The text of each diff line of a kind, in order. */
const linesOf = (kind: "add" | "remove" | "context") =>
  [...inspector().querySelectorAll(`[data-line="${kind}"]`)].map(
    (el) => el.querySelector("[data-line-text]")?.textContent,
  );
const outputView = (name: string) =>
  fireEvent.click(within(inspector()).getByRole("button", { name }));

describe("Case inspector — the case's outputs", () => {
  it("shows the input and expected output once when both runs agree", () => {
    open("sso");
    const input = within(inspector()).getByRole("region", { name: "Input" });
    expect(input.textContent).toContain('"question": "How do I reset SSO?"');
    const expected = within(inspector()).getByRole("region", { name: "Expected" });
    expect(within(expected).getByText("Settings → SSO → Reset")).toBeTruthy();
  });

  it("collapses a section", () => {
    open("sso");
    const toggle = within(inspector()).getByRole("button", { name: "Input" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const input = within(inspector()).getByRole("region", { name: "Input" });
    expect(input.textContent).not.toContain("How do I reset SSO?");
  });

  it("lines the two outputs up side by side, marking only what changed", () => {
    open("sso");
    // Key order is not a change: the outputs are compared as canonical, indented JSON.
    expect(linesOf("context")).toContain('  "answer": "Open Settings",');
    expect(linesOf("remove")).toEqual(['    "SSO"']);
    expect(linesOf("add")).toEqual(['    "SSO",', '    "Reset"']);
  });

  it("shows the same change as one inline diff", () => {
    open("sso");
    outputView("Inline diff");
    const changed = [...inspector().querySelectorAll('[data-line="add"], [data-line="remove"]')];
    expect(changed.map((el) => el.textContent)).toEqual([
      '−    "SSO"',
      '+    "SSO",',
      '+    "Reset"',
    ]);
  });

  it("compares the candidate with the expected output", () => {
    open("sso");
    outputView("Candidate vs expected");
    expect(within(inspector()).getByRole("heading", { name: "Expected" })).toBeTruthy();
    expect(linesOf("remove")).toEqual(["Settings → SSO → Reset"]);
    expect(linesOf("add")).toContain('    "Reset"');
  });

  it("copies an output as it is shown", async () => {
    open("sso");
    await act(async () => {
      fireEvent.click(within(inspector()).getByRole("button", { name: "Copy candidate output" }));
    });
    expect(writeText).toHaveBeenCalledWith(
      '{\n  "answer": "Open Settings",\n  "steps": [\n    "Settings",\n    "SSO",\n    "Reset"\n  ]\n}',
    );
  });

  it("says why a run has no output", () => {
    const output = () => within(within(inspector()).getByRole("region", { name: "Output" }));
    open("refund");
    expect(output().getByText("Refund issued.")).toBeTruthy();
    expect(output().getByText("Task error")).toBeTruthy();
    expect(output().getByText("Upstream timeout")).toBeTruthy();
    cleanup();
    open("billing");
    expect(output().getByText("No result in this run")).toBeTruthy();
    cleanup();
    open("empty");
    expect(output().getByText("No output")).toBeTruthy();
  });
});

/** The scores table's row for a scorer, as cell texts. */
const scoreRow = (scorer: string) => {
  const table = within(inspector()).getByRole("table");
  const row = within(table)
    .getAllByRole("row")
    .find((r) => r.querySelector("td")?.textContent === scorer);
  if (!row) throw new Error(`no row for ${scorer}`);
  return [...row.querySelectorAll("td")].map((td) => td.textContent);
};

describe("Case inspector — comparing outputs", () => {
  it("compares each output as decoded once, so genuine strings keep their text", () => {
    open("price");
    expect(linesOf("remove")).toEqual(["1.50"]);
    expect(linesOf("add")).toEqual(["1.5"]);
  });

  it("finds no differences between objects whose keys are in another order", () => {
    open("same");
    expect(within(inspector()).getByText("No differences.")).toBeTruthy();
    expect(linesOf("add")).toEqual([]);
    expect(linesOf("remove")).toEqual([]);
  });

  it("marks the words that changed inside a changed line, in both layouts", () => {
    /** The marked words of each kind, in order. */
    const words = (kind: "add" | "remove") =>
      [...inspector().querySelectorAll(`[data-word="${kind}"]`)].map((el) => el.textContent);
    open("partial");
    expect(linesOf("remove")).toEqual(["full answer"]);
    expect(words("remove")).toEqual(["full"]);
    expect(words("add")).toEqual(["partial"]);
    outputView("Inline diff");
    expect(words("remove")).toEqual(["full"]);
    expect(words("add")).toEqual(["partial"]);
    cleanup();
    // One more array item: only the comma it needs reads as new on the line before it.
    open("sso");
    expect(words("remove")).toEqual([]);
    expect(words("add")).toEqual([","]);
  });

  it("says whose task failed in the inline diff", () => {
    open("partial");
    outputView("Inline diff");
    expect(within(inspector()).getByText("Candidate · #2: Task error")).toBeTruthy();
    expect(within(inspector()).getByText("Ran out of time")).toBeTruthy();
  });

  it("opens from a Version mismatch label in the table", () => {
    withQueries(<Page initial={null} />);
    fireEvent.click(screen.getByText("Version mismatch"));
    expect(screen.getByRole("dialog", { name: "Case 1 of 7" })).toBeTruthy();
  });
});

describe("Case inspector — scores", () => {
  it("lists each scorer's value on both runs with the change and each side's explanation", () => {
    open("sso");
    expect(scoreRow("quality")).toEqual([
      "quality",
      "60.0%Misses the reset step.",
      "90.0%Covers every step.",
      "+30.0 pp",
    ]);
    // A count where lower is better: 3 → 0 is an improvement.
    expect(scoreRow("policy_violations")).toEqual(["policy_violations", "3", "0", "−3"]);
  });

  it("shows a scorer error's message and marks a version change instead of comparing", () => {
    open("sso");
    expect(scoreRow("tone")).toEqual(["tone", "warm", "Scorer errorjudge timed out", "—"]);
    expect(scoreRow("exact")).toEqual(["exact", "0.0%", "100.0%", "Version mismatch"]);
  });

  it("follows the inspector's pair, so a swap reverses the change", () => {
    open("sso");
    fireEvent.click(
      within(inspector()).getByRole("button", { name: "Swap baseline and candidate" }),
    );
    expect(scoreRow("quality")).toEqual([
      "quality",
      "90.0%Covers every step.",
      "60.0%Misses the reset step.",
      "−30.0 pp",
    ]);
  });
});
