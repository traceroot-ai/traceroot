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

  it("re-exports the offline-evaluation contract", async () => {
    // The public eval routes, the OpenAPI mirror and the UI all reach these
    // through `@traceroot/core`; a missing barrel line breaks every consumer.
    const core = await import("../index.ts");
    expect(core.PublishDatasetVersionRequestSchema).toBeDefined();
    expect(core.RegisterRunRequestSchema).toBeDefined();
    expect(core.UpsertResultRequestSchema).toBeDefined();
    expect(core.CreateTestCaseRequestSchema).toBeDefined();
    expect(core.UpdateDatasetRequestSchema).toBeDefined();
    expect(core.DATASET_VERSION_MAX_CHANGES).toBe(1000);
  });

  it("keeps Node-only modules off the barrel", async () => {
    // Client components import "@traceroot/core", so anything on the barrel is
    // bundled for the browser. rca-executions imports node:crypto and prisma,
    // which is why it ships as a subpath export instead — the same convention
    // pi-ai already follows. Re-adding it here breaks the client bundle in a
    // way that only shows up at build time.
    const barrel = await import("../index.ts");
    expect(Object.keys(barrel)).not.toContain("allocateExecution");
    expect(Object.keys(barrel)).not.toContain("applyCapturePolicy");

    const pkg = (await import("../../package.json", { with: { type: "json" } })).default as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./rca-executions"]).toBeDefined();
    expect(pkg.exports["./capture-policy"]).toBeDefined();
  });
});
