import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() =>
  vi.fn(async (args: { create: { id: string } }) => ({ id: args.create.id })),
);
const count = vi.hoisted(() => vi.fn(async () => 0));
const createMany = vi.hoisted(() =>
  vi.fn(async (_args: { data: { modelId: string; usageType: string; price: number }[] }) => ({
    count: 0,
  })),
);

vi.mock("../lib/prisma", () => ({
  prisma: {
    standardModel: { upsert },
    standardModelPrice: { count, createMany },
    $transaction: async (
      fn: (tx: {
        standardModel: { upsert: typeof upsert };
        standardModelPrice: { count: typeof count; createMany: typeof createMany };
      }) => Promise<unknown>,
    ) =>
      fn({
        standardModel: { upsert },
        standardModelPrice: { count, createMany },
      }),
  },
}));

import { syncStandardPrices } from "../model-pricing/sync-standard-prices.ts";

type UpsertArgs = {
  create: { modelName: string; regionalPremium: number | null };
  update: { regionalPremium: number | null };
};

beforeEach(() => {
  upsert.mockClear();
  count.mockClear();
  createMany.mockClear();
});

describe("syncStandardPrices", () => {
  it("writes the regional premium on create and on update", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await syncStandardPrices();

    const calls = upsert.mock.calls.map((call) => call[0] as unknown as UpsertArgs);
    const sonnet46 = calls.find((args) => args.create.modelName === "claude-sonnet-4-6");
    expect(sonnet46?.create.regionalPremium).toBe(1.1);
    expect(sonnet46?.update.regionalPremium).toBe(1.1);

    const sonnet4 = calls.find((args) => args.create.modelName === "claude-sonnet-4");
    expect(sonnet4?.create.regionalPremium).toBeNull();
    expect(sonnet4?.update.regionalPremium).toBeNull();
  });
});
