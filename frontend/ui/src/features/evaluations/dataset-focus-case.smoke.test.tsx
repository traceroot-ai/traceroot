// @vitest-environment jsdom
/**
 * Adding or editing a dataset row must SHOW the user the row it touched. The
 * publish response already carries `focusTestCaseId` (the POST sets it to the
 * new case, the PATCH to the edited one); these tests pin that the view
 * consumes it — scrolling that row into view and flashing it — instead of
 * leaving the change invisible below the fold.
 *
 * jsdom has no layout, so nothing here proves a row was actually off-screen or
 * that the browser scrolled. What it does prove: the right element is asked to
 * scroll, with `block: "nearest"` (the option that leaves an already-visible row
 * alone), and that the row carries the one-shot highlight class.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", datasetId: "ds1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/datasets/ds1",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-assistant" />,
}));

import { DatasetDetailView } from "./views/dataset-detail-view";

// ---------------------------------------------------------------------------
// Server-shaped fixtures
// ---------------------------------------------------------------------------

const DATASET = {
  id: "ds1",
  projectId: "p1",
  name: "Billing routing",
  description: null,
  currentVersionId: "dv2",
  createTime: "2026-08-20T00:00:00Z",
  updateTime: "2026-08-21T00:00:00Z",
  caseCount: 3,
  versionCount: 2,
};
const V2 = {
  id: "dv2",
  datasetId: "ds1",
  projectId: "p1",
  versionNumber: 2,
  label: "v2",
  note: null,
  createdBy: null,
  createTime: "2026-08-21T00:00:00Z",
};
/** What every publish here creates: datasets are immutable, so a save never edits
 *  a version in place — it publishes the next one. */
const V3 = { ...V2, id: "dv3", versionNumber: 3, label: "v3", createTime: "2026-08-21T12:00:00Z" };

function testCase(id: string, input: string, over: Record<string, unknown> = {}) {
  return {
    id: `row-${id}`,
    testCaseId: id,
    datasetVersionId: "dv2",
    datasetId: "ds1",
    projectId: "p1",
    input,
    expected: null,
    metadata: null,
    review: "needs_review",
    captureReason: "manual",
    sourceTraceId: null,
    sourceSpanId: null,
    sourceSpanName: null,
    sourceSpanKind: null,
    addedBy: null,
    createTime: "2026-08-21T10:00:00Z",
    ...over,
  };
}

const SEED = [
  testCase("tc_1", "I was charged twice"),
  testCase("tc_2", "Reset my password please"),
  testCase("tc_3", "Where is my refund"),
];

/** Rows the dataset GET currently serves; a POST/PATCH mutates this. */
let cases: ReturnType<typeof testCase>[] = [];
/** The version the dataset GET currently serves; a POST/PATCH moves it to V3. */
let currentVersion = V2;
/** What the publish response reports as the row to reveal. */
let focusTestCaseId = "";

/** Every `scrollIntoView` call, with the element that received it. */
let scrolled: Array<{ el: HTMLElement; opts: ScrollIntoViewOptions | undefined }> = [];
/** Delay applied to the dataset GET that follows a publish (0 = answer at once). */
let refetchDelayMs = 0;
/** When set, the first dataset GET after a publish rejects (a transient failure). */
let failNextRefetch = false;
let publishSeen = false;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = function (
    this: HTMLElement,
    opts?: boolean | ScrollIntoViewOptions,
  ) {
    scrolled.push({ el: this, opts: typeof opts === "object" ? opts : undefined });
  };
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

beforeEach(() => {
  cases = [...SEED];
  currentVersion = V2;
  focusTestCaseId = "";
  scrolled = [];
  refetchDelayMs = 0;
  failNextRefetch = false;
  publishSeen = false;
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && s.includes("/test-cases")) {
      cases = [...cases, testCase("tc_new", "a brand new question", { datasetVersionId: V3.id })];
      currentVersion = V3;
      publishSeen = true;
      return { ok: true, status: 201, json: async () => ({ duplicate: false, ...published() }) };
    }
    if (method === "PATCH" && s.includes("/test-cases/")) {
      // The edited case keeps its stable `testCaseId` but lands in a new version
      // as a NEW row — a fresh per-version row id, carrying the edited input.
      // Nothing about the pre-edit row is rewritten; the server never mutates a
      // published snapshot.
      const edited = decodeURIComponent(s.split("/test-cases/")[1]);
      const patch = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      cases = cases.map((c) =>
        c.testCaseId === edited
          ? { ...c, id: `${c.id}-v3`, datasetVersionId: V3.id, input: patch.input ?? c.input }
          : c,
      );
      currentVersion = V3;
      publishSeen = true;
      return { ok: true, status: 201, json: async () => published() };
    }
    if (publishSeen && refetchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, refetchDelayMs));
    }
    if (publishSeen && failNextRefetch && !s.endsWith("/runs")) {
      failNextRefetch = false;
      throw new Error("network");
    }
    return { ok: true, status: 200, json: async () => payloadFor(s) };
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function published() {
  return {
    versionId: V3.id,
    versionNumber: V3.versionNumber,
    focusTestCaseId,
    caseCount: cases.length,
  };
}

function payloadFor(url: string): unknown {
  if (url.includes("/test-cases/") && url.endsWith("/runs")) return { data: [] };
  if (url.includes("/evaluations/runs"))
    return { data: [], meta: { page: 0, limit: 50, total: 0 } };
  return {
    dataset: { ...DATASET, currentVersionId: currentVersion.id },
    currentVersion,
    selectedVersion: currentVersion,
    isCurrentVersion: true,
    testCases: cases,
    versions: currentVersion === V3 ? [V3, V2] : [V2],
  };
}

function mountDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DatasetDetailView projectId="p1" datasetId="ds1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The rendered row for a stable testCaseId, or null when it isn't on the page. */
function row(testCaseId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`tr[data-test-case-id="${testCaseId}"]`);
}

/** The elements scrollIntoView was called on, for identity (not id) comparisons —
 *  a publish replaces a row's element, and only identity tells the two apart. */
function scrolledElements(): HTMLElement[] {
  return scrolled.map((s) => s.el);
}

/** Only the scroll calls aimed at a table row (Radix and the panel scroll too). */
function scrolledRowIds(): string[] {
  return scrolled.map((s) => s.el.dataset.testCaseId).filter((id): id is string => !!id);
}

async function addRow(input = "a brand new question") {
  fireEvent.click(screen.getByRole("button", { name: "Row" }));
  await screen.findByText("New Row");
  fireEvent.change(screen.getByLabelText("Input"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Row added");
}

/** Edit the first row's input via the row action menu (the PATCH path). */
async function editFirstRow(input = "edited question") {
  fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
  fireEvent.click(await screen.findByText("Edit"));
  await screen.findByText("Edit Row");
  fireEvent.change(screen.getByLabelText("Input"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Row saved/);
}

describe("Dataset detail — revealing the row a publish touched", () => {
  it("scrolls the added row into view and flashes it", async () => {
    focusTestCaseId = "tc_new";
    mountDetail();
    await screen.findByText("I was charged twice");
    await addRow();

    await waitFor(() => expect(row("tc_new")).not.toBeNull());
    await waitFor(() => expect(scrolledRowIds()).toContain("tc_new"));
    expect(row("tc_new")!.className).toContain("animate-row-flash");
    // Never a persistent selection — the panel stays shut and nothing is marked open.
    expect(row("tc_new")!.getAttribute("data-selected")).toBeNull();
  });

  it("asks for `block: nearest`, which leaves an already-visible row where it is", async () => {
    focusTestCaseId = "tc_new";
    mountDetail();
    await screen.findByText("I was charged twice");
    await addRow();

    await waitFor(() => expect(scrolledRowIds()).toContain("tc_new"));
    const call = scrolled.find((s) => s.el.dataset.testCaseId === "tc_new")!;
    expect(call.opts?.block).toBe("nearest");
  });

  it("follows the server's focusTestCaseId rather than assuming the last row", async () => {
    // The server says to reveal an EXISTING row while the refetched version still
    // appends the new case last. Deriving the target client-side ("the new row is
    // the last one") would scroll to tc_new and fail here.
    focusTestCaseId = "tc_2";
    mountDetail();
    await screen.findByText("I was charged twice");
    await addRow();

    await waitFor(() => expect(scrolledRowIds()).toContain("tc_2"));
    expect(scrolledRowIds()).not.toContain("tc_new");
    expect(row("tc_2")!.className).toContain("animate-row-flash");
    expect(row("tc_new")!.className).not.toContain("animate-row-flash");
  });

  it("leaves the order alone — the added row is still last", async () => {
    focusTestCaseId = "tc_new";
    mountDetail();
    await screen.findByText("I was charged twice");
    await addRow();

    await waitFor(() => expect(row("tc_new")).not.toBeNull());
    const ids = Array.from(document.querySelectorAll<HTMLElement>("tr[data-test-case-id]")).map(
      (el) => el.dataset.testCaseId,
    );
    expect(ids).toEqual(["tc_1", "tc_2", "tc_3", "tc_new"]);
  });

  it("flashes the edited row on the PATCH path too", async () => {
    focusTestCaseId = "tc_1";
    mountDetail();
    await screen.findByText("I was charged twice");
    await editFirstRow();

    await waitFor(() => expect(scrolledRowIds()).toContain("tc_1"));
    expect(row("tc_1")!.className).toContain("animate-row-flash");
  });

  it("waits for the edited row's own version when the refetch outlives the flash", async () => {
    // An edit KEEPS the case's testCaseId, so a row carrying that id is already on
    // screen from the PRE-edit version — unlike an add, whose row does not exist
    // until the refetch lands. Targeting whatever row currently holds the id would
    // scroll and flash pre-edit content and start the expiry against a row about to
    // be replaced: past the flash duration, the edited row arrives unmarked and the
    // save reads as the no-op this whole change exists to fix.
    focusTestCaseId = "tc_1";
    refetchDelayMs = 2500; // > ROW_FLASH_MS (2000)
    mountDetail();
    await screen.findByText("I was charged twice");
    const preEditRow = row("tc_1")!;

    await editFirstRow();

    // The edited row only exists once the slow refetch delivers the new version,
    // and it is a NEW element — the publish minted a fresh per-version row id.
    await screen.findByText("edited question", undefined, { timeout: 8000 });
    const editedRow = row("tc_1")!;
    expect(editedRow).not.toBe(preEditRow);

    await waitFor(() => expect(scrolledElements()).toContain(editedRow), { timeout: 8000 });
    expect(editedRow.className).toContain("animate-row-flash");
    // ...and the superseded row was never the one revealed.
    expect(scrolledElements()).not.toContain(preEditRow);
  }, 20000);

  it("retains the target when the post-edit refetch fails, revealing it on recovery", async () => {
    // A failed refetch leaves the pre-edit snapshot on screen. Dropping the target
    // there would spend the reveal on content the user did not just author and
    // leave the edit permanently unannounced; it is held until a version that
    // actually contains the edit loads.
    focusTestCaseId = "tc_1";
    failNextRefetch = true;
    mountDetail();
    await screen.findByText("I was charged twice");
    const preEditRow = row("tc_1")!;

    await editFirstRow();

    // The refetch failed, so the page still shows the pre-edit row — untouched.
    await waitFor(() => expect(failNextRefetch).toBe(false));
    expect(row("tc_1")).toBe(preEditRow);
    expect(scrolledElements()).not.toContain(preEditRow);
    expect(preEditRow.className).not.toContain("animate-row-flash");

    // The next successful fetch still reveals it: the target was retained.
    window.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("edited question", undefined, { timeout: 8000 });
    const editedRow = row("tc_1")!;
    await waitFor(() => expect(scrolledElements()).toContain(editedRow), { timeout: 8000 });
    expect(editedRow.className).toContain("animate-row-flash");
  }, 20000);

  it("still reveals the row when the refetch outlives the flash", async () => {
    // The row does not exist until the refetch of the new version lands. Starting
    // the highlight's expiry at publish time instead would let a refetch slower
    // than the flash (a big dataset — precisely when the row lands off-screen)
    // clear the target before its row ever rendered, and the add would read as
    // the no-op this whole change exists to fix.
    focusTestCaseId = "tc_new";
    refetchDelayMs = 2500; // > ROW_FLASH_MS (2000)
    mountDetail();
    await screen.findByText("I was charged twice");
    await addRow();

    await waitFor(() => expect(row("tc_new")).not.toBeNull(), { timeout: 8000 });
    await waitFor(() => expect(scrolledRowIds()).toContain("tc_new"), { timeout: 8000 });
    expect(row("tc_new")!.className).toContain("animate-row-flash");
  }, 20000);

  it("clears an active search that would have hidden the row", async () => {
    // The table renders every case of the version (no pagination), so the one way
    // a just-published row can be missing from the DOM is the keyword filter.
    focusTestCaseId = "tc_new";
    mountDetail();
    await screen.findByText("I was charged twice");
    const search = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "charged" } });
    expect(row("tc_2")).toBeNull();

    await addRow();

    await waitFor(() => expect(row("tc_new")).not.toBeNull());
    expect(search.value).toBe("");
    await waitFor(() => expect(scrolledRowIds()).toContain("tc_new"));
  });
});
