import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  verifyUnsubscribeToken: vi.fn(),
  ensureContact: vi.fn(),
  setTopicSubscription: vi.fn(),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@traceroot/core/email", () => core);
const account = vi.hoisted(() => ({ recordUnsubscribe: vi.fn() }));
vi.mock("@/lib/lifecycle/pause", () => account);

import { GET, POST } from "./route";

const BASE = "https://app.example.com/api/email/unsubscribe";
const EMAIL = "someone@example.com";
const BYE = `You're unsubscribed. No more product emails will be sent to ${EMAIL}.`;
const form = (action: string) =>
  `<form method="post" action="/api/email/unsubscribe"><input type="hidden" name="t" value="good"><input type="hidden" name="action" value="${action}">`;
const headers = { "content-type": "application/x-www-form-urlencoded" };
const get = (query = "") => GET(new Request(`${BASE}${query}`));
const post = (body: string, query = "") =>
  POST(new Request(`${BASE}${query}`, { method: "POST", headers, body }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  core.verifyUnsubscribeToken.mockImplementation((t) => ({ valid: t === "good", email: EMAIL }));
  core.ensureContact.mockResolvedValue({ ok: true });
  core.setTopicSubscription.mockResolvedValue({ ok: true });
  account.recordUnsubscribe.mockImplementation(async (_email: string, subscribed: boolean) => ({
    userId: "user_1",
    applied: true,
    subscribed,
  }));
});

it.each([
  ["List-Unsubscribe=One-Click", "?t=good", false],
  ["t=good&action=opt_out", "", false],
  ["t=good&action=opt_in", "", true],
])("POST %j%s records the choice on the account too", async (body, query, subscribed) => {
  await post(body, query);
  expect(account.recordUnsubscribe).toHaveBeenCalledWith(EMAIL, subscribed, expect.any(Date));
});

it("POST keeps the address out of the log", async () => {
  await post("List-Unsubscribe=One-Click", "?t=good");
  const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
  expect(logged).toContain("user_1");
  expect(logged).not.toContain(EMAIL);
});

const FAILED = "Could not update your preference right now.";
const order = () =>
  [account.recordUnsubscribe, core.setTopicSubscription]
    .map((fn) => ({ fn, at: fn.mock.invocationCallOrder[0] }))
    .filter((c) => c.at !== undefined)
    .sort((a, b) => a.at! - b.at!)
    .map((c) => (c.fn === account.recordUnsubscribe ? "account" : "provider"));

it("POST writes an opt-out on the account before the provider, a resubscribe after it", async () => {
  await post("List-Unsubscribe=One-Click", "?t=good");
  expect(order()).toEqual(["account", "provider"]);
  vi.clearAllMocks();
  await post("t=good&action=opt_in");
  expect(order()).toEqual(["provider", "account"]);
});

it("POST answers an error, not a confirmation, when the account write fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  account.recordUnsubscribe.mockRejectedValue(new Error("db down"));
  const optOut = await post("List-Unsubscribe=One-Click", "?t=good");
  expect(optOut.status).toBe(502);
  const text = await optOut.text();
  expect(text).toContain(FAILED);
  expect(text).not.toContain(BYE);
  // Nothing reached the provider, so the person's state is unchanged everywhere.
  expect(core.setTopicSubscription).not.toHaveBeenCalled();

  const optIn = await post("t=good&action=opt_in");
  expect(optIn.status).toBe(502);
  expect(await optIn.text()).not.toContain("You're subscribed again.");
});

it("POST keeps an opt-out recorded on the account when the provider then fails", async () => {
  core.setTopicSubscription.mockResolvedValue({ ok: false });
  const response = await post("List-Unsubscribe=One-Click", "?t=good");
  expect(response.status).toBe(502);
  expect(account.recordUnsubscribe).toHaveBeenCalledWith(EMAIL, false, expect.any(Date));
});

it("POST leaves the account unsubscribed when the provider refuses a resubscribe", async () => {
  core.setTopicSubscription.mockResolvedValue({ ok: false });
  expect((await post("t=good&action=opt_in")).status).toBe(502);
  expect(account.recordUnsubscribe).not.toHaveBeenCalled();
});

it("POST answers an error when the provider call throws", async () => {
  core.setTopicSubscription.mockRejectedValue(new Error("network"));
  expect((await post("List-Unsubscribe=One-Click", "?t=good")).status).toBe(502);
});

it("POST confirms on a retry once the account write works again, and on duplicates", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  account.recordUnsubscribe.mockRejectedValueOnce(new Error("db down"));
  expect((await post("List-Unsubscribe=One-Click", "?t=good")).status).toBe(502);
  for (let i = 0; i < 2; i += 1) {
    const response = await post("List-Unsubscribe=One-Click", "?t=good");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(BYE);
  }
  expect(account.recordUnsubscribe).toHaveBeenCalledTimes(3);
  expect(core.setTopicSubscription).toHaveBeenCalledTimes(2);
});

it("GET renders the opt-out form for a valid token and writes nothing", async () => {
  const response = await get("?t=good");
  expect([response.status, response.headers.get("cache-control")]).toEqual([200, "no-store"]);
  const html = await response.text();
  expect(html).toContain(`Unsubscribe ${EMAIL} from product emails from traceroot?`);
  expect(html).toContain(form("opt_out"));
  expect(core.ensureContact).not.toHaveBeenCalled();
});

it.each(["", "?t=bad"])("GET answers 400 to a missing or invalid token (%j)", async (query) => {
  const response = await get(query);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("This unsubscribe link is not valid.");
});

it.each([
  ["List-Unsubscribe=One-Click", "?t=good", "opt_out", BYE, true],
  ["t=good&action=opt_in", "", "opt_in", "You're subscribed again.", false],
])("POST %j%s records %s", async (body, query, action, message, again) => {
  const response = await post(body, query);
  expect(response.status).toBe(200);
  expect(core.ensureContact).toHaveBeenCalledWith({ email: EMAIL });
  expect(core.setTopicSubscription).toHaveBeenCalledWith(EMAIL, action);
  const html = await response.text();
  expect(html).toContain(message);
  expect(html.includes(form("opt_in"))).toBe(again);
});

it("POST answers an invalid token with an empty 200 and writes nothing", async () => {
  const response = await post("List-Unsubscribe=One-Click", "?t=bad");
  expect([response.status, await response.text()]).toEqual([200, ""]);
  expect(core.ensureContact).not.toHaveBeenCalled();
});

it.each(["ensureContact", "setTopicSubscription"] as const)("502 when %s fails", async (fn) => {
  core[fn].mockResolvedValue({ ok: false });
  expect((await post("t=good&action=opt_out")).status).toBe(502);
  expect(core.setTopicSubscription).toHaveBeenCalledTimes(fn === "ensureContact" ? 0 : 1);
});

describe("a choice that lands after a newer one", () => {
  const newer = (subscribed: boolean) =>
    account.recordUnsubscribe.mockResolvedValue({ userId: "user_1", applied: false, subscribed });
  const providerCalls = () => core.setTopicSubscription.mock.calls.map((c) => c[1]);

  it("sets the provider back when a late Subscribe again finds a newer unsubscribe", async () => {
    newer(false);
    const response = await post("t=good&action=opt_in");
    expect(response.status).toBe(200);
    expect(providerCalls()).toEqual(["opt_in", "opt_out"]);
    const html = await response.text();
    expect(html).toContain(BYE);
    expect(html).not.toContain("You're subscribed again.");
  });

  it("leaves the provider subscribed when a late unsubscribe finds a newer Subscribe again", async () => {
    newer(true);
    const response = await post("List-Unsubscribe=One-Click", "?t=good");
    expect(response.status).toBe(200);
    expect(providerCalls()).toEqual(["opt_in"]);
    expect(await response.text()).toContain("You're subscribed again.");
  });

  it("answers an error when the provider cannot be set back, so it can be retried", async () => {
    newer(false);
    core.setTopicSubscription
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    expect((await post("t=good&action=opt_in")).status).toBe(502);
  });

  it("passes the time the request arrived as when the choice was made", async () => {
    const before = Date.now();
    await post("List-Unsubscribe=One-Click", "?t=good");
    const decidedAt = account.recordUnsubscribe.mock.calls[0][2] as Date;
    expect(decidedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(decidedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
