import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const { findFirst, update, updateMany, auditCreate } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
}));

// The mutating handlers delegate to the write service, which runs its own
// tenancy check and audit inside a transaction on this same client.
vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  const client = {
    // The GET reads with findFirst; the service's tenancy gate with findUnique.
    project: { findFirst, findUnique: findFirst, update, updateMany },
    workspaceMember: { findUnique: async () => ({ role: "ADMIN" }) },
    auditLog: { create: auditCreate },
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { ...actual, prisma: client };
});

// Auth/access helpers. The real module pulls in env-validated auth config, so
// stub the whole module: open the gates and reimplement the pure response
// helpers with NextResponse (their only behavior the handler relies on).
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: { id: "u1", email: null, name: null } }),
    requireWorkspaceMembership: async () => ({
      membership: { workspaceId: "w1", userId: "u1", role: "ADMIN" },
    }),
    errorResponse: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    successResponse: <T>(data: T, status = 200) => NextResponse.json(data, { status }),
  };
});

import { GET, PATCH, DELETE } from "./route";

const routeParams = { params: Promise.resolve({ workspaceId: "w1", projectId: "p1" }) } as never;

function patch(body: unknown) {
  return PATCH(
    new Request("http://t/api", { method: "PATCH", body: JSON.stringify(body) }) as never,
    routeParams,
  );
}

function get() {
  return GET(
    new Request("http://t/api") as never,
    {
      params: Promise.resolve({ workspaceId: "w1", projectId: "p1" }),
    } as never,
  );
}

describe("project PATCH alert_window", () => {
  beforeEach(() => {
    findFirst
      .mockReset()
      .mockResolvedValue({ id: "p1", name: "Proj", workspaceId: "w1", deleteTime: null });
    update
      .mockReset()
      .mockResolvedValue({ id: "p1", alertConfig: { emailAddresses: [], alertWindow: "1h" } });
    auditCreate.mockReset();
  });

  it("scopes the project read to the workspace in the path", async () => {
    findFirst.mockResolvedValue(null);
    const res = await patch({ alert_window: "1h" });
    expect(res.status).toBe(404);
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "p1", workspaceId: "w1" });
  });

  it("rejects an empty body with 400 instead of stamping updateTime alone", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No fields to update");
    expect(update).not.toHaveBeenCalled();
  });

  it("answers a patch that changes nothing with 200 and no write, no audit", async () => {
    const res = await patch({ name: "Proj" });
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("records the edit on the audit log under the ui transport", async () => {
    await patch({ alert_window: "1h" });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "update_project",
        transport: "ui",
        summary: { changed: ["alert_window"] },
      }),
    });
  });

  it("rejects an unknown window token with 400", async () => {
    const res = await patch({ alert_window: "24h" });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists a valid window via the alertConfig upsert", async () => {
    const res = await patch({ alert_window: "1h" });
    expect(res.status).toBe(200);
    const arg = update.mock.calls[0][0];
    expect(arg.data.alertConfig.upsert.create.alertWindow).toBe("1h");
    expect(arg.data.alertConfig.upsert.update.alertWindow).toBe("1h");
  });

  it("returns the persisted alert_window in the response", async () => {
    const res = await patch({ alert_window: "1h" });
    const json = await res.json();
    expect(json.alert_window).toBe("1h");
  });

  it("GET returns the project's configured alert_window", async () => {
    findFirst.mockResolvedValueOnce({
      id: "p1",
      name: "Proj",
      traceTtlDays: null,
      rcaModel: null,
      rcaProvider: null,
      rcaSource: null,
      alertConfig: { emailAddresses: [], alertWindow: "30m" },
      accessKeys: [],
      createTime: new Date(),
      updateTime: new Date(),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).alert_window).toBe("30m");
  });
});

describe("project PATCH rename collisions", () => {
  beforeEach(() => {
    findFirst
      .mockReset()
      .mockResolvedValue({ id: "p1", name: "Proj", workspaceId: "w1", deleteTime: null });
    update.mockReset();
  });

  /** A duck-typed Prisma unique-violation naming the violated constraint. */
  const p2002 = (target: unknown) =>
    Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });

  it("maps a rename collision (Prisma P2002 on the name index) to 409 instead of 500", async () => {
    update.mockRejectedValue(p2002("uq_project_workspace_live_name"));
    const res = await patch({ name: "Taken" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A project with this name already exists");
  });

  it("rethrows an alertConfig-upsert P2002 even when the PATCH also carries a name", async () => {
    update.mockRejectedValue(p2002(["projectId"]));
    await expect(
      patch({ name: "Checkout", alert_emails: ["a@example.com"] }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("propagates non-P2002 update failures", async () => {
    update.mockRejectedValue(new Error("connection lost"));
    await expect(patch({ name: "Renamed" })).rejects.toThrow("connection lost");
  });

  it("rethrows a P2002 that names no constraint at all", async () => {
    update.mockRejectedValue(p2002(undefined));
    await expect(patch({ alert_emails: ["a@example.com"] })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});

describe("project DELETE", () => {
  beforeEach(() => {
    findFirst
      .mockReset()
      .mockResolvedValue({ id: "p1", name: "Proj", workspaceId: "w1", deleteTime: null });
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    auditCreate.mockReset();
  });

  it("soft-deletes through the service and records the reason on the audit log", async () => {
    const res = await DELETE(
      new Request("http://t/api", { method: "DELETE" }) as never,
      routeParams,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "p1", deleteTime: null },
      data: { deleteTime: expect.any(Date), updateTime: expect.any(Date) },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_project",
        transport: "ui",
        summary: { name: "Proj", reason: "Deleted from the web app" },
      }),
    });
  });

  it("404s a project outside the workspace or already deleted", async () => {
    findFirst.mockResolvedValue(null);
    const res = await DELETE(
      new Request("http://t/api", { method: "DELETE" }) as never,
      routeParams,
    );
    expect(res.status).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
