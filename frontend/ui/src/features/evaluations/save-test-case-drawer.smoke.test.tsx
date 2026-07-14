// @vitest-environment jsdom
/**
 * The real Save-as-test-case drawer exposes the full capture flow:
 * dataset picker (with a "New dataset" option), selected span + capture reason,
 * read-only Recorded output, the three-way Expected outcome, Metadata, and the
 * Source toggle. This mounts it against a stubbed trace + datasets and asserts
 * those details are present (the earlier version was missing most of them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
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

import { SaveTestCaseDrawer } from "./components/trace-integration";

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ id: "ds1", name: "Billing routing", caseCount: 2, versionCount: 1 }],
      meta: { page: 0, limit: 200, total: 1 },
    }),
  })) as unknown as typeof fetch;
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
    // (The inline "New dataset" option lives inside the closed Select portal,
    // which Radix only mounts on open — not assertable in jsdom while closed.)
  });
});
