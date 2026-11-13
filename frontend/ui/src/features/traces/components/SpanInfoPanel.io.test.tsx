// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Span, SpanIO, TraceDetail } from "@/types/api";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { spanIOQueryKey, useSpanIO } from "../hooks";

const { getSpanIO } = vi.hoisted(() => ({ getSpanIO: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "u1", email: "u@example.com" } },
    isPending: false,
  }),
}));
vi.mock("@/lib/api", () => ({ getSpanIO }));

const pendingSpan: Span = {
  span_id: "span-1",
  trace_id: "trace-1",
  parent_span_id: null,
  name: "pending call",
  span_kind: "LLM",
  span_start_time: "2026-10-22T10:00:00.000Z",
  span_end_time: null,
  status: "OK",
  status_message: null,
  error_type: "",
  model_name: null,
  cost: null,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  git_source_file: null,
  git_source_line: null,
  git_source_function: null,
  pending: true,
};

const trace: TraceDetail = {
  trace_id: "trace-1",
  project_id: "proj-1",
  name: "test trace",
  trace_start_time: pendingSpan.span_start_time,
  user_id: null,
  session_id: null,
  git_ref: null,
  git_repo: null,
  environment: "production",
  release: null,
  input: null,
  output: null,
  metadata: null,
  spans: [],
};

const spanIO: SpanIO = {
  span_id: pendingSpan.span_id,
  trace_id: trace.trace_id,
  input: "arrived input",
  output: "arrived output",
  metadata: null,
};

const clients: QueryClient[] = [];
function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
  });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  getSpanIO.mockReset();
});

it("waits for a selected placeholder to arrive before fetching and displaying its I/O", async () => {
  let arrived = false;
  getSpanIO.mockImplementation(async () => {
    if (!arrived) throw new Error("Span not found");
    return spanIO;
  });
  const { client, wrapper } = queryWrapper();
  const panel = (span: Span) => (
    <SpanInfoPanel
      projectId={trace.project_id}
      trace={{ ...trace, spans: span.pending ? [] : [span] }}
      selection={{ type: "span", span }}
    />
  );
  const view = render(panel(pendingSpan), { wrapper });

  await act(async () => {});
  expect(getSpanIO).not.toHaveBeenCalled();
  expect(view.queryByText(/arrived output/)).toBeNull();

  // The same selected ID becomes a real skeleton span, without embedded I/O.
  arrived = true;
  view.rerender(
    panel({ ...pendingSpan, pending: false, span_end_time: "2026-10-22T10:00:05.000Z" }),
  );

  expect(await view.findByText(/arrived input/)).toBeTruthy();
  expect(await view.findByText(/arrived output/)).toBeTruthy();
  expect(getSpanIO).toHaveBeenCalledTimes(1);
  expect(getSpanIO).toHaveBeenCalledWith(trace.project_id, trace.trace_id, pendingSpan.span_id, {
    id: "u1",
    email: "u@example.com",
  });
  expect(
    client.getQueryData(spanIOQueryKey(trace.project_id, trace.trace_id, pendingSpan.span_id)),
  ).toEqual(spanIO);
});

it("still fetches I/O for existing callers that omit the pending argument", async () => {
  getSpanIO.mockResolvedValue(spanIO);
  const { wrapper } = queryWrapper();
  const { result } = renderHook(
    () => useSpanIO(trace.project_id, trace.trace_id, pendingSpan.span_id),
    { wrapper },
  );

  await waitFor(() => expect(result.current.data).toEqual(spanIO));
  expect(getSpanIO).toHaveBeenCalledTimes(1);
});
