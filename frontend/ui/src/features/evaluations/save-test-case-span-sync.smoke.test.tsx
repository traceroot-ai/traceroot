// @vitest-environment jsdom
/**
 * While the Save-as-test-case drawer is open, clicking a different span in the
 * trace tree retargets the drawer to that span. The page keeps `spanId` in sync
 * with the tree selection (via TraceViewerPanel's onSelectionChange); the drawer
 * follows that prop, so its "Selected span" updates without reopening.
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
        name: "triage-agent",
        span_kind: "AGENT",
        status: "OK",
        metadata: null,
      },
      {
        span_id: "llm",
        parent_span_id: "root",
        name: "anthropic.messages",
        span_kind: "LLM",
        status: "OK",
        metadata: null,
      },
    ],
  })),
}));

// Distinct I/O per span, so the "Selected span" swap is observable.
vi.mock("@/features/traces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces")>();
  return {
    ...actual,
    useSpanIO: (_p: string, _t: string, spanId: string | null) => ({
      data:
        spanId === "llm"
          ? { input: "llm-input", metadata: null }
          : { input: "root-input", metadata: null },
    }),
  };
});

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

function renderDrawer(spanId: string | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SaveTestCaseDrawer
        projectId="p1"
        traceId="t1"
        spanId={spanId}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("drawer follows the tree selection", () => {
  it("retargets the selected span when the spanId prop changes while open", async () => {
    const { rerender } = renderDrawer("root");
    expect(await screen.findByText("triage-agent")).toBeDefined();

    // Simulate a click on the LLM span in the tree (page pushes the new spanId).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <SaveTestCaseDrawer projectId="p1" traceId="t1" spanId="llm" open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("anthropic.messages")).toBeDefined();
    expect(screen.queryByText("triage-agent")).toBeNull();
  });
});
