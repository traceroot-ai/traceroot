// @vitest-environment jsdom
/**
 * View-mount ("e2e") smoke for the real, server-backed Dataset detail page.
 * The route sits behind auth and can't be driven over HTTP without a session,
 * so mounting the view against a stubbed fetch (server-shaped payloads) is how
 * the browser path is checked — same harness as evaluations.smoke.test.tsx.
 *
 * It drives the surfaces the list-level smoke never reaches: the version
 * selector (current vs. an older read-only snapshot), the keyword filter, the
 * slide-in case panel (details / runs / edit + save), the review drawer, the
 * pull-code drawer, and the Evaluation history tab.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

/** Mutable so a test can exercise the ?case=<id> deep link. */
let searchParams = new URLSearchParams();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", datasetId: "ds1" }),
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/projects/p1/datasets/ds1",
}));
// ProjectBreadcrumb pulls layout/workspace context we don't mount here.
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
// react-resizable-panels needs a real ResizeObserver (absent in jsdom); the panel
// split is pure layout, so stub it to plain divs like the trace-viewer tests do.
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-assistant" />,
}));

import { DatasetDetailView } from "./views/dataset-detail-view";
import { caseDisplayId } from "@/features/offline-eval/utils";

// ---------------------------------------------------------------------------
// Server-shaped fixtures
// ---------------------------------------------------------------------------

const DATASET = {
  id: "ds1",
  projectId: "p1",
  name: "Billing routing",
  description: "Routing tickets",
  currentVersionId: "dv2",
  createTime: "2026-07-16T00:00:00Z",
  updateTime: "2026-07-17T00:00:00Z",
  caseCount: 3,
  versionCount: 2,
};

const V1 = {
  id: "dv1",
  datasetId: "ds1",
  projectId: "p1",
  versionNumber: 1,
  label: "seed",
  note: null,
  createdBy: null,
  createTime: "2026-07-16T00:00:00Z",
};
const V2 = { ...V1, id: "dv2", versionNumber: 2, label: "v2", createTime: "2026-07-17T00:00:00Z" };
const V3 = { ...V1, id: "dv3", versionNumber: 3, label: null, createTime: "2026-07-17T12:00:00Z" };

function testCase(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    testCaseId: "tc_1",
    datasetVersionId: "dv2",
    datasetId: "ds1",
    projectId: "p1",
    input: "I was charged twice for my July invoice",
    expected: "billing",
    metadata: null,
    review: "needs_review",
    captureReason: "manual",
    sourceTraceId: null,
    sourceSpanId: null,
    sourceSpanName: null,
    sourceSpanKind: null,
    addedBy: null,
    createTime: "2026-07-17T10:24:00Z",
    ...over,
  };
}

const CASES = [
  testCase(),
  testCase({
    id: "row-2",
    testCaseId: "tc_2",
    input: "Reset my password please",
    expected: "account-management",
    // Exercises the metadata preview + a real source span.
    metadata: { channel: "email", priority: "high" },
    review: "ready",
    captureReason: "detector",
    sourceTraceId: "tr_9",
    sourceSpanId: "sp_9",
    sourceSpanName: "handle_ticket",
    sourceSpanKind: "AGENT",
  }),
  testCase({
    id: "row-3",
    testCaseId: "tc_3",
    // Empty input + null expected exercise the "-" placeholders.
    input: "",
    expected: null,
    createTime: "2026-07-17T11:00:00Z",
  }),
];

const RUN = {
  id: "run1",
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv2",
  runNumber: 27,
  candidateVersion: "git:4a91c02",
  environment: "ci",
  status: "completed",
  baselineRunId: null,
  caseCount: 3,
  scoredCount: 3,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  passedCount: 3,
  failedCount: 0,
  erroredCount: 0,
  notScoredCount: 0,
  scorers: [{ name: "routing-accuracy", version: "v3" }],
  model: null,
  metadata: null,
  startedAt: "2026-07-17T10:24:00Z",
  completedAt: "2026-07-17T10:30:00Z",
  evaluationName: "Billing routing nightly",
  datasetName: "Billing routing",
  datasetVersionLabel: "v2",
  changeFromBaseline: null,
  errorCount: 0,
  baselineComparable: false,
  elapsedMs: 360000,
  cost: 0.42,
};

const CASE_RUNS = [
  {
    resultId: "res1",
    runId: "run1",
    runNumber: 27,
    candidateVersion: "git:4a91c02",
    evaluationName: "Billing routing nightly",
    datasetVersionId: "dv2",
    ranAt: "2026-07-17T10:24:00Z",
    score: 1,
    status: "passed",
    change: "improved",
    caseCount: 3,
    cost: 0.42,
    elapsedMs: 360000,
  },
];

/** Records every request so tests can assert what was persisted. */
let requests: Array<{ url: string; method: string; body: unknown }> = [];

function detail(versionId: string | null) {
  const older = versionId === "dv1";
  return {
    dataset: DATASET,
    currentVersion: V2,
    selectedVersion: older ? V1 : V2,
    isCurrentVersion: !older,
    // The older snapshot holds a single, pre-edit case.
    testCases: older
      ? [testCase({ id: "old-1", datasetVersionId: "dv1", input: "seeded ticket" })]
      : CASES,
    versions: [V2, V1],
  };
}

function payloadFor(url: string): unknown {
  if (url.includes("/test-cases/") && url.endsWith("/runs")) return { data: CASE_RUNS };
  if (url.includes("/test-cases")) {
    return { duplicate: false, testCaseId: "tc_new", versionId: "dv3" };
  }
  if (url.includes("/evaluations/runs")) {
    return { data: [RUN], meta: { page: 0, limit: 50, total: 1 } };
  }
  if (url.includes("/datasets/ds1")) {
    const versionId = new URL(url, "http://x").searchParams.get("version_id");
    return detail(versionId);
  }
  return {};
}

beforeAll(() => {
  // jsdom lacks these; Radix Select/Dialog call them on pointer handling + focus.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.open = vi.fn();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

beforeEach(() => {
  searchParams = new URLSearchParams();
  requests = [];
  mockPush.mockClear();
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      json: async () => payloadFor(String(url)),
    };
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

function mountDetail() {
  return mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
}

/**
 * Opens the slide-in panel for a case by clicking its Input cell. "Copy ID" is
 * the panel's unique anchor ("Row" also labels the add-row button).
 */
async function openCase(text: string | RegExp) {
  fireEvent.click((await screen.findAllByText(text))[0]);
  return screen.findByTitle("Copy ID");
}

describe("Dataset detail view renders server data", () => {
  it("shows every test case of the current version", async () => {
    // The dataset name + id live in the top breadcrumb bar (ProjectBreadcrumb),
    // which this harness mocks out; here we assert the rows themselves.
    mountDetail();
    expect(await screen.findByText(/charged twice/)).toBeDefined();
    expect(screen.getByText("Reset my password please")).toBeDefined();
    // The metadata preview renders the flat key: value join.
    expect(screen.getByText(/channel: email/)).toBeDefined();
  });

  it("renders a loading state before the dataset resolves", () => {
    mountDetail();
    expect(screen.getByText("Loading dataset...")).toBeDefined();
  });

  it("shows a not-found state when the dataset request fails", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    })) as unknown as typeof fetch;
    mountDetail();
    expect(await screen.findByText("Dataset not found")).toBeDefined();
    expect(screen.getByText(/No dataset with the id/)).toBeDefined();
    expect(screen.getByText("Back to datasets")).toBeDefined();
  });
});

describe("Dataset detail — versions", () => {
  it("switching to an older version loads its snapshot read-only", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);

    fireEvent.click(screen.getByRole("combobox"));
    // Each option pairs the version number with its id (the snowflake, now stored as
    // `v.id`); pick v1 by its id, which also asserts the id is rendered.
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(V1.id) }));

    // The older snapshot's content loads (no read-only banner — that was removed).
    expect(await screen.findByText("seeded ticket")).toBeDefined();
    // Editing branches from the current version, so adding a row is disabled here.
    expect(screen.getByRole("button", { name: /Row/ }).hasAttribute("disabled")).toBe(true);
    // The request carried the requested snapshot.
    expect(requests.some((r) => r.url.includes("version_id=dv1"))).toBe(true);
  });
});

describe("Dataset detail — filtering and adding rows", () => {
  it("the keyword filter matches input and expected, and shows a no-match empty state", async () => {
    mountDetail();
    const search = await screen.findByPlaceholderText("Search...");

    fireEvent.change(search, { target: { value: "password" } });
    expect(screen.queryByText(/charged twice/)).toBeNull();
    expect(screen.getByText("Reset my password please")).toBeDefined();

    // Matching on the expected column, not the input.
    fireEvent.change(search, { target: { value: "account-management" } });
    expect(screen.getByText("Reset my password please")).toBeDefined();

    fireEvent.change(search, { target: { value: "nothing matches this" } });
    expect(await screen.findByText("No cases match your search.")).toBeDefined();
  });

  it("shows the empty-dataset guidance when a version has no cases", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => {
        const s = String(url);
        if (s.includes("/evaluations/runs")) {
          return { data: [], meta: { page: 0, limit: 50, total: 0 } };
        }
        return { ...detail(null), testCases: [] };
      },
    })) as unknown as typeof fetch;
    mountDetail();
    expect(await screen.findByText(/To populate this dataset/)).toBeDefined();
  });

  it("Row opens the editor and POSTs the authored row", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: "Row" }));
    // Opens the editor rather than inserting a blank row.
    expect(await screen.findByText("New Row")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Input"), { target: { value: "a new question" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Row added")).toBeDefined();
    const post = requests.find((r) => r.method === "POST" && r.url.includes("/test-cases"));
    expect(post?.body).toMatchObject({ input: "a new question", expected: null, metadata: null });
  });

  it("the row action menu edits a row (PATCH)", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
    fireEvent.click(await screen.findByText("Edit"));
    // Seeded from the row.
    expect(await screen.findByText("Edit Row")).toBeDefined();
    const input = screen.getByLabelText("Input") as HTMLTextAreaElement;
    expect(input.value).toContain("charged twice");
    fireEvent.change(input, { target: { value: "edited question" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Row saved/)).toBeDefined();
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toContain("/datasets/ds1/test-cases/tc_1");
    expect(patch?.body).toMatchObject({ input: "edited question" });
  });

  it("the row action menu deletes a row (DELETE) after confirming", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
    fireEvent.click(await screen.findByText("Delete"));
    // Confirmation first — nothing is deleted until the dialog's Delete is clicked.
    await screen.findByText("Delete row");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    expect(await screen.findByText("Row deleted")).toBeDefined();
    expect(requests.some((r) => r.method === "DELETE" && r.url.includes("/test-cases/tc_1"))).toBe(
      true,
    );
  });
});

/**
 * A dataset where DELETE behaves the way the server actually behaves: it
 * publishes a NEW version (dv3) with the case dropped and repoints
 * `currentVersionId` at it, leaving dv2 behind as a still-readable snapshot that
 * keeps the deleted row. Modelling the repoint is what makes a pinned selection
 * observably stale.
 */
function mockDeletePublishesNewVersion() {
  let currentVersionId = "dv2";
  const casesOf = (versionId: string) => {
    if (versionId === "dv1") {
      return [testCase({ id: "old-1", datasetVersionId: "dv1", input: "seeded ticket" })];
    }
    if (versionId === "dv3") return CASES.filter((c) => c.testCaseId !== "tc_1");
    return CASES;
  };
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? "GET";
    requests.push({ url: s, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "DELETE") {
      currentVersionId = "dv3";
      return { ok: true, status: 201, json: async () => ({ versionId: "dv3", versionNumber: 3 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (s.includes("/evaluations/runs")) {
          return { data: [], meta: { page: 0, limit: 50, total: 0 } };
        }
        if (s.includes("/test-cases/") && s.endsWith("/runs")) return { data: [] };
        if (!/\/datasets\/ds1(\?|$)/.test(s)) return {};
        const versions = currentVersionId === "dv3" ? [V3, V2, V1] : [V2, V1];
        const requested = new URL(s, "http://x").searchParams.get("version_id");
        // An unknown or omitted id falls back to the current version — route.ts.
        const selected =
          versions.find((v) => v.id === requested) ??
          versions.find((v) => v.id === currentVersionId)!;
        return {
          dataset: { ...DATASET, currentVersionId },
          currentVersion: versions.find((v) => v.id === currentVersionId),
          selectedVersion: selected,
          isCurrentVersion: selected.id === currentVersionId,
          testCases: casesOf(selected.id),
          versions,
        };
      },
    };
  }) as unknown as typeof fetch;
}

/** The dataset-detail GETs, excluding the nested /test-cases requests. */
function detailGets() {
  return requests.filter((r) => r.method === "GET" && /\/datasets\/ds1(\?|$)/.test(r.url));
}

describe("Dataset detail — deleting a row with a version pinned", () => {
  it("follows the delete onto the version it published instead of the pinned snapshot", async () => {
    mockDeletePublishesNewVersion();
    mountDetail();
    await screen.findByText(/charged twice/);

    // Pin the selection to a concrete id the way a user reaches that state: pick a
    // version from the dropdown. Round-tripping back to the current version leaves
    // the page fully editable but pinned — indistinguishable on screen from the
    // unpinned default, and the state the regression turns on.
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(V1.id) }));
    await screen.findByText("seeded ticket");
    // An older snapshot is read-only, so a delete is not even reachable from here.
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
    expect(screen.queryAllByLabelText("Row actions")).toHaveLength(0);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(V2.id) }));
    await screen.findByText(/charged twice/);
    // Pinned, yet still the current version — the Actions column proves it.
    expect(await screen.findByRole("columnheader", { name: "Actions" })).toBeDefined();

    fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    expect(await screen.findByText("Row deleted")).toBeDefined();

    // The deleted row is gone and the page is still editable. Without the reset the
    // pinned dv2 snapshot is re-fetched: the row stays and, because dv2 is no longer
    // current, the Actions column disappears — a silently stale view.
    await waitFor(() => expect(screen.queryByText(/charged twice/)).toBeNull());
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeDefined();
    // The refetch asked for the current version, not the pinned one.
    expect(detailGets().at(-1)!.url).not.toContain("version_id");
  });

  it("add-then-delete still lands on the newest version", async () => {
    mockDeletePublishesNewVersion();
    mountDetail();
    await screen.findByText(/charged twice/);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(V1.id) }));
    await screen.findByText("seeded ticket");
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(V2.id) }));
    await screen.findByText(/charged twice/);

    // The add un-pins the selection on its own (`onSaved`)...
    fireEvent.click(screen.getByRole("button", { name: "Row" }));
    fireEvent.change(await screen.findByLabelText("Input"), {
      target: { value: "a new question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Row added");
    expect(detailGets().at(-1)!.url).not.toContain("version_id");

    // ...and the following delete keeps it there.
    fireEvent.click((await screen.findAllByLabelText("Row actions"))[0]);
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await screen.findByText("Row deleted");
    await waitFor(() => expect(screen.queryByText(/charged twice/)).toBeNull());
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeDefined();
    expect(detailGets().at(-1)!.url).not.toContain("version_id");
  });
});

describe("Dataset detail — the slide-in case panel", () => {
  it("opens a case read-only, rendering its content like the trace-detail panel", async () => {
    mountDetail();
    await openCase("Reset my password please");
    const dialog = screen.getByRole("dialog");
    // Read-only view (in-panel editing is deferred): no editable textareas, and
    // the Input/Expected/Metadata sections render the case's content directly.
    expect(screen.queryByLabelText("Input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(dialog).getAllByText(/Reset my password please/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/account-management/).length).toBeGreaterThan(0);
    // The Metadata section shows the case's metadata.
    expect(within(dialog).getAllByText(/channel/).length).toBeGreaterThan(0);
    // No separate "what happened in production" block — the source span link
    // preserves the actual output (the dataset-item model).
    expect(screen.queryByLabelText("What happened in production")).toBeNull();
  });

  it("navigates between cases with the up/down controls", async () => {
    mountDetail();
    await openCase(/charged twice/);
    // First row: up is disabled, down moves to the second case.
    expect(screen.getByTitle("Previous row").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTitle("Next row"));
    expect(await screen.findByText(caseDisplayId("tc_2"))).toBeDefined();
    fireEvent.click(screen.getByTitle("Previous row"));
    expect(await screen.findByText(caseDisplayId("tc_1"))).toBeDefined();
  });

  it("expands to full screen and opens the row in a new tab", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByTitle("Expand to full screen"));
    fireEvent.click(await screen.findByTitle("Restore default size"));
    fireEvent.click(screen.getByTitle("Open in new tab"));
    expect(window.open).toHaveBeenCalledWith("/projects/p1/datasets/ds1", "_blank");
  });

  it("the Evaluations view lists every evaluation run that measured the case", async () => {
    mountDetail();
    await openCase(/charged twice/);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /Evaluations/ }));
    expect(await screen.findByText("Billing routing nightly")).toBeDefined();
    // Run Name column: candidate version + run number.
    expect(screen.getByText("git:4a91c02")).toBeDefined();
    expect(screen.getByText("#27")).toBeDefined();
    // Clicking a run navigates to its detail.
    fireEvent.click(screen.getByText("Billing routing nightly"));
    expect(mockPush).toHaveBeenCalledWith("/projects/p1/evaluations/run1");
    // Back to the Row tab — the read-only view shows the Input section. Scoped to
    // the dialog since "Row" also names the toolbar's "+ Row" button.
    fireEvent.click(within(dialog).getByRole("button", { name: "Row" }));
    expect(await within(dialog).findByText("Input")).toBeDefined();
  });

  it("shows an empty Evaluations state when nothing has measured the case", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => {
        const s = String(url);
        if (s.includes("/test-cases/") && s.endsWith("/runs")) return { data: [] };
        if (s.includes("/evaluations/runs")) {
          return { data: [], meta: { page: 0, limit: 50, total: 0 } };
        }
        return detail(null);
      },
    })) as unknown as typeof fetch;
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: /Evaluations/ }));
    expect(await screen.findByText(/No evaluation has measured this test case yet/)).toBeDefined();
  });

  // In-panel editing (Edit → line-numbered fields → Save/PATCH) is deferred;
  // its tests will return with the feature.

  it("closes the panel", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTitle("Copy ID")).toBeNull());
  });
});

describe("Dataset detail — deep link", () => {
  it("?case=<testCaseId> opens that case's panel on load", async () => {
    searchParams = new URLSearchParams("case=tc_2");
    mountDetail();
    // The panel opens on the matching stable testCaseId, not the per-version row id.
    expect(await screen.findByTitle("Copy ID")).toBeDefined();
    expect(await screen.findByText(caseDisplayId("tc_2"))).toBeDefined();
  });
  it("ignores a ?case that no row matches", async () => {
    searchParams = new URLSearchParams("case=tc_missing");
    mountDetail();
    await screen.findByText(/charged twice/);
    expect(screen.queryByTitle("Copy ID")).toBeNull();
  });
});
