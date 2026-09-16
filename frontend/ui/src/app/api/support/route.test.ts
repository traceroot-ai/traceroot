import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  actor: vi.fn(),
  transaction: vi.fn(),
  exact: vi.fn(),
  insensitive: vi.fn(),
  locked: vi.fn(),
  byId: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  endSessions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/support/session", () => ({ impersonationContext: vi.fn() }));
vi.mock("@traceroot/core", () => ({
  prisma: {
    user: { findUnique: mocks.actor },
    $transaction: mocks.transaction,
  },
}));

import { POST } from "./route";

const actor = {
  id: "admin-id",
  email: "admin@traceroot.ai",
  role: "admin",
  banned: false,
};
const target = {
  id: "target-id",
  email: "Staff@traceroot.ai",
  role: null,
  banned: false,
  emailVerified: true,
};

function request(email: string) {
  return new Request("http://localhost/api/support", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email, role: "support" }),
  }) as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ session: {}, user: { id: actor.id } });
  mocks.actor.mockResolvedValue(actor);
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      user: {
        findUnique: mocks.exact,
        findMany: mocks.insensitive,
        findUniqueOrThrow: mocks.byId,
        update: mocks.update,
      },
      $queryRaw: mocks.locked,
      auditLog: { create: mocks.audit, updateMany: mocks.endSessions },
    }),
  );
  mocks.locked.mockResolvedValue([]);
  mocks.byId.mockResolvedValueOnce(actor).mockResolvedValueOnce(target);
  mocks.update.mockResolvedValue(target);
  mocks.audit.mockResolvedValue({});
  mocks.endSessions.mockResolvedValue({ count: 0 });
});

it("prefers the exact unique email over case-insensitive candidates", async () => {
  mocks.exact.mockResolvedValue(target);
  const response = await POST(request(target.email));
  expect(response.status).toBe(200);
  expect(mocks.insensitive).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: target.id },
    data: { role: "support" },
  });
});

it("accepts one unambiguous case-insensitive email match", async () => {
  mocks.exact.mockResolvedValue(null);
  mocks.insensitive.mockResolvedValue([target]);
  const response = await POST(request(target.email.toUpperCase()));
  expect(response.status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: target.id },
    data: { role: "support" },
  });
});

it("rejects ambiguous case-insensitive email matches", async () => {
  mocks.exact.mockResolvedValue(null);
  mocks.insensitive.mockResolvedValue([
    target,
    { ...target, id: "other-id", email: target.email.toLowerCase() },
  ]);
  const response = await POST(request(target.email.toUpperCase()));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Email matches more than one account" });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
