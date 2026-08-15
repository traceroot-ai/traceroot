/**
 * publishDatasetVersion's pointer-swap concurrency.
 *
 * The dataset row has no row lock during the surrounding transaction, so two
 * publishes that both read `currentVersionId = V1` must not both succeed in
 * moving the pointer — the loser has to see its base has moved, not silently
 * overwrite the winner. This drives the real function against a tiny in-memory
 * fake prisma that lets a test control the read/write interleaving directly,
 * rather than relying on real transaction timing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeDataset = { id: string; projectId: string; currentVersionId: string | null };
type FakeVersion = {
  id: string;
  datasetId: string;
  versionNumber: number;
  idempotencyKey?: string | null;
};
type FakeTestCase = { id: string; datasetVersionId: string; testCaseId: string; createTime: Date };

function makeFakeDb() {
  const dataset: FakeDataset = { id: "ds1", projectId: "p1", currentVersionId: "v0" };
  const versions: FakeVersion[] = [{ id: "v0", datasetId: "ds1", versionNumber: 1 }];
  const testCases: FakeTestCase[] = [];
  let nextVersionN = 1;

  // Lets a test pause a specific call's `dataset.findFirst` mid-flight, to force
  // a stale-read race deterministically instead of hoping for real timing.
  let findFirstGate: Promise<void> | null = null;

  const tx = {
    dataset: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        if (where.id !== dataset.id) return null;
        const snapshot = { id: dataset.id, currentVersionId: dataset.currentVersionId };
        if (findFirstGate) {
          const gate = findFirstGate;
          findFirstGate = null; // only the next call after arming waits
          await gate;
        }
        return snapshot;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; projectId: string; currentVersionId: string | null };
          data: { currentVersionId: string };
        }) => {
          if (
            where.id === dataset.id &&
            where.projectId === dataset.projectId &&
            where.currentVersionId === dataset.currentVersionId
          ) {
            dataset.currentVersionId = data.currentVersionId;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    datasetVersion: {
      findFirst: vi.fn(
        async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
          if ("idempotencyKey" in where) {
            return versions.find((v) => v.idempotencyKey === where.idempotencyKey) ?? null;
          }
          if (orderBy) {
            const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
            return sorted[0] ?? null;
          }
          return null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<FakeVersion, "id"> }) => {
        nextVersionN += 1;
        const v: FakeVersion = { ...data, id: `v${nextVersionN}` };
        versions.push(v);
        return v;
      }),
    },
    testCase: {
      findMany: vi.fn(async ({ where }: { where: { datasetVersionId: string } }) =>
        testCases.filter((c) => c.datasetVersionId === where.datasetVersionId),
      ),
      count: vi.fn(
        async ({ where }: { where: { datasetVersionId: string } }) =>
          testCases.filter((c) => c.datasetVersionId === where.datasetVersionId).length,
      ),
      createMany: vi.fn(async ({ data }: { data: FakeTestCase[] }) => {
        testCases.push(...data);
      }),
    },
  };

  const prisma = { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };

  return {
    prisma,
    dataset,
    versions,
    armFindFirstGate: (gate: Promise<void>) => {
      findFirstGate = gate;
    },
  };
}

const fakeDb = vi.hoisted(() => ({ current: null as ReturnType<typeof makeFakeDb> | null }));

vi.mock("@traceroot/core", () => ({
  get prisma() {
    return fakeDb.current!.prisma;
  },
}));

import { publishDatasetVersion, VersionConflict } from "./versions";

beforeEach(() => {
  fakeDb.current = makeFakeDb();
});

describe("publishDatasetVersion — pointer compare-and-swap", () => {
  it("publishes normally when nothing else touched the dataset", async () => {
    const result = await publishDatasetVersion({
      datasetId: "ds1",
      projectId: "p1",
      transform: (current) => ({ cases: current, focusTestCaseId: "" }),
    });
    expect(result.versionNumber).toBe(2);
    expect(fakeDb.current!.dataset.currentVersionId).toBe(result.versionId);
  });

  it("rejects a publish whose base moved between its read and its write, instead of silently overwriting", async () => {
    // B reads `currentVersionId = v0` first, then pauses (simulating another
    // request winning the race in between); A then publishes fully on top of
    // that same v0 and moves the pointer. When B resumes, its write must see
    // that its base is stale rather than clobbering A's published version.
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    fakeDb.current!.armFindFirstGate(gate);

    const bPromise = publishDatasetVersion({
      datasetId: "ds1",
      projectId: "p1",
      transform: (current) => ({ cases: current, focusTestCaseId: "" }),
    });

    const aResult = await publishDatasetVersion({
      datasetId: "ds1",
      projectId: "p1",
      transform: (current) => ({ cases: current, focusTestCaseId: "" }),
    });
    expect(aResult.versionNumber).toBe(2);
    expect(fakeDb.current!.dataset.currentVersionId).toBe(aResult.versionId);

    releaseB();
    await expect(bPromise).rejects.toBeInstanceOf(VersionConflict);

    // A's publish is still the live version — the pointer never moved to B's,
    // which is the invariant the compare-and-swap exists to protect. (The real
    // transaction also rolls back B's created version row; this fake isn't
    // transactional, so that part isn't re-asserted here.)
    expect(fakeDb.current!.dataset.currentVersionId).toBe(aResult.versionId);
  });
});
