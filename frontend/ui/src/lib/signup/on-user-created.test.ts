import { beforeEach, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  TRACEROOT_CLOUD: "true",
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: undefined as string | undefined,
}));
const inviteFindFirst = vi.hoisted(() => vi.fn());
const userCount = vi.hoisted(() => vi.fn());
const findPostHogPerson = vi.hoisted(() => vi.fn());
const notifySignupSlack = vi.hoisted(() => vi.fn());
vi.mock("@/env", () => ({ env: envState }));
vi.mock("@traceroot/core", () => ({
  prisma: { invite: { findFirst: inviteFindFirst }, user: { count: userCount } },
}));
vi.mock("./posthog-person", () => ({ findPostHogPerson }));
vi.mock("./notify-slack", () => ({ notifySignupSlack }));

import { isSignupHookEnabled, onUserCreated, signupProvider } from "./on-user-created";

const user = { id: "u1", email: "New@Example.com", name: "New User" };

beforeEach(() => {
  vi.clearAllMocks();
  envState.TRACEROOT_CLOUD = "true";
  envState.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";
  inviteFindFirst.mockResolvedValue({ id: "inv1" });
  findPostHogPerson.mockResolvedValue({ city: "SF", country: "US" });
  userCount.mockResolvedValue(154);
  notifySignupSlack.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("reads the provider from the endpoint path and the gate from TRACEROOT_CLOUD", () => {
  const paths = ["/sign-up/email", "/callback/Oidc", "/x", undefined];
  expect(paths.map((p) => signupProvider(p))).toEqual(["email", "oidc", "unknown", "unknown"]);
  expect(isSignupHookEnabled({ TRACEROOT_CLOUD: " TRUE " })).toBe(true);
  expect(isSignupHookEnabled({ TRACEROOT_CLOUD: "" })).toBe(false);
});

it.each([
  [{ TRACEROOT_CLOUD: "false" }, "/sign-up/email", inviteFindFirst],
  [{ TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: undefined }, "/sign-up/email", findPostHogPerson],
  [{}, "/admin/create-user", inviteFindFirst],
])(
  "runs no lookups and no post when the env is %o and the path %s",
  async (patch, path, lookup) => {
    Object.assign(envState, patch);
    await onUserCreated(user, { path });
    for (const fn of [lookup, userCount, notifySignupSlack]) expect(fn).not.toHaveBeenCalled();
  },
);

it("posts to Slack with the person's facts, the invite flag and the user count", async () => {
  await onUserCreated(user, { path: "/sign-up/email" });
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

it("never rejects: failed lookups, count and post are logged, and the count is omitted", async () => {
  for (const m of [inviteFindFirst, userCount, notifySignupSlack]) m.mockRejectedValue(new Error());
  await expect(onUserCreated(user, null)).resolves.toBeUndefined();
  const posted = notifySignupSlack.mock.calls[0][0];
  expect(posted).toMatchObject({ provider: "unknown", viaInvite: false, totalUsers: undefined });
  expect(console.error).toHaveBeenCalledTimes(3);
});
