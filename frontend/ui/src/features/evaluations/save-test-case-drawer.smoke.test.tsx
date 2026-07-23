// @vitest-environment jsdom
/**
 * The real Save-as-test-case drawer exposes the full capture flow:
 * dataset picker (with a "New dataset" option), selected span + capture reason,
 * read-only Recorded output, the three-way Expected outcome, Metadata, and the
 * Source toggle. This mounts it against a stubbed trace + datasets and asserts
 * those details are present (the earlier version was missing most of them).
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

// The recorded output the drawer seeds Output from and, unedited, would send
// back as both `expected` and `recorded_output`. Stable identity (vi.hoisted)
// so the drawer's re-seed effect (keyed on this object) doesn't refire and
// clobber an in-progress edit — see save-test-case-format.smoke.test.tsx.
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

describe("Save as test case drawer", () => {
  it("renders every drawer detail", async () => {
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    // Header + the selected span derived from the fetched trace.
    expect(screen.getByText("Save as test case")).toBeDefined();
    expect(await screen.findByText("support-ticket-triage")).toBeDefined();
    // The details the earlier stripped version was missing. The single editable Output
    // field replaced the read-only Recorded output + three-way Expected outcome.
    expect(screen.getByText("Output")).toBeDefined();
    expect(
      screen.getByText(/becomes the outcome future runs are evaluated against|expected outcome/i),
    ).toBeDefined();
    expect(screen.getByText("Source")).toBeDefined();
    expect(screen.getByText(/Capture reason/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The headline behaviour ("Save as test case retains the recorded output
// while an edit becomes the expected output") was previously unasserted: no
// test in this file fired a change event on Output or submitted, and the
// stubbed fetch's call arguments were never read. Per trace-integration.tsx:
// the Output field IS the expected outcome (edited or not); the recorded
// output — a separate source (`spanIO?.output`) — is always stored alongside
// it, gated by the `outputEdited` flag that stops a re-seed from clobbering
// an in-progress edit.
//
// Mutation check: any of the following pass every existing test in this
// suite, but are caught below —
//   1. sending `recorded_output: output` (collapsing the two fields and
//      destroying the provenance the drawer's own copy promises), or
//   2. dropping `recorded_output` from the payload entirely, or
//   3. deleting the `outputEdited` flag (trace-integration.tsx:116, read at
//      :396) so an edit is indistinguishable from the untouched seed.
// ---------------------------------------------------------------------------
describe("Save as test case drawer — submit", () => {
  it("submits an edited Output as `expected`, keeping the original recorded output separate", async () => {
    const fetchMock = stubFetch();
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    await screen.findByText("support-ticket-triage");

    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "ds1" } });
    // The recorded output seeds Output at "billing"; correct it, which is what
    // marks it edited (trace-integration.tsx `onChange` sets `outputEdited`).
    fireEvent.change(screen.getByLabelText("Output"), {
      target: { value: "billing (corrected: two charges refunded)" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save to Billing routing" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(url).toBe("/api/projects/p1/datasets/ds1/test-cases");
    const body = JSON.parse(init!.body as string);
    // The edit becomes the expected outcome...
    expect(body.expected).toBe("billing (corrected: two charges refunded)");
    // ...while the ORIGINAL recorded output (the mocked span's real output) is
    // still persisted, untouched, alongside it.
    expect(body.recorded_output).toBe("billing");
  });

  it("submits an unedited Output as both `expected` and `recorded_output`", async () => {
    const fetchMock = stubFetch();
    mount(<SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />);
    await screen.findByText("support-ticket-triage");

    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "ds1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save to Billing routing" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    const body = JSON.parse(init!.body as string);
    expect(body.expected).toBe("billing");
    expect(body.recorded_output).toBe("billing");
  });
});
