// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { NextRequest, NextResponse } from "next/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  workspace: {
    id: "ws-own",
    name: "Acme",
    createdBy: "user-1",
    createTime: new Date("2026-10-01T00:00:00Z"),
    updateTime: new Date("2026-10-02T00:00:00Z"),
    projects: [
      {
        id: "p1",
        name: "First project",
        lastIngestedAt: new Date("2026-10-02T00:00:00Z") as Date | null,
      },
    ],
    _count: { members: 1 },
  },
}));

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@traceroot/core", () => {
  const client = {
    workspace: {
      findUnique: async () => mocks.workspace,
      update: async ({ data }: { data: { name: string; updateTime: Date } }) => {
        Object.assign(mocks.workspace, data);
        return mocks.workspace;
      },
    },
    workspaceMember: {
      findUnique: async () => ({ role: "ADMIN" }),
      findMany: async () => [{ role: "ADMIN", workspace: mocks.workspace }],
    },
    auditLog: { create: async () => ({}) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return {
    prisma: client,
    Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
    hasMinRole: () => true,
  };
});
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireWorkspaceMembership: async () => ({ membership: { role: "ADMIN" } }),
  successResponse: (data: unknown) => NextResponse.json(data),
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/layout/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/features/workspaces/components", () => ({ CreateWorkspaceDialog: () => null }));

import { GET } from "@/app/api/workspaces/route";
import { PUT } from "@/app/api/workspaces/[workspaceId]/route";
import { getWorkspaces, updateWorkspace } from "@/lib/api/workspaces";
import { formatDate } from "@/lib/utils";
import WorkspacesPage from "./page";

let queryClient: QueryClient;

beforeEach(() => {
  mocks.workspace.name = "Acme";
  mocks.workspace.updateTime = new Date("2026-10-02T00:00:00Z");
  mocks.workspace.projects[0].lastIngestedAt = new Date("2026-10-02T00:00:00Z");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    const request = new NextRequest(`http://localhost${url}`, {
      ...options,
      signal: options?.signal ?? undefined,
    });
    if (url === "/api/workspaces" && request.method === "GET") return GET(request);
    if (url === "/api/workspaces/ws-own" && request.method === "PUT") {
      return PUT(request, { params: Promise.resolve({ workspaceId: "ws-own" }) });
    }
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function renderUpdatedCell() {
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspacesPage />
    </QueryClientProvider>,
  );
  const row = await screen.findByRole("button", { name: /Acme/ });
  return within(row).getAllByRole("cell")[2];
}

describe("Workspaces Updated column", () => {
  it("displays the stored timestamp from the list response", async () => {
    expect((await renderUpdatedCell()).textContent).toBe(formatDate("2026-10-02T00:00:00Z"));
  });

  it("fetches a fresh ingestion date on entry even when the list is cached", async () => {
    await queryClient.prefetchQuery({ queryKey: ["workspaces"], queryFn: getWorkspaces });
    mocks.workspace.projects[0].lastIngestedAt = new Date("2026-11-13T12:34:56Z");
    const cell = await renderUpdatedCell();
    await waitFor(() => expect(cell.textContent).toBe(formatDate("2026-11-13T12:34:56Z")));
  });

  it("keeps the ingestion date when the workspace is renamed", async () => {
    const renamedAt = new Date("2026-11-12T12:34:56Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(renamedAt);
    const renamed = await updateWorkspace("ws-own", "Acme renamed");
    vi.useRealTimers();
    expect(renamed.update_time).toBe("2026-11-12T12:34:56.000Z");
    expect(mocks.workspace.updateTime.toISOString()).toBe("2026-11-12T12:34:56.000Z");
    expect((await renderUpdatedCell()).textContent).toBe(formatDate("2026-10-02T00:00:00Z"));
  });

  it("preserves the timestamp when the name is unchanged", async () => {
    const unchanged = await updateWorkspace("ws-own", "Acme");
    expect(unchanged.update_time).toBe("2026-10-02T00:00:00.000Z");
    expect((await renderUpdatedCell()).textContent).toBe(formatDate("2026-10-02T00:00:00Z"));
  });

  it("shows a dash until telemetry has been ingested", async () => {
    mocks.workspace.projects[0].lastIngestedAt = null;
    expect((await renderUpdatedCell()).textContent).toBe("—");
  });

  it("refreshes the displayed date when a later snapshot arrives", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cell = await renderUpdatedCell();
    mocks.workspace.projects[0].lastIngestedAt = new Date("2026-11-13T12:34:56Z");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(cell.textContent).toBe(formatDate("2026-11-13T12:34:56Z")));
  });

  it("hides both dates for the demo workspace even when timestamps are returned", async () => {
    vi.stubEnv("DEMO_WORKSPACE_ID", "ws-own");
    await renderUpdatedCell();
    const row = screen.getByRole("button", { name: /Acme/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[1].textContent).toBe("—");
    expect(cells[2].textContent).toBe("—");
  });
});
