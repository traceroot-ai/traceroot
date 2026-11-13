import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const METERED = {
  STRIPE_PRICE_ID_AI_USAGE: "price_ai_usage",
  STRIPE_PRICE_ID_RCA_USAGE: "price_rca_usage",
  STRIPE_PRICE_ID_DETECTOR_USAGE: "price_detector_usage",
};

const item = (priceId: string) => ({ id: `si_${priceId}`, price: { id: priceId } });

// PLANS reads the plan price ids when the module loads, so each test imports it
// fresh after the env is stubbed.
async function load() {
  vi.resetModules();
  return import("../subscriptionItems.ts");
}

describe("findPlanItem", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_ID_STARTER", "price_starter");
    vi.stubEnv("STRIPE_PRICE_ID_PRO", "price_pro");
    for (const [name, value] of Object.entries(METERED)) vi.stubEnv(name, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds the plan item when a schedule phase transition moves it after the metered items", async () => {
    const { findPlanItem } = await load();
    const items = [
      item("price_ai_usage"),
      item("price_rca_usage"),
      item("price_detector_usage"),
      item("price_starter"),
    ];

    expect(findPlanItem(items)?.price.id).toBe("price_starter");
  });

  it("finds the plan item when it comes first, as on a fresh checkout", async () => {
    const { findPlanItem } = await load();
    const items = [
      item("price_pro"),
      item("price_ai_usage"),
      item("price_rca_usage"),
      item("price_detector_usage"),
    ];

    expect(findPlanItem(items)?.price.id).toBe("price_pro");
  });

  it("still finds the plan item when a metered price env var is missing", async () => {
    vi.stubEnv("STRIPE_PRICE_ID_RCA_USAGE", "");
    const { findPlanItem } = await load();
    const items = [item("price_ai_usage"), item("price_rca_usage"), item("price_starter")];

    expect(findPlanItem(items)?.price.id).toBe("price_starter");
  });

  it("returns undefined when every item is metered", async () => {
    const { findPlanItem } = await load();
    const items = [item("price_ai_usage"), item("price_rca_usage"), item("price_detector_usage")];

    expect(findPlanItem(items)).toBeUndefined();
  });

  it("falls back to the first non-metered item when no price matches a configured plan", async () => {
    const { findPlanItem } = await load();
    const items = [item("price_ai_usage"), item("price_legacy_plan")];

    expect(findPlanItem(items)?.price.id).toBe("price_legacy_plan");
  });
});

describe("getMeteredPriceIds", () => {
  it("collects the configured metered prices and skips unset ones", async () => {
    const { getMeteredPriceIds } = await load();

    expect(
      getMeteredPriceIds({
        STRIPE_PRICE_ID_AI_USAGE: "price_ai_usage",
        STRIPE_PRICE_ID_RCA_USAGE: "",
      }),
    ).toEqual(new Set(["price_ai_usage"]));
  });
});
