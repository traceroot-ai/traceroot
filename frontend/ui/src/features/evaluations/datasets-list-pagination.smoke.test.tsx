// @vitest-environment jsdom
/**
 * The Datasets list drives the shared pager from its own page state and pulls a page
 * that is past the end of the list back inside it, without measuring against a stale
 * placeholder total and without throwing the user back to the first page on delete.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

// Next hands out one URLSearchParams instance until the URL changes.
const nav = vi.hoisted(() => ({
  search: "",
  params: undefined as { query: string; value: URLSearchParams } | undefined,
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => {
    if (nav.params?.query !== nav.search) {
      nav.params = { query: nav.search, value: new URLSearchParams(nav.search) };
    }
    return nav.params.value;
  },
  usePathname: () => "/projects/p1/datasets",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
// The view asks the project role whether to offer writes; the stubbed fetch
// does not answer that lookup.
vi.mock("@/features/projects/hooks/use-can-edit-project", () => ({
  useCanEditProject: () => true,
}));

import { DatasetsView } from "./views/datasets-view";

const dataset = (n: number) => ({
  id: `ds${n}`,
  name: `Dataset ${n}`,
  clientDatasetId: null,
  caseCount: 0,
  versionCount: 0,
  updateTime: "2026-07-17T10:24:00Z",
});

type ListResponse = { data: unknown[]; meta: { page: number; limit: number; total: number } };
let listResponse: (params: URLSearchParams) => ListResponse | Promise<ListResponse>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nav.search = "";
  nav.replace.mockReset();
  sessionStorage.clear();
  listResponse = () => ({ data: [dataset(1)], meta: { page: 0, limit: 50, total: 120 } });
  fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), "http://x");
    if (init?.method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    if (u.pathname.endsWith("/datasets")) {
      const body = await listResponse(u.searchParams);
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

function view(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DatasetsView projectId="p1" />
      </ToastProvider>
    </QueryClientProvider>
  );
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const rewrittenPages = () =>
  nav.replace.mock.calls.map((c) =>
    new URL(String(c[0]), "http://x").searchParams.get("page_index"),
  );

describe("datasets list pagination", () => {
  it("shows the page held in the URL, not the page the server echoes back", async () => {
    // `meta.page` is the previous query's echo while placeholder data is shown; the
    // pager must follow the page the user is on.
    nav.search = "page_index=1";
    render(view(newClient()));
    expect(await screen.findByText("Showing 51–100 of 120")).toBeDefined();
  });

  it("pulls a deep link past the end back to the last page with rows", async () => {
    nav.search = "page_index=5";
    render(view(newClient()));
    await screen.findByText("Dataset 1");
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith("/projects/p1/datasets?page_index=2", {
        scroll: false,
      }),
    );
  });

  it("does not clamp against the previous query's total while the next page loads", async () => {
    // Settled on a 30-row search (one page); the URL then asks for page 3 of a wider
    // result. Until that response lands, the placeholder still carries total 30.
    nav.search = "search=billing";
    listResponse = () => ({ data: [dataset(1)], meta: { page: 0, limit: 50, total: 30 } });
    const qc = newClient();
    const { rerender } = render(view(qc));
    await screen.findByText("Dataset 1");
    nav.replace.mockReset();

    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const requested: (string | null)[] = [];
    listResponse = async (params) => {
      requested.push(params.get("page"));
      await held;
      return { data: [dataset(2)], meta: { page: 3, limit: 50, total: 1000 } };
    };
    nav.search = "page_index=3";
    rerender(view(qc));

    await waitFor(() => expect(requested).toContain("3"));
    expect(rewrittenPages()).toEqual([]);
    release();
    await screen.findByText("Dataset 2");
    expect(rewrittenPages()).toEqual([]);
  });

  it("stays on the current page after deleting a dataset", async () => {
    nav.search = "page_index=1";
    render(view(newClient()));
    fireEvent.click(await screen.findByLabelText("Row actions"));
    fireEvent.click(await screen.findByText("Delete"));
    await screen.findByText("Delete dataset");
    fireEvent.change(screen.getByPlaceholderText("Dataset 1"), {
      target: { value: "Dataset 1" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    expect(await screen.findByText("Deleted Dataset 1")).toBeDefined();
    // The list refetches; page 1 of 120 rows is still valid, so nothing rewrites it.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3));
    expect(rewrittenPages()).toEqual([]);
    expect(screen.getByText("Showing 51–100 of 120")).toBeDefined();
  });
});
