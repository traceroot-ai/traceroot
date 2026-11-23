import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}));
const core = vi.hoisted(() => ({
  sendOnce: vi.fn(),
  resendConfig: vi.fn(),
  signUnsubscribeToken: vi.fn(),
  unsubscribeHeaders: vi.fn(),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@traceroot/core/email", () => core);
const prisma = vi.hoisted(() => ({ emailSend: {} }));
vi.mock("@traceroot/core", () => ({
  prisma,
  escapeHtml: (s: string) => s,
  EMAIL_COLORS: { ink: "#0B1015", muted: "#5F646B" },
  EMAIL_FONT_STACK: "sans-serif",
  EMAIL_LOGO_URL: "https://example.com/logo.png",
  EMAIL_PIXEL_WORDMARK_URL: "https://example.com/pixel.png",
}));

const deployment = vi.hoisted(() => ({ cloud: false, mode: "off" }));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => deployment.cloud }));
vi.mock("@/lib/lifecycle/follow-up-job", () => ({ followUpMode: () => deployment.mode }));
vi.mock("../demo-link", () => ({
  demoProjectUrl: async (appUrl: string) => `${appUrl}/projects/demo/traces`,
}));

import { sendWelcomeEmail } from "./send-welcome-email";

const input = { userId: "u1", email: "New@Example.com", name: "new user" };
const replyTo = "hello@example.com";
const unsubscribeUrl = "https://app.example.com/api/email/unsubscribe?t=tok.sig";
beforeEach(() => {
  vi.resetAllMocks();
  deployment.cloud = false;
  deployment.mode = "off";
  core.sendOnce.mockResolvedValue({ status: "sent", id: "email1" });
  core.resendConfig.mockReturnValue({ from: "me@example.com", replyTo });
  core.signUnsubscribeToken.mockReturnValue("tok.sig");
  core.unsubscribeHeaders.mockReturnValue({ "List-Unsubscribe": "<x>" });
});

it("self-hosted: sends the original welcome, signed by the team", async () => {
  expect(await sendWelcomeEmail(input)).toEqual({ status: "sent", id: "email1" });
  const [db, key, build] = core.sendOnce.mock.calls[0];
  expect(db).toBe(prisma);
  expect(key).toEqual({ userId: "u1", campaign: "welcome", kind: "product" });
  const email = build();
  expect(email).toMatchObject({
    to: "New@Example.com",
    subject: "Making the most of traceroot",
    kind: "product",
    replyTo,
    idempotencyKey: "welcome/u1",
    headers: { "List-Unsubscribe": "<x>" },
  });
  expect(core.signUnsubscribeToken).toHaveBeenCalledWith("New@Example.com");
  expect(core.unsubscribeHeaders).toHaveBeenCalledWith({ url: unsubscribeUrl, mailto: replyTo });
  expect(email.text).toContain("Hi new,");
  expect(email.text).toContain("Best,\nThe traceroot Devs\n");
  expect(email.text).toContain(unsubscribeUrl);
  const other = { emailSend: {} } as never;
  const fetchImpl = vi.fn() as never;
  await sendWelcomeEmail(input, { db: other, fetchImpl });
  expect(core.sendOnce).toHaveBeenLastCalledWith(other, key, expect.any(Function), { fetchImpl });
});

describe("on the cloud service", () => {
  it("sends the founder's welcome, signed by Xinwei, with the unsubscribe link", async () => {
    deployment.cloud = true;
    await sendWelcomeEmail(input);
    const [, key, build] = core.sendOnce.mock.calls[0];
    expect(key).toEqual({ userId: "u1", campaign: "welcome", kind: "product" });
    const email = build();
    expect(email).toMatchObject({
      subject: "Send your first trace to traceroot",
      idempotencyKey: "welcome/u1",
      headers: { "List-Unsubscribe": "<x>" },
    });
    expect(email.text).toContain("Hi new,");
    expect(email.text).toContain("Best,\nXinwei He\nTraceRoot.AI | CEO\n");
    expect(email.text).not.toMatch(/devs/i);
    expect(email.text).toContain(
      `If you don't want to hear from us again, let us know: ${unsubscribeUrl}`,
    );
    expect(email.text).toContain("https://app.example.com/projects/demo/traces");
    // The Slack invite line waits for the invite switch and a work address.
    expect(email.text).not.toContain("invite from Slack");
  });

  it.each([
    ["off", false],
    ["dry_run", false],
    ["send", true],
  ])("promises the follow-ups only while they are being sent (%s)", async (mode, promised) => {
    deployment.cloud = true;
    deployment.mode = mode;
    await sendWelcomeEmail(input);
    const email = core.sendOnce.mock.calls[0][2]();
    expect(email.text.includes("Over the next few weeks")).toBe(promised);
  });
});
