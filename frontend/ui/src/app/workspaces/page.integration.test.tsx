// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { NextRequest, NextResponse } from "next/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrismaClient } from "@prisma/client";

const fixture = vi.hoisted(() => ({ userId: "", workspaceId: "", projectId: "" }));
vi.mock("@traceroot/core", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    prisma: new PrismaClient({ datasourceUrl: process.env.PROJECT_INGESTION_TEST_DATABASE_URL }),
    Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
    hasMinRole: () => true,
  };
});
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: fixture.userId } }),
  requireWorkspaceMembership: async () => ({ membership: { role: "ADMIN" } }),
  successResponse: (data: unknown) => NextResponse.json(data),
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: fixture.userId } } }) },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/layout/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/features/workspaces/components", () => ({ CreateWorkspaceDialog: () => null }));

import { prisma } from "@traceroot/core";
import { GET } from "@/app/api/workspaces/route";
import { PUT } from "@/app/api/workspaces/[workspaceId]/route";
import { updateWorkspace } from "@/lib/api/workspaces";
import { formatDate } from "@/lib/utils";
import WorkspacesPage from "./page";

const database = process.env.PROJECT_INGESTION_TEST_DATABASE_URL;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let db: PrismaClient;

beforeAll(async () => {
  if (!database) return;
  db = prisma;
  fixture.userId = crypto.randomUUID();
  fixture.workspaceId = crypto.randomUUID();
  fixture.projectId = crypto.randomUUID();
  await db.user.create({
    data: { id: fixture.userId, email: `${fixture.userId}@example.com`, name: "Test user" },
  });
  await db.workspace.create({
    data: {
      id: fixture.workspaceId,
      name: "Acme",
      createdBy: fixture.userId,
      members: { create: { id: crypto.randomUUID(), userId: fixture.userId, role: "ADMIN" } },
      projects: { create: { id: fixture.projectId, name: "Project" } },
    },
  });
  vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
    const request = new NextRequest(`http://localhost${url}`, {
      ...options,
      signal: options?.signal ?? undefined,
    });
    if (url === "/api/workspaces") return GET(request);
    if (url === `/api/workspaces/${fixture.workspaceId}` && request.method === "PUT") {
      return PUT(request, { params: Promise.resolve({ workspaceId: fixture.workspaceId }) });
    }
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  });
});

afterAll(async () => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  if (!database) return;
  try {
    await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await db.user.deleteMany({ where: { id: fixture.userId } });
  } finally {
    await db.$disconnect();
  }
});

function ingest(received: string, child: boolean) {
  const repository = path.resolve(process.cwd(), "../..");
  execFileSync(
    process.env.PYTHON ?? "python3",
    [
      "-c",
      `
import sys
from unittest.mock import MagicMock, patch
from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces
s3, ch = MagicMock(), MagicMock()
s3.download_json.return_value = make_otel_payload([make_span("aa" * 16, "bb" * 8, parent_span_id_hex="cc" * 8 if sys.argv[3] == "true" else None)])
ch.query.return_value.result_rows = [("aa" * 16,)]
with patch("rest.services.s3.get_s3_service", return_value=s3), patch("db.clickhouse.client.get_clickhouse_client", return_value=ch), patch("worker.detector_tasks.enqueue_detector_runs"), patch("worker.ingest_tasks._publish_live_spans"):
    process_s3_traces(s3_key="snapshot.json", project_id=sys.argv[1], received_at=sys.argv[2])
`,
      fixture.projectId,
      received,
      String(child),
    ],
    {
      cwd: repository,
      env: { ...process.env, DATABASE_URL: database, PYTHONPATH: path.join(repository, "backend") },
      stdio: "pipe",
    },
  );
}

it.skipIf(!database)(
  "shows persisted ingestion and replacement snapshots without treating renames as activity",
  async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacesPage />
      </QueryClientProvider>,
    );
    const row = await screen.findByRole("button", { name: /Acme/ });
    const updated = within(row).getAllByRole("cell")[2];
    expect(updated.textContent).toBe("—");

    ingest("2026-11-12T12:00:00Z", false);
    await act(() => queryClient.invalidateQueries({ queryKey: ["workspaces"] }));
    await waitFor(() => expect(updated.textContent).toBe(formatDate("2026-11-12T12:00:00Z")));

    ingest("2026-11-13T12:34:56Z", true);
    ingest("2026-11-12T12:00:00Z", true);
    await updateWorkspace(fixture.workspaceId, "Acme renamed");
    await act(() => queryClient.invalidateQueries({ queryKey: ["workspaces"] }));
    await waitFor(() => expect(updated.textContent).toBe(formatDate("2026-11-13T12:34:56Z")));
    expect(
      (
        await db.project.findUniqueOrThrow({ where: { id: fixture.projectId } })
      ).lastIngestedAt?.toISOString(),
    ).toBe("2026-11-13T12:34:56.000Z");

    await db.project.update({ where: { id: fixture.projectId }, data: { deleteTime: new Date() } });
    await act(() => queryClient.invalidateQueries({ queryKey: ["workspaces"] }));
    await waitFor(() => expect(updated.textContent).toBe("—"));
  },
  30_000,
);
