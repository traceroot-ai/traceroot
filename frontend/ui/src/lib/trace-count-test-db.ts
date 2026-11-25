import { vi } from "vitest";

export type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the slice of Prisma this module uses. Each query
 * yields once before it runs, as a database round trip would, and a conditional
 * update filters and writes in one step, so overlapping ticks interleave between
 * queries but never inside one.
 */
export function createTestDb() {
  const tables = {
    workspaces: [] as Row[],
    members: [] as Row[],
    users: [] as Row[],
    onboarding: [] as Row[],
  };

  /** Equality, null, `lt`, `not: null`, `OR` and `AND`: the conditions the module writes. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
      if (key === "AND") return (condition as Row[]).every((c) => matches(row, c));
      const value = row[key] ?? null;
      if (condition === null) return value === null;
      if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
      }
      if (typeof condition === "object" && "not" in condition && condition.not === null) {
        return value !== null;
      }
      const { lt } = condition as { lt?: Date };
      if (lt !== undefined) return value instanceof Date && value.getTime() < lt.getTime();
      return value === condition;
    });
  }

  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

  const prisma = {
    workspace: {
      findMany: vi.fn(async ({ where }: { where: { id?: { not: string } } }) => {
        await roundTrip();
        return tables.workspaces
          .filter((ws) => where.id === undefined || ws.id !== where.id.not)
          .map((ws) => ({
            createdBy: ws.createdBy ?? null,
            currentUsage: ws.currentUsage ?? null,
            members: tables.members
              .filter((m) => m.workspaceId === ws.id && m.role === "ADMIN")
              .sort((a, b) => (a.createTime as Date).getTime() - (b.createTime as Date).getTime())
              .slice(0, 1)
              .map((m) => ({ userId: m.userId })),
          }));
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        await roundTrip();
        return tables.users.filter((u) => where.id.in.includes(u.id as string));
      }),
    },
    userOnboarding: {
      findMany: vi.fn(async ({ where }: { where: Row }) => {
        await roundTrip();
        return tables.onboarding.filter((row) => matches(row, where));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        await roundTrip();
        const rows = tables.onboarding.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        await roundTrip();
        if (tables.onboarding.some((row) => row.userId === data.userId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        tables.onboarding.push({ traceCountReportedOn: null, traceCountClaimedAt: null, ...data });
        return data;
      }),
    },
  };
  return { tables, prisma };
}

/** One database per test file: the module mock and the test read the same tables. */
export const testDb = createTestDb();
