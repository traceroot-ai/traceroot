import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteFn: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    aISession: {
      findFirst: mocks.findFirst,
      delete: mocks.deleteFn,
    },
  },
}));

import { deleteSession, getSession, getSessionMessages } from "../session.js";

/**
 * Evaluate the where clauses session.ts builds (equality fields plus an OR of
 * equality branches) against fixture rows, so these tests exercise the query
 * SEMANTICS — which sessions are reachable — rather than pinning arg shapes.
 */
function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) =>
    key === "OR"
      ? (value as Array<Record<string, unknown>>).some((branch) => rowMatches(row, branch))
      : row[key] === value,
  );
}

const SESSIONS = [
  {
    id: "s-owned",
    userId: "u1",
    projectId: "pA",
    workspaceId: "wA",
    messages: [{ id: "m1" }],
  },
  {
    id: "s-system",
    userId: null,
    projectId: "pA",
    workspaceId: "wA",
    messages: [{ id: "m2" }],
  },
];

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.deleteFn.mockReset();
  mocks.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    return SESSIONS.find((row) => rowMatches(row, where)) ?? null;
  });
  mocks.deleteFn.mockResolvedValue({ id: "s-owned" });
});

describe("getSession tenancy", () => {
  it("returns the owner's session when the request names its own project", async () => {
    const session = await getSession("s-owned", "u1", "pA");
    expect(session?.id).toBe("s-owned");
  });

  it("rejects an owned session reached through a different project's path (404-indistinguishable)", async () => {
    // Without the project constraint, tools would be built from two unrelated
    // tenancies: projectId from the URL, workspaceId from the session.
    const session = await getSession("s-owned", "u1", "pB");
    expect(session).toBeNull();
  });

  it("keeps system-session semantics: project scope grants access, other projects do not", async () => {
    expect((await getSession("s-system", "u1", "pA"))?.id).toBe("s-system");
    expect(await getSession("s-system", "u1", "pB")).toBeNull();
  });
});

describe("getSessionMessages tenancy", () => {
  it("returns messages for the owner in the session's own project", async () => {
    const messages = await getSessionMessages("s-owned", "u1", "pA");
    expect(messages).toEqual([{ id: "m1" }]);
  });

  it("rejects an owned session's messages through a different project's path", async () => {
    expect(await getSessionMessages("s-owned", "u1", "pB")).toBeNull();
  });
});

describe("deleteSession tenancy", () => {
  it("deletes an owned session addressed through its own project", async () => {
    const result = await deleteSession("s-owned", "u1", "pA");
    expect(result).not.toBeNull();
    expect(mocks.deleteFn).toHaveBeenCalledWith({ where: { id: "s-owned" } });
  });

  it("refuses to delete an owned session addressed through another project", async () => {
    const result = await deleteSession("s-owned", "u1", "pB");
    expect(result).toBeNull();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });
});
