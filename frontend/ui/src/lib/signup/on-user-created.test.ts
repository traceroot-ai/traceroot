import { beforeEach, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: undefined as string | undefined,
}));
const inviteFindFirst = vi.hoisted(() => vi.fn());
const userCount = vi.hoisted(() => vi.fn());
const findPostHogPerson = vi.hoisted(() => vi.fn());
const notifySignupSlack = vi.hoisted(() => vi.fn());
const ensureContact = vi.hoisted(() => vi.fn());
const isProductMailConfigured = vi.hoisted(() => vi.fn());
const sendWelcomeEmail = vi.hoisted(() => vi.fn());
const ensureDemoMembership = vi.hoisted(() => vi.fn());
vi.mock("@/env", () => ({ env: envState }));
vi.mock("@/lib/demo-workspace", () => ({ ensureDemoMembership }));
vi.mock("@traceroot/core/email", () => ({ ensureContact, isProductMailConfigured }));
vi.mock("@/lib/email/welcome/send-welcome-email", () => ({ sendWelcomeEmail }));
vi.mock("@traceroot/core", () => ({
  prisma: { invite: { findFirst: inviteFindFirst }, user: { count: userCount } },
}));
vi.mock("./posthog-person", () => ({ findPostHogPerson }));
vi.mock("./notify-slack", () => ({ notifySignupSlack }));

import { onUserCreated, signupProvider } from "./on-user-created";

const user = { id: "u1", email: "New@Example.com", name: "New User" };
const everything = [
  inviteFindFirst,
  findPostHogPerson,
  userCount,
  notifySignupSlack,
  ensureContact,
  sendWelcomeEmail,
];

beforeEach(() => {
  vi.clearAllMocks();
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";
  isProductMailConfigured.mockReturnValue(true);
  inviteFindFirst.mockResolvedValue({ id: "inv1" });
  findPostHogPerson.mockResolvedValue({ city: "SF", country: "US" });
  userCount.mockResolvedValue(154);
  notifySignupSlack.mockResolvedValue(true);
  ensureContact.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("reads the provider from the endpoint path", () => {
  const paths = ["/sign-up/email", "/callback/Oidc", "/x", undefined];
  expect(paths.map((p) => signupProvider(p))).toEqual(["email", "oidc", "unknown", "unknown"]);
});

it("does nothing, and logs nothing, when nothing is configured", async () => {
  isProductMailConfigured.mockReturnValue(false);
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = undefined;
  await onUserCreated(user, { path: "/sign-up/email" });
  for (const fn of everything) expect(fn).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});

it("does nothing for a user created through the admin plugin", async () => {
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
