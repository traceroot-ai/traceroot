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
  emailLogoImg: (height: number) => `<img src="https://example.com/logo.png" height="${height}">`,
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
      subject: "Send your first trace",
      idempotencyKey: "welcome/u1",
      headers: { "List-Unsubscribe": "<x>" },
    });
    expect(email.text).toContain("Hi new,");
    expect(email.text).toContain("Best,\nXinwei He\nTraceRoot.AI | CEO\n");
    expect(email.text).not.toMatch(/devs/i);
    expect(email.text).toContain(`Unsubscribe from product emails: ${unsubscribeUrl}`);
    expect(email.html).toContain('href="https://app.example.com"');
    expect(email.text).toContain("pick a time on my calendar (https://cal.com/traceroot/30min)");
    expect(email.text).not.toContain("email from Slack");
  });

  it("sends the look-around version, with the demo project, when asked for it", async () => {
    deployment.cloud = true;
    await sendWelcomeEmail({ ...input, variant: "exploring" });
    const email = core.sendOnce.mock.calls[0][2]();
    expect(email.subject).toBe("A trace you can explore");
    expect(email.text).toContain(
      "Open the demo project: https://app.example.com/projects/demo/traces",
    );
  });

  it.each([
    ["switch off, work address", undefined, "kai@acme.com", false],
    ["switch on, work address", "true", "kai@acme.com", true],
    ["switch on, personal address", "true", "kai@gmail.com", false],
    ["switch on, school address", "true", "kai@cs.stanford.edu", false],
    ["switch on, school address abroad", "true", "kai@ox.ac.uk", false],
  ])("says a Slack invite is coming only when it is (%s)", async (_case, on, email, said) => {
    deployment.cloud = true;
    vi.stubEnv("WELCOME_SLACK_INVITE_LINE_ENABLED", on ?? "");
    await sendWelcomeEmail({ ...input, email });
    const built = core.sendOnce.mock.calls[0][2]();
    expect(built.text.includes("separate email from Slack")).toBe(said);
    vi.unstubAllEnvs();
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
