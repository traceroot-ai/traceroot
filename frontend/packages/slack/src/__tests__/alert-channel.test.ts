import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const hasEntitlement = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: { project: { findUnique: (args: unknown) => findUnique(args) } },
  hasEntitlement: (...args: unknown[]) => hasEntitlement(...args),
}));

const { resolveAlertChannel } = await import("../alert-channel.ts");

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  alertConfig: null,
  workspace: {
    billingPlan: "starter",
    slackIntegration: { channelId: "C_WORKSPACE", botToken: "enc-token" },
  },
  ...overrides,
});

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(projectRow());
  hasEntitlement.mockReset().mockReturnValue(true);
});

describe("resolveAlertChannel", () => {
  it("falls back to the workspace channel, with the token still encrypted", async () => {
    expect(await resolveAlertChannel("proj_1")).toEqual({
      ok: true,
      target: { channelId: "C_WORKSPACE", encryptedBotToken: "enc-token" },
    });
    // A deleted project must not be linked to in Slack.
    expect(findUnique.mock.calls[0][0]).toMatchObject({
      where: { id: "proj_1", deleteTime: null },
    });
  });

  it("prefers the project's own channel over the workspace default", async () => {
    findUnique.mockResolvedValue(projectRow({ alertConfig: { slackChannelId: "C_PROJECT" } }));
    expect(await resolveAlertChannel("proj_1")).toMatchObject({
      ok: true,
      target: { channelId: "C_PROJECT" },
    });
  });

  it.each([
    ["the project is gone", () => findUnique.mockResolvedValue(null), "project-missing"],
    [
      "the plan has no Slack",
      () => hasEntitlement.mockReturnValue(false),
      "no-entitlement plan=starter",
    ],
    [
      "no channel is set anywhere",
      () =>
        findUnique.mockResolvedValue(
          projectRow({
            workspace: {
              billingPlan: "starter",
              slackIntegration: { channelId: null, botToken: "enc-token" },
            },
          }),
        ),
      "no-channel",
    ],
    [
      "the install has no token",
      () =>
        findUnique.mockResolvedValue(
          projectRow({
            alertConfig: { slackChannelId: "C_PROJECT" },
            workspace: { billingPlan: "starter", slackIntegration: null },
          }),
        ),
      "no-bot-token",
    ],
  ])("says why when %s", async (_case, arrange, reason) => {
    arrange();
    expect(await resolveAlertChannel("proj_1")).toEqual({ ok: false, reason });
  });

  it("checks a workspace with no plan recorded as free", async () => {
    findUnique.mockResolvedValue(
      projectRow({
        workspace: {
          billingPlan: null,
          slackIntegration: { channelId: "C_WORKSPACE", botToken: "enc-token" },
        },
      }),
    );
    await resolveAlertChannel("proj_1");
    expect(hasEntitlement).toHaveBeenCalledWith("free", "slack-integration");
  });
});
