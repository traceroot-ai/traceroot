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

function testCase(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    testCaseId: "tc_1",
    datasetVersionId: "dv2",
    datasetId: "ds1",
    projectId: "p1",
    input: "I was charged twice for my July invoice",
    expected: "billing",
    recordedOutput: null,
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
    // Exercises the metadata preview + the recorded-output block + a real source span.
    metadata: { channel: "email", priority: "high" },
    recordedOutput: "escalation",
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
  mainScore: 0.938,
  mainScoreName: "Routing accuracy",
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
    ranAt: "2026-07-17T10:24:00Z",
    score: 1,
    status: "passed",
    change: "improved",
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
  it("shows the dataset name, its id, and every test case of the current version", async () => {
    mountDetail();
    expect(await screen.findByText("Billing routing")).toBeDefined();
    expect(screen.getAllByText("ds1").length).toBeGreaterThan(0);
    expect(screen.getByText(/charged twice/)).toBeDefined();
    expect(screen.getByText("Reset my password please")).toBeDefined();
    // The metadata preview renders the flat key: value join.
    expect(screen.getByText(/channel: email/)).toBeDefined();
    // Tab counts come from the loaded data.
    expect(screen.getByRole("tab", { name: /Test cases/ }).textContent).toContain("3");
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
    // The current version is preselected and its immutable id is shown.
    expect(screen.getAllByText("dv2").length).toBeGreaterThan(0);
    expect(screen.queryByText(/— read only/)).toBeNull();

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /v1/ }));

    // The banner names the version being viewed, not just "an older version".
    expect(await screen.findByText(/Viewing v1.*— read only/)).toBeDefined();
    expect(await screen.findByText("seeded ticket")).toBeDefined();
    // Editing branches from the current version, so adding a row is disabled here.
    expect(screen.getByRole("button", { name: /Row/ }).hasAttribute("disabled")).toBe(true);
    // The request carried the requested snapshot.
    expect(requests.some((r) => r.url.includes("version_id=dv1"))).toBe(true);
  });

  it("copies the selected version id", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click(screen.getByTitle("Copy version ID"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("dv2"));
  });
});

describe("Dataset detail — filtering and adding rows", () => {
  it("the keyword filter matches input and expected, and shows a no-match empty state", async () => {
    mountDetail();
    const search = await screen.findByPlaceholderText("Search cases...");

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
    expect(await screen.findByText(/No test cases yet/)).toBeDefined();
  });

  it("Row posts an empty, needs-review test case and toasts", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: /Row/ }));
    expect(await screen.findByText("Empty row added")).toBeDefined();
    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ input: "", review: "needs_review", capture_reason: "manual" });
  });
});

describe("Dataset detail — the slide-in case panel", () => {
  it("opens a case, shows its identity, source, and capture reason", async () => {
    mountDetail();
    await openCase("Reset my password please");
    // The opened row carries a real source span and a detector capture reason.
    expect(screen.getByText("handle_ticket")).toBeDefined();
    expect(screen.getByText("Captured:")).toBeDefined();
    // Editable value blocks are seeded from the case, each addressed by its label.
    expect((screen.getByLabelText("Input") as HTMLTextAreaElement).value).toContain(
      "Reset my password please",
    );
    expect((screen.getByLabelText("Expected") as HTMLTextAreaElement).value).toContain(
      "account-management",
    );
    // The recorded production output is a separate, read-only block.
    const recorded = screen.getByLabelText("What happened in production") as HTMLTextAreaElement;
    expect(recorded.value).toContain("escalation");
    expect(recorded.readOnly).toBe(true);
    expect((screen.getByLabelText("Metadata") as HTMLTextAreaElement).value).toContain("channel");
  });

  it("a manually added case shows the manual source chip", async () => {
    mountDetail();
    await openCase(/charged twice/);
    expect(screen.getByText("Added manually")).toBeDefined();
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

  it("the Runs view lists every evaluation run that measured the case", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(await screen.findByText("Billing routing nightly")).toBeDefined();
    expect(screen.getByText(/Run #27 ·/)).toBeDefined();
    // Clicking a run navigates to its detail.
    fireEvent.click(screen.getByText("Billing routing nightly"));
    expect(mockPush).toHaveBeenCalledWith("/projects/p1/evaluations/run1");
    // Back to Details.
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(await screen.findByLabelText("Input")).toBeDefined();
  });

  it("shows an empty Runs state when nothing has measured the case", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(
      await screen.findByText(/No evaluation run has measured this test case yet/),
    ).toBeDefined();
  });

  it("editing a field reveals Save, which PATCHes and publishes a new version", async () => {
    mountDetail();
    await openCase(/charged twice/);
    // Nothing is dirty yet.
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Input"), { target: { value: "edited input" } });
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "" } });

    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Saved — new dataset version published/)).toBeDefined();

    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toContain("/datasets/ds1/test-cases/tc_1");
    // A cleared Expected persists as null, never as "".
    expect(patch?.body).toEqual({ input: "edited input", expected: null });
  });

  it("only persists metadata once it parses back to an object", async () => {
    mountDetail();
    await openCase("Reset my password please");
    const metadataBox = screen.getByLabelText("Metadata");

    // Half-typed JSON leaves the stored metadata untouched — the patch is empty,
    // so nothing is sent at all rather than blowing the value away.
    fireEvent.change(metadataBox, { target: { value: "{ not json" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);

    // ...and valid JSON is sent through.
    fireEvent.change(metadataBox, { target: { value: '{"channel":"chat"}' } });
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        requests
          .filter((r) => r.method === "PATCH")
          .some((r) => {
            const body = r.body as { metadata?: Record<string, unknown> };
            return body.metadata?.channel === "chat";
          }),
      ).toBe(true),
    );
  });

  it("closes the panel", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTitle("Copy ID")).toBeNull());
  });
});

describe("Dataset detail — review drawer", () => {
  it("Mark ready PATCHes the review and toasts", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    const drawer = await screen.findByText("Review test case");
    expect(drawer).toBeDefined();
    // The drawer names the case it is reviewing.
    expect(screen.getByText(`${caseDisplayId("tc_1")} · Billing routing`)).toBeDefined();

    // "Mark ready" is gated on every verification check.
    screen.getAllByRole("checkbox").forEach((b) => fireEvent.click(b));

    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ review: "ready" });
    expect(await screen.findByText(/Review saved — new dataset version published/)).toBeDefined();
  });

  it("a corrected expected outcome is sent alongside the review", async () => {
    mountDetail();
    await openCase(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.change(await screen.findByLabelText(/Correct the expected outcome/), {
      target: { value: "  refunds  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Needs work" }));
    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      review: "needs_review",
      expected: "refunds",
    });
  });

  it("a case with no expected outcome says a scorer judges the output", async () => {
    mountDetail();
    // Row 3 has a null expected; its Input cell renders as "-", so open by created time.
    await openCase(/charged twice/);
    fireEvent.click(screen.getByTitle("Next row"));
    fireEvent.click(screen.getByTitle("Next row"));
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(
      await screen.findByText(/Not required — a scorer judges the output directly/),
    ).toBeDefined();
  });
});

describe("Dataset detail — pull code", () => {
  it("opens the drawer with the dataset's real id in both languages", async () => {
    mountDetail();
    await screen.findByText(/charged twice/);
    fireEvent.click(screen.getByRole("button", { name: /Pull code/ }));

    const drawer = await screen.findByText("Pull this dataset in code");
    const panel = drawer.closest("div.fixed") as HTMLElement;
    // The Python snippet pulls this dataset by its real id.
    expect(panel.textContent).toContain('pull_dataset("ds1")');

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    await waitFor(() => expect(panel.textContent).toContain('await pullDataset("ds1")'));
    expect(panel.textContent).not.toContain("pull_dataset");
  });
});

describe("Dataset detail — evaluation history tab", () => {
  it("lists the runs against this dataset and opens one", async () => {
    mountDetail();
    fireEvent.click(await screen.findByRole("tab", { name: /Evaluation history/ }));
    expect(await screen.findByText("Billing routing nightly")).toBeDefined();
    expect(screen.getByText(/Run #27 ·/)).toBeDefined();
    fireEvent.click(screen.getByText("Billing routing nightly"));
    expect(mockPush).toHaveBeenCalledWith("/projects/p1/evaluations/run1");
  });

  it("filters the history and falls back to a search-specific empty state", async () => {
    mountDetail();
    fireEvent.click(await screen.findByRole("tab", { name: /Evaluation history/ }));
    const search = await screen.findByPlaceholderText("Search evaluations...");
    fireEvent.change(search, { target: { value: "nightly" } });
    expect(screen.getByText("Billing routing nightly")).toBeDefined();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No evaluations match your search.")).toBeDefined();
  });

  it("names the dataset when nothing has been run against it", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => {
        const s = String(url);
        if (s.includes("/evaluations/runs")) {
          return { data: [], meta: { page: 0, limit: 50, total: 0 } };
        }
        return detail(null);
      },
    })) as unknown as typeof fetch;
    mountDetail();
    fireEvent.click(await screen.findByRole("tab", { name: /Evaluation history/ }));
    expect(
      await screen.findByText(/Nothing has been run against Billing routing yet/),
    ).toBeDefined();
  });
});

describe("Dataset detail — deep link", () => {
  it("?case=<testCaseId> opens that case's panel on load", async () => {
    searchParams = new URLSearchParams("case=tc_2");
    mountDetail();
    // The panel opens on the matching stable testCaseId, not the per-version row id.
    expect(await screen.findByTitle("Copy ID")).toBeDefined();
    expect(await screen.findByText(caseDisplayId("tc_2"))).toBeDefined();
    expect(screen.getByText("handle_ticket")).toBeDefined();
  });

  it("ignores a ?case that no row matches", async () => {
    searchParams = new URLSearchParams("case=tc_missing");
    mountDetail();
    await screen.findByText(/charged twice/);
    expect(screen.queryByTitle("Copy ID")).toBeNull();
  });
});

describe("Dataset detail — tabs behave as an ARIA tablist", () => {
  it("arrow keys move between the two tabs", async () => {
    mountDetail();
    const cases = await screen.findByRole("tab", { name: /Test cases/ });
    const list = screen.getByRole("tablist");
    cases.focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(
      screen.getByRole("tab", { name: /Evaluation history/ }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "Home" });
    expect(screen.getByRole("tab", { name: /Test cases/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // A key the tablist doesn't own is ignored.
    fireEvent.keyDown(list, { key: "a" });
    expect(within(list).getAllByRole("tab").length).toBe(2);
  });
});
