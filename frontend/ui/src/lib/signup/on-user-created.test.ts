import { beforeEach, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: undefined as string | undefined,
  TRACEROOT_SIGNUP_WEBHOOK_URL: undefined as string | undefined,
  TRACEROOT_SIGNUP_WEBHOOK_SECRET: undefined as string | undefined,
}));
const inviteFindFirst = vi.hoisted(() => vi.fn());
const userCount = vi.hoisted(() => vi.fn());
const findPostHogPerson = vi.hoisted(() => vi.fn());
const notifySignupSlack = vi.hoisted(() => vi.fn());
const ensureContact = vi.hoisted(() => vi.fn());
const isProductMailConfigured = vi.hoisted(() => vi.fn());
const sendWelcomeEmail = vi.hoisted(() => vi.fn());
const ensureDemoMembership = vi.hoisted(() => vi.fn());
const sendSignupWebhook = vi.hoisted(() => vi.fn());
vi.mock("@/env", () => ({ env: envState }));
vi.mock("@/lib/demo-workspace", () => ({ ensureDemoMembership }));
vi.mock("@traceroot/core/email", () => ({ ensureContact, isProductMailConfigured }));
vi.mock("@/lib/email/welcome/send-welcome-email", () => ({ sendWelcomeEmail }));
vi.mock("@traceroot/core", () => ({
  prisma: { invite: { findFirst: inviteFindFirst }, user: { count: userCount } },
}));
vi.mock("./posthog-person", () => ({ findPostHogPerson }));
vi.mock("./notify-slack", () => ({ notifySignupSlack }));
vi.mock("@traceroot/core/signup-webhook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core/signup-webhook")>()),
  sendSignupWebhook,
}));

import { onUserCreated, signupProvider } from "./on-user-created";

const user = {
  id: "u1",
  email: "New@Example.com",
  name: "New User",
  createdAt: new Date("2026-11-04T08:00:00Z"),
};
const everything = [
  inviteFindFirst,
  findPostHogPerson,
  userCount,
  notifySignupSlack,
  ensureContact,
  sendWelcomeEmail,
  sendSignupWebhook,
];

function enableWebhook() {
  envState.TRACEROOT_SIGNUP_WEBHOOK_URL = "https://receiver.example.com/events";
  envState.TRACEROOT_SIGNUP_WEBHOOK_SECRET = "test-secret";
}

beforeEach(() => {
  vi.clearAllMocks();
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";
  envState.TRACEROOT_SIGNUP_WEBHOOK_URL = undefined;
  envState.TRACEROOT_SIGNUP_WEBHOOK_SECRET = undefined;
  isProductMailConfigured.mockReturnValue(true);
  inviteFindFirst.mockResolvedValue({ id: "inv1" });
  findPostHogPerson.mockResolvedValue({ city: "SF", country: "US" });
  userCount.mockResolvedValue(154);
  notifySignupSlack.mockResolvedValue(true);
  ensureContact.mockResolvedValue({ ok: true });
  sendSignupWebhook.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("reads the provider from the sign-up route", () => {
  // The context shapes better-auth passes the hook; attribution.integration.test.ts
  // checks them against its real handlers.
  const contexts = [
    { path: "/sign-up/email" },
    { path: "/callback/:id", params: { id: "Google" } },
    { path: "/callback/:id" },
    { path: "/x", params: { id: "google" } },
    null,
  ];
  expect(contexts.map((c) => signupProvider(c))).toEqual([
    "email",
    "google",
    "unknown",
    "unknown",
    "unknown",
  ]);
});

it("does nothing, and logs nothing, when nothing is configured", async () => {
  isProductMailConfigured.mockReturnValue(false);
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = undefined;
  await onUserCreated(user, { path: "/sign-up/email" });
  for (const fn of everything) expect(fn).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});

it("does nothing for a user created through the admin plugin", async () => {
  enableWebhook();
  await onUserCreated(user, { path: "/admin/create-user" });
  for (const fn of everything) expect(fn).not.toHaveBeenCalled();
});

it("adds every new account to the demo workspace, admin-created ones too", async () => {
  await onUserCreated(user, { path: "/sign-up/email" });
  await onUserCreated(user, { path: "/admin/create-user" });
  expect(ensureDemoMembership).toHaveBeenCalledTimes(2);
  expect(ensureDemoMembership).toHaveBeenCalledWith("u1");
});

it("runs only the welcome when Slack is unset, and only Slack when mail is unconfigured", async () => {
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = undefined;
  await onUserCreated(user, { path: "/sign-up/email" });
  expect(sendWelcomeEmail).toHaveBeenCalled();
  for (const fn of [inviteFindFirst, findPostHogPerson, notifySignupSlack]) {
    expect(fn).not.toHaveBeenCalled();
  }

  vi.clearAllMocks();
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";
  isProductMailConfigured.mockReturnValue(false);
  await onUserCreated(user, { path: "/sign-up/email" });
  expect(notifySignupSlack).toHaveBeenCalled();
  for (const fn of [ensureContact, sendWelcomeEmail]) expect(fn).not.toHaveBeenCalled();
});

it("records the contact, then sends the welcome and posts to Slack", async () => {
  await onUserCreated(user, { path: "/sign-up/email" });
  expect(ensureContact).toHaveBeenCalledWith({ email: user.email, name: "New User" });
  expect(sendWelcomeEmail).toHaveBeenCalledWith({
    userId: "u1",
    email: user.email,
    name: "New User",
  });
  expect(ensureContact.mock.invocationCallOrder[0]).toBeLessThan(
    sendWelcomeEmail.mock.invocationCallOrder[0],
  );
  expect(notifySignupSlack).toHaveBeenCalledWith({
    name: "New User",
    email: user.email,
    provider: "email",
    viaInvite: true,
    facts: { city: "SF", country: "US" },
    supportConsoleUrl: "https://app.example.com/admin",
    totalUsers: 154,
  });
});

it("names the provider of an OAuth sign-up in the Slack post", async () => {
  await onUserCreated(user, { path: "/callback/:id", params: { id: "google" } });
  expect(notifySignupSlack).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
});

it("sends the sign-up event, sharing one invite lookup with the Slack post", async () => {
  enableWebhook();
  const attribution = {
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "november",
    utm_content: "footer",
    marketing_attribution_model: "last_campaign_touch",
  };
  await onUserCreated(user, { path: "/callback/:id", params: { id: "google" }, attribution });
  expect(sendSignupWebhook).toHaveBeenCalledExactlyOnceWith(
    {
      event: "user_signed_up",
      occurred_at: "2026-11-04T08:00:00.000Z",
      delivery: "live",
      user: { id: "u1", email: "New@Example.com", name: "New User" },
      signup: {
        provider: "google",
        via_invite: true,
        utm: { utm_source: "newsletter", utm_medium: "email", utm_campaign: "november" },
      },
    },
    { url: "https://receiver.example.com/events", secret: "test-secret" },
  );
  expect(notifySignupSlack).toHaveBeenCalledWith(expect.objectContaining({ viaInvite: true }));
  expect(inviteFindFirst).toHaveBeenCalledTimes(1);
});

it.each([
  ["only the URL", { TRACEROOT_SIGNUP_WEBHOOK_URL: "https://receiver.example.com/events" }],
  ["only the secret", { TRACEROOT_SIGNUP_WEBHOOK_SECRET: "test-secret" }],
])("sends no sign-up event with %s set", async (_, partial) => {
  Object.assign(envState, partial);
  await onUserCreated(user, { path: "/sign-up/email" });
  expect(sendSignupWebhook).not.toHaveBeenCalled();
});

it("logs a failed sign-up event and still runs the other follow-ups", async () => {
  enableWebhook();
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = undefined;
  const error = new Error("receiver down");
  sendSignupWebhook.mockRejectedValue(error);
  await expect(onUserCreated(user, { path: "/sign-up/email" })).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalledWith("[signup] signup webhook failed for user u1:", error);
  expect(sendWelcomeEmail).toHaveBeenCalled();
  expect(ensureDemoMembership).toHaveBeenCalledWith("u1");
});

it("skips the welcome when the contact was not recorded; Slack still posts", async () => {
  ensureContact.mockResolvedValue({ ok: false });
  await onUserCreated(user, { path: "/sign-up/email" });
  expect(sendWelcomeEmail).not.toHaveBeenCalled();
  expect(notifySignupSlack).toHaveBeenCalled();
});

it("never rejects: failed arms are logged, the welcome is skipped and the count omitted", async () => {
  const arms = [inviteFindFirst, ensureContact, userCount, notifySignupSlack];
  for (const m of arms) m.mockRejectedValue(new Error());
  await expect(onUserCreated(user, null)).resolves.toBeUndefined();
  const posted = notifySignupSlack.mock.calls[0][0];
  expect(posted).toMatchObject({ provider: "unknown", viaInvite: false, totalUsers: undefined });
  expect(sendWelcomeEmail).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledTimes(4);
});
