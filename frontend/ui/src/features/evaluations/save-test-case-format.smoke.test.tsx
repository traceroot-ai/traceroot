// @vitest-environment jsdom
/**
 * Per-field seed formats in the real Save-as-test-case drawer.
 *
 * The mode a captured value opens in is a property of the FIELD, not of however
 * the instrumented app serialised it: Input and Recorded output expand (they are
 * read and edited closely, and the recorded output may become the expected
 * outcome), while Metadata stays on one line (incidental context). The seeded
 * text is normalised to match, so what is saved is canonical.
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
        status: "OK",
        metadata: null,
      },
    ],
  })),
}));

// The span I/O the drawer seeds from: COMPACT JSON input/output and PRETTY
// metadata — i.e. the opposite of the intended presentation, so the assertions
// prove the field's preference wins over the captured serialisation.
// Stable identity: the drawer re-seeds its fields whenever the span-I/O object
// changes, so a fresh literal per render would clobber the normalised value.
const spanIO = vi.hoisted(() => ({
  data: {
    // Must match the selected span's id — the drawer only treats the I/O as ready
    // (seeds fields, enables Save) when spanIO.span_id === span.span_id.
    span_id: "root",
    input: '{"message":"I was charged twice","channel":"email"}',
    output: '{"route":"billing"}',
    metadata: '{\n  "suite": "smoke"\n}',
  },
}));
vi.mock("@/features/traces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/traces")>();
  return { ...actual, useSpanIO: () => spanIO };
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

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SaveTestCaseDrawer projectId="p1" traceId="t1" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * The field's value. LineNumberedTextarea appends a trailing newline purely so
 * the last line's gutter renders (the stored value never keeps it), so trim it.
 */
const valueOf = (label: string) =>
  (screen.getByLabelText(label) as HTMLTextAreaElement).value.trimEnd();

describe("save-as-test-case seed formats", () => {
  it("expands Input even though it was captured compact", async () => {
    mount();
    await screen.findByText("support-ticket-triage");
    const input = valueOf("Input");
    expect(input).toContain("\n"); // pretty, not the captured one-liner
    expect(input).toContain('  "message": "I was charged twice"');
  });

  it("keeps Metadata on one line even though it was captured indented", async () => {
    mount();
    await screen.findByText("support-ticket-triage");
    expect(valueOf("Metadata")).toBe('{"suite":"smoke"}');
  });

  it("expands Output — the editable field that becomes the expected outcome", async () => {
    mount();
    await screen.findByText("support-ticket-triage");
    const output = valueOf("Output");
    expect(output).toContain("\n");
    expect(output).toContain('  "route": "billing"');
  });
});
