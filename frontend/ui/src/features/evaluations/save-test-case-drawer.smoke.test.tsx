// @vitest-environment jsdom
/**
 * The "Add to datasets" modal is intentionally minimal: pick an existing dataset,
 * then Input / Output / Metadata. This mounts it against a stubbed trace + datasets
 * and asserts those four sections render and that an edited Output saves as
 * `expected` while the recorded output is retained.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/traces", () => ({
  getTrace: vi.fn(async () => ({
    trace_id: "t1",
    spans: [
      {
        span_id: "root",
        parent_span_id: null,
        name: "support-ticket-triage",
        span_kind: "AGENT",
        input: "I was charged twice",
        output: "billing",
        status: "OK",
        metadata: null,
      },
    ],
  })),
}));

// The span's production output the drawer seeds Output from and, unedited, sends
// back as `expected`. Stable identity (vi.hoisted) so the drawer's re-seed effect
// (keyed on this object) doesn't refire and clobber an in-progress edit — see
// save-test-case-format.smoke.test.tsx.
const spanIO = vi.hoisted(() => ({
  data: {
    // `span_id` must match the selected span: the drawer only seeds from I/O it can
    // prove belongs to that span, otherwise it clears the fields rather than showing
    // a previous span's values (see `spanIOReady` in trace-integration.tsx).
    span_id: "root",
    input: "I was charged twice",
    output: "billing",
    metadata: null,
  },
}));
vi.mock("@/features/traces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces")>();
  return { ...actual, useSpanIO: () => spanIO };
});

// Radix Select renders through a portal and is flaky in jsdom; mock it to a
// native <select>, matching the pattern used in ModelProvidersTab.test.tsx /
// DetectorsTab.test.tsx, so the dataset picker can be driven directly.
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
  SelectEmpty: ({ children }: { children: React.ReactNode }) => (
    <option disabled>{children}</option>
  ),
}));

import { SaveTestCaseDrawer } from "./components/trace-integration";

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ duplicate: false, testCaseId: "tc1", versionId: "v2" }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "ds1", name: "Billing routing", caseCount: 2, versionCount: 1 }],
        meta: { page: 0, limit: 200, total: 1 },
      }),
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  stubFetch();
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("Add to datasets drawer", () => {
  it("renders the four capture sections", async () => {
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    // Header + the four fields (no Selected-span / Source / Capture-reason clutter).
    expect(screen.getByText("Add to datasets")).toBeDefined();
    await screen.findByDisplayValue("I was charged twice");
    expect(screen.getByText("Dataset")).toBeDefined();
    expect(screen.getByText("Input")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Metadata")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The headline behaviour: the Output field IS the expected outcome (edited or
// not). Following the dataset-item model, the raw production output is
// NOT copied onto the case — to see what actually happened, follow the source
// trace/span link. So the payload carries `expected` (+ input/metadata) and
// never a separate `recorded_output`.
//
// Mutation check: sending `recorded_output` in the payload (reviving the
// dropped column) is caught below.
// ---------------------------------------------------------------------------
describe("Save as test case drawer — submit", () => {
  it("submits an edited Output as `expected`, with no separate recorded output", async () => {
    const fetchMock = stubFetch();
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    await screen.findByDisplayValue("I was charged twice");

    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "ds1" } });
    // The span's production output seeds Output at "billing"; correct it.
    fireEvent.change(screen.getByLabelText("Output"), {
      target: { value: "billing (corrected: two charges refunded)" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(url).toBe("/api/projects/p1/datasets/ds1/test-cases");
    const body = JSON.parse(init!.body as string);
    // The edit becomes the expected outcome; nothing is stored as recorded output.
    expect(body.expected).toBe("billing (corrected: two charges refunded)");
    expect(body.recorded_output).toBeUndefined();
  });

  it("submits an unedited Output as `expected`", async () => {
    const fetchMock = stubFetch();
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    await screen.findByDisplayValue("I was charged twice");

    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "ds1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    const body = JSON.parse(init!.body as string);
    expect(body.expected).toBe("billing");
    expect(body.recorded_output).toBeUndefined();
  });
});
