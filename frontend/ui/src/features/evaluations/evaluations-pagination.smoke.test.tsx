// @vitest-environment jsdom
/**
 * View-mount smoke for the Evaluations list's page clamp. The clamp pulls a page
 * back inside a result set that has shrunk; these cover the two ways it can pull
 * back a page that is actually valid — a stale placeholder `total`, and a
 * `page_limit` the API caps below what the URL asked for. Both are driven through
 * the real view (URL in, request + URL rewrite out), since the bug only exists in
 * the interplay between the query cache, the hook, and the view's effect.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

let currentParams = new URLSearchParams();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => currentParams,
  usePathname: () => "/projects/p1/evaluations",
}));
// ProjectBreadcrumb pulls layout/workspace context this harness doesn't mount.
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

import { EvaluationsView } from "./views/evaluations-view";

/** A list row with the counts the real route emits unconditionally. */
const row = (n: number) => ({
  id: `run${n}`,
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber: n,
  candidateVersion: `git:c${n}`,
  environment: "ci",
  status: "completed",
  baselineRunId: null,
  caseCount: 1,
  scoredCount: 1,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  passedCount: 1,
  failedCount: 0,
  erroredCount: 0,
  notScoredCount: 0,
  cost: 0.1,
  scorers: [],
  startedAt: "2026-07-17T10:24:00Z",
  completedAt: "2026-07-17T10:30:00Z",
  evaluationName: "Billing routing",
  datasetName: "Billing routing",
  datasetVersionLabel: "v1",
  changeFromBaseline: null,
  errorCount: 0,
  baselineComparable: true,
  elapsedMs: 1000,
  passRate: 1,
  excludedSummary: null,
  comparison: null,
  metadata: null,
});

const isRuns = (url: string) => url.includes("/evaluations/runs");
/** The `page_index` each URL rewrite settled on, in order. */
const rewrittenPages = () =>
  replace.mock.calls.map((c) => new URL(String(c[0]), "http://x").searchParams.get("page_index"));

function view(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EvaluationsView projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  replace.mockClear();
});

describe("Evaluations list page clamp", () => {
  it("does not clamp against the previous query's total while the next one is in flight", async () => {
    // Settled on a narrow window: 5 runs, so page 0 is the only page.
    currentParams = new URLSearchParams({ date_filter: "1h" });
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () =>
        isRuns(String(url)) ? { data: [row(1)], meta: { page: 0, limit: 50, total: 5 } } : {},
    })) as unknown as typeof fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(view(qc));
    await screen.findByText("git:c1");
    replace.mockClear();

    // A deep link widens the window (1000 runs -> pages 0-19, so page 3 has rows) and
    // asks for page 3. Hold the response so the placeholder window is observable:
    // `placeholderData` serves the 5-run `meta` throughout it.
    let release: (v: unknown) => void = () => {};
    const held = new Promise((r) => (release = r));
    const requestedPages: (string | null)[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (isRuns(s)) {
        requestedPages.push(new URL(s, "http://x").searchParams.get("page"));
        await held;
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          isRuns(s) ? { data: [row(2)], meta: { page: 3, limit: 50, total: 1000 } } : {},
      };
    }) as unknown as typeof fetch;

    currentParams = new URLSearchParams({ date_filter: "30d", page_index: "3" });
    rerender(view(qc));

    // In flight: the stale 5-run total must not size the incoming page.
    await waitFor(() => expect(requestedPages).toContain("3"));
    expect(rewrittenPages()).toEqual([]);

    release(null);
    await screen.findByText("git:c2");
    // Settled: page 3 is inside 1000 runs, so it still stands and was never re-fetched
    // at some earlier page.
    expect(rewrittenPages()).toEqual([]);
    expect(new Set(requestedPages)).toEqual(new Set(["3"]));
  });

  it("sizes the last page by the limit the API serves, not a larger requested one", async () => {
    // The list routes cap `limit` at 200 and echo the capped value, so ?page_limit=500
    // is served as 200 -> 1000 runs is pages 0-4 and page 3 has rows. Sizing by the
    // requested 500 would make page 1 the last page and bounce a valid deep link.
    currentParams = new URLSearchParams({ page_limit: "500", page_index: "3" });
    const requestedLimits: (string | null)[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const s = String(url);
      const params = new URL(s, "http://x").searchParams;
      if (isRuns(s)) requestedLimits.push(params.get("limit"));
      const requested = Number(params.get("limit") ?? 50);
      return {
        ok: true,
        status: 200,
        json: async () =>
          isRuns(s)
            ? {
                data: [row(1)],
                // Mirrors runs/route.ts: the served limit is the capped one.
                meta: { page: 3, limit: Math.min(Math.max(requested, 1), 200), total: 1000 },
              }
            : {},
      };
    }) as unknown as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(view(qc));
    await screen.findByText("git:c1");

    // The request asks for the page size the server will actually serve...
    expect(new Set(requestedLimits)).toEqual(new Set(["200"]));
    // ...and page 3 stands rather than being rewritten to 1.
    expect(rewrittenPages()).toEqual([]);
  });
});
