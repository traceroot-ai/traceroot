// @vitest-environment jsdom
/**
 * The Datasets list keeps its page in the URL, and the dataset detail's breadcrumb
 * and "Back to datasets" link return to the list query it was opened from instead
 * of the first page.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/projects/p1/datasets",
}));
// Renders the breadcrumb trail as plain links so its href can be asserted.
vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: ({ trail }: { trail?: { label: string; href: string }[] }) => (
    <nav>
      {trail?.map((t) => (
        <a key={t.href} href={t.href} data-testid="breadcrumb-trail">
          {t.label}
        </a>
      ))}
    </nav>
  ),
}));

import { DatasetsView } from "./views/datasets-view";
import { DatasetDetailView } from "./views/dataset-detail-view";

const dataset = {
  id: "ds1",
  name: "Billing routing",
  clientDatasetId: null,
  caseCount: 0,
  versionCount: 0,
  updateTime: "2026-07-17T10:24:00Z",
};

let detailStatus = 404;
beforeEach(() => {
  nav.search = "";
  nav.replace.mockClear();
  sessionStorage.clear();
  detailStatus = 404;
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (/\/datasets\/ds1/.test(u)) {
      if (detailStatus !== 200) return { ok: false, status: detailStatus, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          dataset,
          currentVersion: null,
          selectedVersion: null,
          isCurrentVersion: true,
          testCases: [],
          versions: [],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [dataset], meta: { page: 1, limit: 50, total: 120 } }),
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

async function openListOnSecondPage() {
  nav.search = "page_index=1";
  mount(<DatasetsView projectId="p1" />);
  await screen.findByText("Billing routing");
  cleanup();
  nav.search = "";
}

describe("datasets list return link", () => {
  it("the dataset detail breadcrumb links back to the list query it was opened from", async () => {
    await openListOnSecondPage();
    detailStatus = 200;
    mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
    const crumb = await screen.findByTestId("breadcrumb-trail");
    await waitFor(() =>
      expect(crumb.getAttribute("href")).toBe("/projects/p1/datasets?page_index=1"),
    );
  });

  it("the not-found state's back link returns to the same list page", async () => {
    await openListOnSecondPage();
    mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
    const back = await screen.findByText("Back to datasets");
    await waitFor(() =>
      expect(back.getAttribute("href")).toBe("/projects/p1/datasets?page_index=1"),
    );
  });

  it("links to the bare list when no list query was recorded", async () => {
    mount(<DatasetDetailView projectId="p1" datasetId="ds1" />);
    const back = await screen.findByText("Back to datasets");
    expect(back.getAttribute("href")).toBe("/projects/p1/datasets");
  });
});
