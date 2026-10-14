import { expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ env: {} }));

import { buildSignupSlackMessage, notifySignupSlack, type SignupSlackInput } from "./notify-slack";

const personUrl = "https://us.posthog.com/project/123/person/u1";
const facts = { city: "SF", region: "CA", country: "US", os: "OS", browser: "B", deviceType: "D" };
const input: SignupSlackInput = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  provider: "email",
  viaInvite: false,
  facts: { ...facts, referringDomain: "example.org", landingPath: "/pricing", personUrl },
  supportConsoleUrl: "https://app.example.com/admin",
  totalUsers: 1234,
};
const support = "<https://app.example.com/admin|Support console>";
const url = "https://hooks.slack.com/services/T/B/x";
const env = { TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL: url };
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

it("renders the who, facts, tail and total lines", () => {
  const { text, blocks } = buildSignupSlackMessage(input);
  expect(text).toBe("🎉 Ada Lovelace (ada@example.com), a new user has registered");
  expect(blocks).toEqual([
    section(text),
    section("SF, CA, US · OS · B · D · from example.org · landed on /pricing"),
    context(`via email · <${personUrl}|PostHog person> · ${support}`),
    context("1,234 total registered users"),
  ]);
});

it("drops the name, facts line, person link and total when absent", () => {
  const minimal = { ...input, name: "  ", viaInvite: true, facts: null, totalUsers: undefined };
  const { text, blocks } = buildSignupSlackMessage(minimal);
  expect(text).toBe("🎉 ada@example.com, a new user has registered");
  expect(blocks).toEqual([section(text), context(`via email · via invite · ${support}`)]);
});

it("escapes mrkdwn in user-controlled strings and caps them at 200 characters", () => {
  const patch = { name: `<b>&${"x".repeat(5_000)}`, facts: { city: "a<b", personUrl } };
  const { text, blocks } = buildSignupSlackMessage({ ...input, ...patch });
  const who = `&lt;b&gt;&amp;${"x".repeat(195)}… (ada@example.com)`;
  expect(text).toBe(`🎉 ${who}, a new user has registered`);
  expect(blocks[1]).toEqual(section("a&lt;b"));
});

it("returns false without fetching when no webhook is configured", async () => {
  const fetchImpl = vi.fn();
  await expect(notifySignupSlack(input, { fetchImpl, env: {} })).resolves.toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("posts the message as JSON, and throws on a non-2xx answer", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("ok"));
  await expect(notifySignupSlack(input, { fetchImpl, env })).resolves.toBe(true);
  const body = JSON.stringify(buildSignupSlackMessage(input));
  expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST", body }));
  fetchImpl.mockResolvedValueOnce(new Response("invalid_payload", { status: 400 }));
  await expect(notifySignupSlack(input, { fetchImpl, env })).rejects.toThrow("failed (400)");
});
