import { afterEach, expect, it, vi } from "vitest";
vi.mock("@traceroot/core", () => ({ prisma: {}, Role: { ADMIN: "ADMIN" } }));
import { demoProjectUrl } from "./demo-link";
afterEach(() => vi.unstubAllEnvs());
it("sends demo email links to the explicit join page", async () => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  expect(await demoProjectUrl("https://app.example.com")).toBe("https://app.example.com/demo");
});
it("uses the app when this deployment has no demo", async () => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "");
  expect(await demoProjectUrl("https://self.example.com")).toBe("https://self.example.com");
});
it("preserves a configured app path prefix", async () => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  expect(await demoProjectUrl("https://self.example.com/traceroot/")).toBe(
    "https://self.example.com/traceroot/demo",
  );
});
