import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), audit: vi.fn(), update: vi.fn() }));
vi.mock("@traceroot/core", () => ({
  prisma: {
    user: { findUnique: mocks.user },
    auditLog: { findFirst: mocks.audit, updateMany: mocks.update },
  },
}));
import { impersonationContext } from "./session";
const session = {
  id: "session",
  userId: "customer",
  impersonatedBy: "staff",
  createdAt: new Date(Date.now() - 3 * 3600000),
  expiresAt: new Date(Date.now() + 86400000),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockImplementation(({ where }) =>
    Promise.resolve({
      id: where.id,
      role: where.id === "staff" ? "support" : "user",
      banned: false,
    }),
  );
  mocks.audit.mockResolvedValue({
    id: "audit",
    endedAt: null,
    expiresAt: new Date(Date.now() - 3600000),
  });
  mocks.update.mockResolvedValue({ count: 1 });
});
it("uses live session expiry past two hours, not the old audit deadline", async () => {
  const context = await impersonationContext(session);
  expect(context?.valid).toBe(true);
  expect(context?.expiresAt).toEqual(session.expiresAt);
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: "audit", endedAt: null },
    data: { expiresAt: session.expiresAt },
  });
});
it("still denies a normally expired login session", async () => {
  const context = await impersonationContext({
    ...session,
    expiresAt: new Date(Date.now() - 1000),
  });
  expect(context?.reason).toBe("expired");
});
it("still denies a revoked staff role", async () => {
  mocks.user.mockResolvedValue({ role: "user", banned: false });
  expect((await impersonationContext(session))?.reason).toBe("revoked");
});
