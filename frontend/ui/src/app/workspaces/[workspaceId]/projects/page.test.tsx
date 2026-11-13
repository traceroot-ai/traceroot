// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { NextRequest, NextResponse } from "next/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  workspace: {
    id: "ws-1",
    name: "Acme",
    billingPlan: "free",
    createTime: new Date("2026-10-01T00:00:00Z"),
    _count: { members: 1 },
    projects: [
      {
        id: "p1",
        name: "Project",
        traceTtlDays: null,
        createTime: new Date("2026-10-01T00:00:00Z"),
        updateTime: new Date("2026-11-14T00:00:00Z"),
        lastIngestedAt: new Date("2026-11-13T12:34:56Z") as Date | null,
        _count: { accessKeys: 0 },
      },
    ],
  },
}));

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@traceroot/core", () => ({
  prisma: { workspace: { findUnique: async () => mocks.workspace } },
  Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
  getRetentionDays: () => 7,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireWorkspaceMembership: async () => ({ membership: { role: "ADMIN" } }),
  successResponse: (data: unknown) => NextResponse.json(data),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ workspaceId: "ws-1" }),
}));
vi.mock("@/features/workspaces/components", () => ({ WorkspaceBreadcrumb: () => null }));
vi.mock("@/features/projects/components", () => ({ CreateProjectDialog: () => null }));
vi.mock("@/components/icons/domain-icons", () => ({ DOMAIN_ICONS: { project: () => null } }));

import { GET } from "@/app/api/workspaces/[workspaceId]/route";
import { getWorkspace } from "@/lib/api/workspaces";
import { formatDate } from "@/lib/utils";
import ProjectsPage from "./page";

let queryClient: QueryClient;

beforeEach(() => {
  mocks.workspace.projects[0].lastIngestedAt = new Date("2026-11-13T12:34:56Z");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  vi.stubGlobal("fetch", (url: string) => {
    if (url !== "/api/workspaces/ws-1") throw new Error(`Unexpected request: ${url}`);
    return GET(new NextRequest(`http://localhost${url}`), {
      params: Promise.resolve({ workspaceId: "ws-1" }),
    });
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderDateCells() {
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectsPage />
    </QueryClientProvider>,
  );
  const row = await screen.findByRole("button", { name: /^Project / });
  return within(row).getAllByRole("cell");
}

describe("Projects Updated column", () => {
  it("uses the embedded project's ingestion date instead of its settings date", async () => {
    const cells = await renderDateCells();
    expect(cells[2].textContent).toBe(formatDate("2026-11-13T12:34:56Z"));
  });

  it("shows a dash for unknown ingestion history", async () => {
    mocks.workspace.projects[0].lastIngestedAt = null;
    expect((await renderDateCells())[2].textContent).toBe("—");
  });

  it("hides both dates in the demo workspace", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws-1");
    const cells = await renderDateCells();
    expect(cells[1].textContent).toBe("—");
    expect(cells[2].textContent).toBe("—");
  });

  it("refreshes ingestion dates while the Projects page is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cell = (await renderDateCells())[2];
    mocks.workspace.projects[0].lastIngestedAt = new Date("2026-11-14T12:34:56Z");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(cell.textContent).toBe(formatDate("2026-11-14T12:34:56Z")));
  });

  it("refreshes cached data when entering the Projects page", async () => {
    await queryClient.prefetchQuery({
      queryKey: ["workspace", "ws-1"],
      queryFn: () => getWorkspace("ws-1"),
    });
    mocks.workspace.projects[0].lastIngestedAt = new Date("2026-11-14T12:34:56Z");
    const cell = (await renderDateCells())[2];
    await waitFor(() => expect(cell.textContent).toBe(formatDate("2026-11-14T12:34:56Z")));
  });
});
