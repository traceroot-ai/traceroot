import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  original: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
  set: vi.fn(),
  expire: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
  snapshot: vi.fn(),
  update: vi.fn(),
}));
vi.mock("better-auth/api", async (original) => ({
  ...(await original<typeof import("better-auth/api")>()),
  createAuthEndpoint: (_path: string, _options: unknown, handler: unknown) => handler,
  getSessionFromCtx: mocks.current,
}));
vi.mock("better-auth/cookies", () => ({
  setSessionCookie: mocks.set,
  expireCookie: mocks.expire,
  deleteSessionCookie: mocks.clear,
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    session: { findUnique: mocks.original, findFirst: mocks.snapshot },
    auditLog: { findFirst: mocks.audit },
    $transaction: mocks.transaction,
  },
}));
import { supportPlugin } from "./auth-plugin";
const original = {
  userId: "staff",
  expiresAt: new Date(Date.now() + 60000),
  user: { id: "staff", email: "staff@traceroot.ai" },
};
function ctx(cookies: Record<string, string> = {}) {
  return {
    context: { secret: "test", createAuthCookie: (name: string) => ({ name }) },
    getSignedCookie: vi.fn(async (name: string) => cookies[name]),
    json: (body: unknown) => body,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.current.mockResolvedValue(null);
  mocks.original.mockResolvedValue(original);
  mocks.audit.mockResolvedValue(null);
  mocks.snapshot.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async (fn) =>
    fn({
      session: { findUnique: async () => null, deleteMany: mocks.remove },
      auditLog: { updateMany: mocks.update },
    }),
  );
});
it("never replaces a fresh login with a stale restore cookie", async () => {
  mocks.current.mockResolvedValue({ session: { id: "new-login" } });
  await supportPlugin().endpoints.supportStop(
    ctx({ support_original: "old-token:old-session" }) as never,
  );
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.original).not.toHaveBeenCalled();
  expect(mocks.expire).toHaveBeenCalledTimes(2);
});
it("restores after the customer session has expired", async () => {
  await supportPlugin().endpoints.supportStop(ctx({ support_original: "token:ended" }) as never);
  expect(mocks.remove).toHaveBeenCalledWith({ where: { id: "ended" } });
  expect(mocks.set).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ session: original }),
  );
});
it("can restore an expired legacy session without treating remember-me as a session ID", async () => {
  await supportPlugin().endpoints.supportStop(ctx({ admin_session: "token:true" }) as never);
  expect(mocks.original).toHaveBeenCalledWith({
    where: { token: "token" },
    include: { user: true },
  });
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.set).toHaveBeenCalledOnce();
});
it("rejects restore cookies bound to a different live impersonation", async () => {
  mocks.current.mockResolvedValue({ session: { id: "new", impersonatedBy: "staff" } });
  await expect(
    supportPlugin().endpoints.supportStop(ctx({ support_original: "token:old" }) as never),
  ).rejects.toThrow("Restore cookie does not match");
  expect(mocks.set).not.toHaveBeenCalled();
});
it("does not restore an expired employee login", async () => {
  mocks.original.mockResolvedValue({ ...original, expiresAt: new Date(0) });
  await supportPlugin().endpoints.supportStop(ctx({ support_original: "token:ended" }) as never);
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.clear).toHaveBeenCalledOnce();
});
it("retains expired audit timestamps after Better Auth deletes the session", async () => {
  const expired = new Date(Date.now() - 1000);
  mocks.snapshot.mockResolvedValue({ expiresAt: expired });
  mocks.audit.mockResolvedValue({
    id: "audit",
    endedAt: null,
    expiresAt: new Date(Date.now() + 60000),
  });
  await supportPlugin().endpoints.supportStop(ctx({ support_original: "token:ended" }) as never);
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: "audit", endedAt: null },
    data: { expiresAt: expired, endedAt: expired, endReason: "expired" },
  });
});

it.each(["admin", "support"])(
  "starts an audited %s session and binds its restore cookie",
  async (role) => {
    const actor = { id: "staff", email: "staff@traceroot.ai", role };
    const target = { id: "customer", email: "customer@example.com", role: null, name: null };
    mocks.current.mockResolvedValue({ user: actor, session: { token: "original-token" } });
    const create = vi.fn(async ({ data }) => data);
    const audit = vi.fn();
    mocks.transaction.mockImplementation(async (fn) =>
      fn({
        $queryRaw: vi.fn(),
        user: { findUnique: vi.fn().mockResolvedValueOnce(actor).mockResolvedValueOnce(target) },
        session: { create },
        auditLog: { create: audit },
      }),
    );
    const context = {
      ...ctx(),
      body: { userId: target.id, reason: "ticket" },
      setSignedCookie: vi.fn(),
    };
    await supportPlugin().endpoints.supportStart(context as never);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: target.id, impersonatedBy: actor.id });
    expect(context.setSignedCookie).toHaveBeenCalledWith(
      "support_original",
      `original-token:${data.id}`,
      "test",
      undefined,
    );
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "impersonation.started",
        actorUserId: actor.id,
        targetUserId: target.id,
        summary: { reason: "ticket", mode: role === "admin" ? "read-write" : "read-only" },
      }),
    });
    expect(mocks.set).toHaveBeenCalledWith(
      context,
      { session: data, user: { ...target, name: target.email } },
      false,
    );
  },
);

it.each([null, { session: { impersonatedBy: "staff" } }])(
  "rejects starting without an original employee session",
  async (current) => {
    mocks.current.mockResolvedValue(current);
    await expect(supportPlugin().endpoints.supportStart(ctx() as never)).rejects.toThrow(
      "Use your employee session",
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it.each(["admin", "support"])(
  "audits denial of a %s target without creating a session",
  async (role) => {
    const actor = { id: "staff", email: "staff@traceroot.ai", role: "admin" };
    const create = vi.fn();
    const audit = vi.fn();
    mocks.current.mockResolvedValue({ user: actor, session: {} });
    mocks.transaction.mockImplementation(async (fn) =>
      fn({
        $queryRaw: vi.fn(),
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(actor)
            .mockResolvedValueOnce({ id: "other-staff", role }),
        },
        session: { create },
        auditLog: { create: audit },
      }),
    );
    await expect(
      supportPlugin().endpoints.supportStart({
        ...ctx(),
        body: { userId: "other-staff", reason: "" },
      } as never),
    ).rejects.toThrow("cannot be impersonated");
    expect(create).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "impersonation.denied",
        targetUserId: "other-staff",
        summary: { reason: null },
      }),
    });
    expect(mocks.set).not.toHaveBeenCalled();
  },
);
