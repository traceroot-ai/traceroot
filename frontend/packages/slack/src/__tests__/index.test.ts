import { afterAll, describe, expect, it, vi } from "vitest";

// The installer pulls in @traceroot/core (Prisma) at import time; mock it so
// the smoke test only verifies the package entrypoint resolves and re-exports
// its API.
vi.mock("@traceroot/core", () => ({
  prisma: {},
  encryptKey: vi.fn(),
  decryptKey: vi.fn(),
}));

// The InstallProvider is constructed at import time from these env vars.
process.env.SLACK_CLIENT_ID ??= "smoke-test-client-id";
process.env.SLACK_CLIENT_SECRET ??= "smoke-test-client-secret";
process.env.SLACK_STATE_SECRET ??= "smoke-test-state-secret";

afterAll(() => {
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  delete process.env.SLACK_STATE_SECRET;
});

describe("@traceroot/slack entrypoint", () => {
  it("resolves and exposes the public API", async () => {
    const slack = await import("../index.ts");
    expect(typeof slack.createSlackClient).toBe("function");
    expect(typeof slack.getClientForTeam).toBe("function");
    expect(slack.installer).toBeDefined();
    expect(slack.installationStore).toBeDefined();
  });
});
