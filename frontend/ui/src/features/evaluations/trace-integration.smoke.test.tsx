// @vitest-environment jsdom
/**
 * The parts of the trace ↔ evaluation integration the existing Save-as-test-case
 * smokes don't reach: the capture drawer's full save round trip (pick or create a
 * dataset, walk spans, detach the source, duplicate + failure handling) and the
 * two read-only trace-viewer chips — "Evaluation:" for a trace an evaluation run
 * produced, and "Dataset:" for a span already saved as a test case.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/traces",
}));

// A two-span trace so the up/down span walk has somewhere to go. The child is a
// failed TOOL span, which is what makes the capture reason "failed_tool".
vi.mock("@/lib/api/traces", () => ({
  getTrace: vi.fn(async () => ({
    trace_id: "t1",
    spans: [
      {
        span_id: "root",
        parent_span_id: null,
        name: "support-ticket-triage",
        span_kind: "AGENT",
        status: "OK",
        metadata: null,
      },
      {
        span_id: "child",
        parent_span_id: "root",
        name: "lookup_invoice",
        span_kind: "TOOL",
        status: "ERROR",
        metadata: null,
      },
    ],
  })),
}));

// Captured span I/O. Metadata is absent here; a span whose metadata is not a JSON
// object now blocks the save outright rather than being silently dropped, which is
// covered on its own below.
const spanIO = vi.hoisted(() => ({
  data: {
    input: "I was charged twice for my July invoice",
    output: "billing",
    metadata: null as string | null,
  },
}));
vi.mock("@/features/traces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces")>();
  // The drawer only treats I/O as ready once it belongs to the selected span, so
  // the stub has to echo back the span it was asked for — a fixed payload would
  // read as "still loading" forever and never enable Save. Results are cached per
  // span so each render returns the same object, as a real query would; a fresh
  // one each time re-fires the seeding effect and loops.
  const cache = new Map<string, { data: unknown }>();
  return {
    ...actual,
    useSpanIO: (_projectId: string, traceId: string, spanId: string | null) => {
      if (!spanId) return { data: undefined };
      // Key on the payload too, so a test that varies the fixture is not served a
      // stale entry from an earlier one.
      const key = `${spanId}|${JSON.stringify(spanIO.data)}`;
      if (!cache.has(key)) {
        cache.set(key, { data: { ...spanIO.data, span_id: spanId, trace_id: traceId } });
      }
      return cache.get(key)!;
    },
  };
});
// Radix Select renders through a portal and is flaky in jsdom; mock it to a
// native <select>, matching save-test-case-drawer.smoke.test.tsx, so the dataset
// picker can be driven directly.
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
    <select aria-label="Dataset" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { id: "p1", name: "support-bot" } }),
}));

import {
  SaveTestCaseDrawer,
  TraceEvaluationChip,
  SpanDatasetChip,
} from "./components/trace-integration";

const DATASETS = [{ id: "ds1", name: "Billing routing", caseCount: 2, versionCount: 1 }];

let requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
/** Toggled per-test to drive the duplicate / failure branches of the save. */
let saveResponse: { duplicate: boolean } = { duplicate: false };
let saveFails = false;

/** Evaluation results a trace produced; empty means the chip renders nothing. */
let evaluationResults: unknown[] = [];
/** Dataset test cases captured from the trace, keyed by source span. */
let traceTestCases: unknown[] = [];

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  requests = [];
  saveResponse = { duplicate: false };
  saveFails = false;
  evaluationResults = [];
  traceTestCases = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? "GET";
    requests.push({
      url: s,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (s.endsWith("/test-cases") && method === "POST") {
      if (saveFails) return { ok: false, status: 500, json: async () => ({ error: "nope" }) };
      return { ok: true, status: 200, json: async () => saveResponse };
    }
    if (s.includes("/evaluation-results")) {
      return { ok: true, status: 200, json: async () => ({ data: evaluationResults }) };
    }
    if (s.endsWith("/test-cases") || s.includes("/traces/")) {
      return { ok: true, status: 200, json: async () => ({ data: traceTestCases }) };
    }
    if (s.includes("/datasets") && method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ dataset: { id: "ds_new", name: "Refund routing" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: DATASETS, meta: { page: 0, limit: 200, total: 1 } }),
    };
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function mountDrawer(onOpenChange = vi.fn()) {
  mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

/** Picks a dataset by name from the drawer's dataset select. */
async function pickDataset(name: string) {
  const select = screen.getByLabelText("Dataset") as HTMLSelectElement;
  const option = Array.from(select.options).find((o) => o.textContent === name);
  if (!option) throw new Error(`no dataset option named ${name}`);
  fireEvent.change(select, { target: { value: option.value } });
}

function savePayload() {
  return requests.find((r) => r.method === "POST" && r.url.endsWith("/test-cases"))?.body;
}

describe("SaveTestCaseDrawer — save round trip", () => {
  it("renders nothing without a trace id", () => {
    mount(<SaveTestCaseDrawer projectId="p1" traceId={null} open onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Add to datasets")).toBeNull();
  });

  it("cannot save until a dataset is picked, then posts the captured case", async () => {
    const onOpenChange = mountDrawer();
    await screen.findByDisplayValue("I was charged twice for my July invoice");

    // No dataset yet: the button is generic and disabled.
    const before = screen.getByRole("button", { name: "Save" });
    expect(before.hasAttribute("disabled")).toBe(true);

    await pickDataset("Billing routing");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(savePayload()).toBeDefined());
    // Only the three fields the drawer captures — no recorded output, review,
    // capture-reason, or source.
    expect(savePayload()).toMatchObject({
      input: "I was charged twice for my July invoice",
      // Untouched, the Output field is still the expected outcome.
      expected: "billing",
      metadata: null,
    });

    expect(await screen.findByText(/Saved — published as a new dataset version/)).toBeDefined();
    // The drawer closes itself shortly after a successful save.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 2000 });
  });

  it("an edited Output is what future runs are graded against", async () => {
    mountDrawer();
    await screen.findByDisplayValue("I was charged twice for my July invoice");
    fireEvent.change(screen.getByLabelText("Output"), { target: { value: "refunds" } });
    await pickDataset("Billing routing");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePayload()).toBeDefined());
    expect(savePayload()).toMatchObject({ expected: "refunds" });
  });

  it("a duplicate span offers the existing case instead of adding another row", async () => {
    saveResponse = { duplicate: true };
    mountDrawer();
    await screen.findByDisplayValue("I was charged twice for my July invoice");
    await pickDataset("Billing routing");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already a test case in this dataset/)).toBeDefined();
    const link = screen.getByText("Open existing test case").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/projects/p1/datasets/ds1");
    // No success note — nothing was written.
    expect(screen.queryByText(/Saved — published/)).toBeNull();
  });

  it("surfaces a failed save without closing", async () => {
    saveFails = true;
    const onOpenChange = mountDrawer();
    await screen.findByDisplayValue("I was charged twice for my July invoice");
    await pickDataset("Billing routing");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText("Could not save test case.")).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("refuses to save a span whose metadata isn't a JSON object", async () => {
    spanIO.data.metadata = "not json at all";
    try {
      mountDrawer();
      await screen.findByDisplayValue("I was charged twice for my July invoice");
      await pickDataset("Billing routing");
      expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByText(/Metadata isn't valid JSON|Metadata must be a JSON object/),
      ).toBeDefined();
    } finally {
      spanIO.data.metadata = null;
    }
  });

  it("closes from the X, from Cancel, and from Escape", async () => {
    const onOpenChange = mountDrawer();
    await screen.findByDisplayValue("I was charged twice for my July invoice");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Escape is handled on the drawer's own root in the bubble phase, so that a
    // nested Radix layer (the dataset select, a format popover) keeps its own
    // Escape. The event therefore has to originate inside the drawer, not window.
    onOpenChange.mockClear();
    fireEvent.keyDown(screen.getByLabelText("Close"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.keyDown(screen.getByLabelText("Close"), { key: "Enter" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("TraceEvaluationChip", () => {
  it("renders nothing for a trace no evaluation produced", async () => {
    mount(<TraceEvaluationChip projectId="p1" traceId="t1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Evaluation:")).toBeNull();
  });

  it("links to the run that produced the trace", async () => {
    evaluationResults = [
      {
        id: "res1",
        runId: "run1",
        testCaseId: "tc_1",
        traceId: "t1",
        status: "passed",
        scores: [],
        run: {
          id: "run1",
          runNumber: 27,
          candidateVersion: "git:4a91c02",
          datasetId: "ds1",
          datasetVersionId: "dv1",
          evaluation: { id: "eval1", name: "Billing routing nightly" },
          datasetVersion: { label: "v2" },
        },
      },
    ];
    mount(<TraceEvaluationChip projectId="p1" traceId="t1" />);
    expect(await screen.findByText("Billing routing nightly")).toBeDefined();
    expect(screen.getByText(/Run #27 · git:4a91c02/)).toBeDefined();
    const link = screen.getByText("Evaluation:").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/projects/p1/evaluations/run1");
  });
});

describe("SpanDatasetChip", () => {
  const CASE = {
    testCaseId: "tc_1",
    datasetId: "ds1",
    datasetName: "Billing routing",
    sourceSpanId: "root",
    review: "ready",
    datasetVersionLabel: "v12",
    datasetUpdatedAt: "2026-07-17T10:24:00Z",
    caseCount: 8,
  };

  it("renders nothing for a span that isn't a saved case", async () => {
    traceTestCases = [{ ...CASE, sourceSpanId: "other" }];
    mount(<SpanDatasetChip projectId="p1" traceId="t1" spanId="root" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Dataset:")).toBeNull();
  });

  it("marks the span with a chip per dataset it belongs to", async () => {
    traceTestCases = [
      CASE,
      { ...CASE, testCaseId: "tc_2", datasetId: "ds2", datasetName: "Refund routing" },
    ];
    mount(<SpanDatasetChip projectId="p1" traceId="t1" spanId="root" />);
    expect((await screen.findAllByText("Dataset:")).length).toBe(2);
    // The chip is the popover trigger, not the link: the card it opens holds
    // interactive controls, which may not live inside a tooltip. The dataset link
    // sits inside that card.
    const trigger = await screen.findByTitle("In dataset Billing routing");
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    const open = await screen.findByRole("link", { name: /Open/ });
    expect(open.getAttribute("href")).toBe("/projects/p1/datasets/ds1");
  });

  it("the card carries the version, case count, and a copyable SDK snippet", async () => {
    traceTestCases = [CASE];
    mount(<SpanDatasetChip projectId="p1" traceId="t1" spanId="root" />);
    fireEvent.click(await screen.findByTitle("In dataset Billing routing"));

    await screen.findAllByRole("button", { name: "Python" });
    const card = screen
      .getAllByRole("button", { name: "Python" })[0]
      .closest("[data-radix-popper-content-wrapper], [role='dialog']") as HTMLElement;
    expect(card.textContent).toContain("v12");
    expect(card.textContent).toContain("8 cases");
    // The snippet slugifies the dataset name and uses the real project name.
    expect(card.textContent).toContain('traceroot.init_dataset("support-bot"');
    expect(card.textContent).toContain('"dataset": "billing-routing"');

    fireEvent.click(screen.getAllByRole("button", { name: "TypeScript" })[0]);
    await waitFor(() => expect(card.textContent).toContain("traceroot.initDataset"));
    expect(card.textContent).toContain('dataset: "billing-routing"');
  });

  it("a single-case dataset is described in the singular", async () => {
    traceTestCases = [{ ...CASE, caseCount: 1 }];
    mount(<SpanDatasetChip projectId="p1" traceId="t1" spanId="root" />);
    fireEvent.click(await screen.findByTitle("In dataset Billing routing"));
    expect((await screen.findAllByText("1 case")).length).toBeGreaterThan(0);
  });
});
