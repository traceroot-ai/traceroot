import { beforeEach, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  verifyUnsubscribeToken: vi.fn(),
  ensureContact: vi.fn(),
  setTopicSubscription: vi.fn(),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@traceroot/core/email", () => core);

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
});

it("GET renders the opt-out form for a valid token and writes nothing", async () => {
  const response = await get("?t=good");
  expect([response.status, response.headers.get("cache-control")]).toEqual([200, "no-store"]);
  const html = await response.text();
  expect(html).toContain(`Unsubscribe ${EMAIL} from product emails from TraceRoot?`);
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
