import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file; using vi.hoisted ensures the
// mock fns are initialized before the factory closure runs.
const { upsert, findFirst, deleteMany } = vi.hoisted(() => ({
  upsert: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
}));

// @traceroot/core uses a single barrel export — prisma, encryptKey, decryptKey all come from "@traceroot/core".
vi.mock("@traceroot/core", () => ({
  prisma: { slackIntegration: { upsert, findFirst, deleteMany } },
  encryptKey: (s: string) => `enc(${s})`,
  decryptKey: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
}));

process.env.SLACK_CLIENT_ID = "test";
process.env.SLACK_CLIENT_SECRET = "test";
process.env.SLACK_STATE_SECRET = "test";

describe("installationStore", () => {
  beforeEach(() => {
    upsert.mockReset();
    findFirst.mockReset();
    deleteMany.mockReset();
  });

  afterAll(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_STATE_SECRET;
  });

  it("storeInstallation encrypts the bot token and upserts the row", async () => {
    const { installationStore } = await import("../installer");
    upsert.mockResolvedValue({});
    await installationStore.storeInstallation({
      team: { id: "T1", name: "Acme" },
      bot: { token: "xoxb-secret", userId: "U1" },
      metadata: JSON.stringify({ workspaceId: "ws_1", connectedByUserId: "u_1" }),
    } as any);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "ws_1" });
    expect(arg.create.botToken).toBe("enc(xoxb-secret)");
    expect(arg.create.connectedByUserId).toBe("u_1");
    expect(arg.create.teamId).toBe("T1");
    expect(arg.create.teamName).toBe("Acme");
    expect(arg.update.botToken).toBe("enc(xoxb-secret)");
  });

  it("fetchInstallation decrypts the token and returns Installation shape", async () => {
    const { installationStore } = await import("../installer");
    findFirst.mockResolvedValue({
      teamId: "T1",
      teamName: "Acme",
      botUserId: "U1",
      botToken: "enc(xoxb-secret)",
    });
    const inst = await installationStore.fetchInstallation({ teamId: "T1" } as any);
    expect((inst as any).team.id).toBe("T1");
    expect((inst as any).bot.token).toBe("xoxb-secret");
  });

  it("deleteInstallation removes rows for the team", async () => {
    const { installationStore } = await import("../installer");
    deleteMany.mockResolvedValue({ count: 1 });
    await installationStore.deleteInstallation!({ teamId: "T1" } as any);
    expect(deleteMany).toHaveBeenCalledWith({ where: { teamId: "T1" } });
  });
});
