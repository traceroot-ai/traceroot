import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  verifyUnsubscribeToken: vi.fn(),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@traceroot/core/email", () => core);
const account = vi.hoisted(() => ({ recordUnsubscribe: vi.fn(), emailChoiceTime: vi.fn() }));
vi.mock("@/lib/lifecycle/pause", () => account);
const sync = vi.hoisted(() => ({ syncEmailPreference: vi.fn(), setProviderTopic: vi.fn() }));
vi.mock("@/lib/lifecycle/email-preference-sync", () => sync);

import { GET, POST } from "./route";

const BASE = "https://app.example.com/api/email/unsubscribe";
const EMAIL = "someone@example.com";
const BYE = `You're unsubscribed. No more product emails will be sent to ${EMAIL}.`;
const BACK = "You're subscribed again.";
const FAILED = "Could not update your preference right now.";
const LATER = "It can take a few minutes to apply everywhere.";
const DECIDED = new Date("2026-12-01T10:00:00.000Z");
const form = (action: string) =>
  `<form method="post" action="/api/email/unsubscribe"><input type="hidden" name="t" value="good"><input type="hidden" name="action" value="${action}">`;
const headers = { "content-type": "application/x-www-form-urlencoded" };
const get = (query = "") => GET(new Request(`${BASE}${query}`));
const post = (body: string, query = "") =>
  POST(new Request(`${BASE}${query}`, { method: "POST", headers, body }));
const ONE_CLICK = ["List-Unsubscribe=One-Click", "?t=good"] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  core.verifyUnsubscribeToken.mockImplementation((t) => ({ valid: t === "good", email: EMAIL }));
  account.emailChoiceTime.mockResolvedValue(DECIDED);
  account.recordUnsubscribe.mockImplementation(async (_e: string, subscribed: boolean) => ({
    userId: "user_1",
    applied: true,
    subscribed,
  }));
  sync.syncEmailPreference.mockImplementation(async () => ({
    state: "applied",
    subscribed: account.recordUnsubscribe.mock.calls.at(-1)![1] as boolean,
  }));
  sync.setProviderTopic.mockResolvedValue("ok");
});

describe("recording the choice", () => {
  it.each([
    [...ONE_CLICK, false, BYE],
    ["t=good&action=opt_out", "", false, BYE],
    ["t=good&action=opt_in", "", true, BACK],
  ])(
    "POST %j%s records it on the account, then syncs the provider",
    async (body, query, subscribed, message) => {
      const response = await post(body, query);
      expect(response.status).toBe(200);
      expect(account.recordUnsubscribe).toHaveBeenCalledWith(EMAIL, subscribed, DECIDED);
      expect(sync.syncEmailPreference).toHaveBeenCalledWith("user_1", EMAIL);
      expect(account.recordUnsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
        sync.syncEmailPreference.mock.invocationCallOrder[0],
      );
      const html = await response.text();
      expect(html).toContain(message);
      expect(html.includes(form("opt_in"))).toBe(!subscribed);
      expect(html).not.toContain(LATER);
    },
  );

  it("stamps the choice with the database's clock, read once per request", async () => {
    await post(...ONE_CLICK);
    expect(account.emailChoiceTime).toHaveBeenCalledTimes(1);
    expect(account.recordUnsubscribe.mock.calls[0][2]).toBe(DECIDED);
  });

  it("keeps the address out of the log", async () => {
    await post(...ONE_CLICK);
    const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logged).toContain("user_1");
    expect(logged).not.toContain(EMAIL);
  });
});

describe("failures", () => {
  it.each([
    ["the account write", () => account.recordUnsubscribe.mockRejectedValue(new Error("db down"))],
    [
      "reading the database clock",
      () => account.emailChoiceTime.mockRejectedValue(new Error("db down")),
    ],
  ])("an error answer, and nothing at the provider, when %s fails", async (_case, arrange) => {
    arrange();
    for (const [body, query] of [ONE_CLICK, ["t=good&action=opt_in", ""]] as const) {
      const response = await post(body, query);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain(FAILED);
      expect(text).not.toContain(BYE);
      expect(text).not.toContain(BACK);
    }
    expect(sync.syncEmailPreference).not.toHaveBeenCalled();
    expect(sync.setProviderTopic).not.toHaveBeenCalled();
  });

  it("confirms an unsubscribe, saying it can take a few minutes, when the provider did not take it yet", async () => {
    sync.syncEmailPreference.mockResolvedValue({ state: "rejected" });
    const response = await post(...ONE_CLICK);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(BYE);
    expect(html).toContain(LATER);
  });

  it("treats a sync that throws like one that did not finish", async () => {
    sync.syncEmailPreference.mockRejectedValue(new Error("network"));
    const response = await post(...ONE_CLICK);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(LATER);
  });

  it("confirms a retry once the account write works again, and duplicates", async () => {
    account.recordUnsubscribe.mockRejectedValueOnce(new Error("db down"));
    expect((await post(...ONE_CLICK)).status).toBe(502);
    for (let i = 0; i < 2; i += 1) {
      const response = await post(...ONE_CLICK);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(BYE);
    }
  });
});

describe("a Subscribe again the provider has not taken", () => {
  it("says a refused one is on its way: the scheduled run sends it again", async () => {
    sync.syncEmailPreference.mockResolvedValue({ state: "rejected" });
    const html = await (await post("t=good&action=opt_in")).text();
    expect(html).toContain(BACK);
    expect(html).toContain(LATER);
  });

  it.each([
    ["queued behind another write", "queued", "couldn't confirm this one yet"],
    ["with no answer", "unknown", "may not have gone through"],
  ] as const)(
    "does not promise one %s, and offers the choice again",
    async (_case, state, says) => {
      sync.syncEmailPreference.mockResolvedValue({ state });
      const html = await (await post("t=good&action=opt_in")).text();
      expect(html).not.toContain(BACK);
      expect(html).toContain(says);
      expect(html).toContain(form("opt_in"));
    },
  );
});

describe("a choice that lands after a newer one", () => {
  it("shows the newer unsubscribe in force to a late Subscribe again", async () => {
    account.recordUnsubscribe.mockResolvedValue({
      userId: "user_1",
      applied: false,
      subscribed: false,
    });
    sync.syncEmailPreference.mockResolvedValue({ state: "applied", subscribed: false });
    const html = await (await post("t=good&action=opt_in")).text();
    expect(html).toContain(BYE);
    expect(html).not.toContain(BACK);
  });

  it("shows the newer Subscribe again in force to a late unsubscribe", async () => {
    account.recordUnsubscribe.mockResolvedValue({
      userId: "user_1",
      applied: false,
      subscribed: true,
    });
    sync.syncEmailPreference.mockResolvedValue({ state: "applied", subscribed: true });
    expect(await (await post(...ONE_CLICK)).text()).toContain(BACK);
  });
});

describe("an address with no account", () => {
  beforeEach(() => account.recordUnsubscribe.mockResolvedValue(null));

  it("sets the provider directly, the only place the choice is kept", async () => {
    expect((await post(...ONE_CLICK)).status).toBe(200);
    expect(sync.setProviderTopic).toHaveBeenCalledWith(EMAIL, "opt_out");
    expect(sync.syncEmailPreference).not.toHaveBeenCalled();
  });

  it("asks for another try when the provider fails", async () => {
    sync.setProviderTopic.mockResolvedValue("rejected");
    expect((await post(...ONE_CLICK)).status).toBe(502);
  });
});

it("GET renders the opt-out form for a valid token and writes nothing", async () => {
  const response = await get("?t=good");
  expect([response.status, response.headers.get("cache-control")]).toEqual([200, "no-store"]);
  const html = await response.text();
  expect(html).toContain(`Unsubscribe ${EMAIL} from product emails from TraceRoot?`);
  expect(html).toContain(form("opt_out"));
  expect(account.recordUnsubscribe).not.toHaveBeenCalled();
});

it.each(["", "?t=bad"])("GET answers 400 to a missing or invalid token (%j)", async (query) => {
  const response = await get(query);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("This unsubscribe link is not valid.");
});

it("POST answers an invalid token with an empty 200 and writes nothing", async () => {
  const response = await post("List-Unsubscribe=One-Click", "?t=bad");
  expect([response.status, await response.text()]).toEqual([200, ""]);
  expect(account.recordUnsubscribe).not.toHaveBeenCalled();
  expect(sync.setProviderTopic).not.toHaveBeenCalled();
});
