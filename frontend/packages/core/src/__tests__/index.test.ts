import { describe, expect, it, vi } from "vitest";

// Mock prisma so importing the barrel doesn't instantiate a real client.
vi.mock("../lib/prisma.ts", () => ({ prisma: {} }));

describe("@traceroot/core entrypoint", () => {
  it("resolves and exposes the public API", async () => {
    const core = await import("../index.ts");
    expect(typeof core.encryptKey).toBe("function");
    expect(typeof core.decryptKey).toBe("function");
    expect(typeof core.maskKey).toBe("function");
    expect(typeof core.resolveWorkspaceApiKey).toBe("function");
    expect(typeof core.getStripeOrThrow).toBe("function");
    expect(typeof core.syncStandardPrices).toBe("function");
    expect(typeof core.getModelPricing).toBe("function");
    expect(typeof core.calculateCost).toBe("function");
    expect(core.Role).toBeDefined();
  });
});
