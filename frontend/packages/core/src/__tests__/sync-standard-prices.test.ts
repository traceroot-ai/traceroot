import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() =>
  vi.fn(async (args: { create: { id: string } }) => ({ id: args.create.id })),
);
const count = vi.hoisted(() => vi.fn(async () => 0));
const createMany = vi.hoisted(() => vi.fn(async () => ({ count: 0 })));

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
  create: {
    modelName: string;
    regionalPremium: number | null;
    longContextThreshold: number | null;
    prices: { create: { usageType: string; price: number }[] };
  };
  update: { longContextThreshold: number | null; regionalPremium: number | null };
};

beforeEach(() => {
  upsert.mockClear();
  count.mockClear();
  createMany.mockClear();
});

describe("syncStandardPrices", () => {
  it("writes the long-context threshold and the long rate rows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await syncStandardPrices();

    const calls = upsert.mock.calls.map((call) => call[0] as UpsertArgs);
    const haiku = calls.find((args) => args.create.modelName === "claude-haiku-5-5");
    expect(haiku).toBeDefined();
    expect(haiku?.create.longContextThreshold).toBe(100_000);
    expect(haiku?.update.longContextThreshold).toBe(100_000);
    expect(haiku?.create.regionalPremium).toBe(1.1);
    const types = haiku?.create.prices.create.map((row) => row.usageType);
    expect(types).toContain("input_long");
    expect(types).toContain("cacheWrite1h_long");

    const older = calls.find((args) => args.create.modelName === "claude-haiku-4-5");
    expect(older?.create.longContextThreshold).toBeNull();
    expect(older?.create.prices.create.map((row) => row.usageType)).not.toContain("input_long");
  });
});
