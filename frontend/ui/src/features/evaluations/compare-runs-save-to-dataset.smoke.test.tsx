// @vitest-environment jsdom
/**
 * Keeping a finding from a comparison case: "Save to dataset", on the case's root in the
 * trace panel, acts on the candidate's result for the open case, through the evaluations'
 * own save drawer (update its source case, save it as a new case, or duplicate it as a
 * variant), starting from the candidate run's dataset. With no candidate result there is
 * nothing to save. An open save stays on the case it was opened for while the trace panel
 * moves on, and closing it puts focus back where the save started.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  BASELINE_RUN,
  CANDIDATE_RUN,
  FAST_RUN,
  PAIRED_FIXTURE,
} from "./compare/__tests__/paired-fixture";
import type { RunBundle } from "./compare/model";
import type { InspectedCase } from "./compare/inspector/use-case-inspector";

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const hooks = vi.hoisted(() => ({ useEvaluationRunDetails: vi.fn(), useDatasets: vi.fn() }));
vi.mock("./hooks", () => hooks);
vi.mock("@/features/traces/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces/hooks")>();
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

const BASE = BASELINE_RUN.id;
const CAND = CANDIDATE_RUN.id;
const FAST = FAST_RUN.id;

let fetchMock: ReturnType<typeof vi.fn>;
const serve = (bundles: RunBundle[]) =>
  hooks.useEvaluationRunDetails.mockImplementation((_p: string, ids: string[]) =>
    ids.map((id) => ({
      data: bundles.find((b) => b.run.id === id),
      isLoading: false,
      isError: false,
    })),
  );

beforeEach(() => {
  // Radix Select measures and captures the pointer, which jsdom lacks.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  serve(PAIRED_FIXTURE);
  hooks.useDatasets.mockReturnValue({
    data: {
      data: [
        { id: "ds1", name: "support-tickets" },
        { id: "ds9", name: "escalations" },
      ],
    },
    isLoading: false,
    isError: false,
  });
  fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }) as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(initial: InspectedCase) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Page() {
    const [inspected, setInspected] = React.useState<InspectedCase | null>(initial);
    return (
      <CompareRunsView
        projectId="p1"
        runIds={[BASE, CAND, FAST]}
        baselineId={null}
        onChangeBaseline={vi.fn()}
        onChangeRuns={vi.fn()}
        inspected={inspected}
        onInspect={setInspected}
      />
    );
  }
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const inspector = () => screen.getByRole("dialog", { name: /^Case / });
/** The comparison table's row whose input reads `input`. */
const rowOf = (input: string) => {
  // The comparison's table comes first; the trace panel has tables of its own.
  const row = within(screen.getAllByRole("table")[0])
    .getAllByRole("row")
    .find((r) => within(r).queryByText(input, { exact: true }));
  if (!row) throw new Error(`no row for ${input}`);
  return row;
};
const saveButton = () => within(inspector()).getByRole("button", { name: "Save to dataset" });
/** Pick an action from the Save to dataset menu; resolves with the drawer it opens. */
async function choose(action: RegExp) {
  fireEvent.pointerDown(saveButton(), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
  return screen.findByRole("dialog", { name: action });
}
const posted = () => {
  const call = fetchMock.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "POST",
  );
  return { url: call?.[0] as string, body: JSON.parse((call?.[1] as RequestInit).body as string) };
};

describe("CompareRunsView — save to dataset", () => {
  it("offers the save drawer's three actions, on the candidate's result", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    fireEvent.pointerDown(saveButton(), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Candidate · #2")).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => [...i.children].map((c) => c.textContent)),
    ).toEqual([
      ["Update source case", "Publish a new version of this case"],
      // Its own dataset already holds the case, so a new one goes elsewhere.
      ["Save as a new case", "Add it to another dataset as a new case"],
      ["Duplicate as a variant", "Branch this case without touching the original"],
    ]);
  });

  it("updates the candidate's source case, in its run's dataset", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = within(await choose(/^Update source case/));
    expect(drawer.getByText("support-tickets")).toBeTruthy();
    expect(drawer.getByText("case-3")).toBeTruthy();
    expect((drawer.getByLabelText("Input") as HTMLTextAreaElement).value).toBe("Ticket 3");
    fireEvent.click(drawer.getByRole("switch"));
    fireEvent.click(drawer.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted().url).toBeDefined());
    expect(posted().url).toBe(`/api/projects/p1/evaluations/results/${CAND}-case-3/dataset-case`);
    expect(posted().body).toMatchObject({
      action: "update_existing_case",
      use_candidate_as_expected: true,
    });
  });

  it("saves a new case, starting from the candidate run's dataset", async () => {
    mount({ caseToken: "id:case-4", pair: [BASE, FAST] });
    const drawer = within(await choose(/^Save as a new case/));
    expect(drawer.getByRole("combobox").textContent).toBe("support-tickets");
    fireEvent.click(drawer.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted().url).toBeDefined());
    expect(posted().url).toBe(`/api/projects/p1/evaluations/results/${FAST}-case-4/dataset-case`);
    expect(posted().body).toMatchObject({ action: "save_new_case", dataset_id: "ds1" });
  });

  it("uses the candidate run's own dataset when the runs are on different datasets", async () => {
    serve(
      PAIRED_FIXTURE.map((b) =>
        b.run.id === CAND
          ? { ...b, run: { ...b.run, datasetId: "ds9", datasetName: "escalations" } }
          : b,
      ),
    );
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = within(await choose(/^Update source case/));
    expect(drawer.getByText("escalations")).toBeTruthy();
  });

  it("moves focus into the drawer, and Escape closes it without closing the case", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = await choose(/^Duplicate as a variant/);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Duplicate as a variant/ })).toBeNull(),
    );
    expect(inspector()).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
  });

  it("puts focus back on Save to dataset when the drawer closes", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = within(await choose(/^Update source case/));
    fireEvent.click(drawer.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Update source case/ })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
  });

  it("keeps an open save on its case, edits included, when another row is clicked", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = await choose(/^Duplicate as a variant/);
    fireEvent.change(within(drawer).getByLabelText("Input"), {
      target: { value: "Ticket 3, reworded" },
    });
    fireEvent.click(rowOf("Ticket 5"));
    expect(screen.getByRole("dialog", { name: "Case 5 of 12" })).toBeTruthy();
    // Nor when the trace panel's candidate changes.
    fireEvent.click(
      within(inspector()).getByRole("button", { name: "Swap baseline and candidate" }),
    );
    const still = within(screen.getByRole("dialog", { name: /^Duplicate as a variant/ }));
    expect((still.getByLabelText("Input") as HTMLTextAreaElement).value).toBe("Ticket 3, reworded");
    fireEvent.click(still.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted().url).toBeDefined());
    expect(posted().url).toBe(`/api/projects/p1/evaluations/results/${CAND}-case-3/dataset-case`);
    expect(posted().body).toMatchObject({
      action: "duplicate_as_variant",
      input: "Ticket 3, reworded",
    });
  });

  it("stays open on a case with no candidate result, then gives focus to the trace panel", async () => {
    mount({ caseToken: "id:case-3", pair: [BASE, CAND] });
    const drawer = within(await choose(/^Duplicate as a variant/));
    fireEvent.click(rowOf("Ticket 9"));
    expect(screen.getByRole("dialog", { name: "Case 9 of 12" })).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: "Save to dataset" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /^Duplicate as a variant/ })).toBeTruthy();
    fireEvent.click(drawer.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Duplicate as a variant/ })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(inspector()));
  });

  it("offers nothing to save when the candidate has no result for the case", () => {
    mount({ caseToken: "id:case-9", pair: [BASE, CAND] });
    expect(within(inspector()).getByText("#2 has no result for this case.")).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: "Save to dataset" })).toBeNull();
  });
});
