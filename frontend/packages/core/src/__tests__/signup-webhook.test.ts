import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildSignupsReplayedEvent,
  buildSignupWebhookEvent,
  isSignupWebhookConfigured,
  sendSignupWebhook,
  type SignupsReplayedEvent,
  type SignupWebhookEvent,
} from "../lib/signup-webhook.ts";

const now = 1_793_000_000_000;
const secret = "test-secret";
const config = { url: "https://receiver.example.com/events", secret };
const event = buildSignupWebhookEvent({
  user: { id: "u_123", email: "jane@example.com", name: null, createdAt: new Date(now - 5_000) },
  provider: "google",
  viaInvite: false,
  attribution: { utm_source: "newsletter", utm_medium: "email", utm_campaign: "november" },
});

interface Delivery {
  body: string;
  headers: Record<string, string>;
}

// What a receiver checks: a timestamp within five minutes of its own clock,
// then a constant-time match of the signature over "<timestamp>.<raw body>".
function accepts(delivery: Delivery, key: string | undefined, clock = now): boolean {
  if (!key) return false;
  const timestamp = delivery.headers["X-TraceRoot-Timestamp"];
  if (!/^\d+$/.test(timestamp) || Math.abs(clock / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", key).update(`${timestamp}.${delivery.body}`).digest();
  const actual = Buffer.from(delivery.headers["X-TraceRoot-Signature"], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function deliver(
  sent: SignupWebhookEvent | SignupsReplayedEvent = event,
  options: { config?: typeof config; timeoutMs?: number } = {},
) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const ok = await sendSignupWebhook(sent, options.config ?? config, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const [url, init] = fetchImpl.mock.calls[0];
  const delivery = {
    body: init?.body as string,
    headers: init?.headers as Record<string, string>,
  };
  return { ok, url, init, delivery };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("carries the user, how they signed up and three campaign fields, nothing else", () => {
  const built = buildSignupWebhookEvent({
    user: { id: "u1", email: "a@example.com", name: "A", createdAt: new Date(now) },
    provider: "email",
    viaInvite: true,
    attribution: {
      utm_source: "github",
      utm_content: "readme",
      utm_term: "tracing",
      marketing_touch_at: "2026-10-01T00:00:00.000Z",
      marketing_attribution_model: "last_campaign_touch",
    },
  });
  expect(built).toEqual({
    event: "user_signed_up",
    occurred_at: new Date(now).toISOString(),
    delivery: "live",
    user: { id: "u1", email: "a@example.com", name: "A" },
    signup: { provider: "email", via_invite: true, utm: { utm_source: "github" } },
  });
});

it("marks replayed sign-ups with their run, and summarizes a run by the users it covered", () => {
  const replayed = buildSignupWebhookEvent({
    user: { id: "u1", email: "a@example.com", name: null, createdAt: new Date(now) },
    provider: "google",
    viaInvite: false,
    delivery: "backfill",
    runId: "backfill-0123456789abcdef",
  });
  expect(replayed).toMatchObject({
    delivery: "backfill",
    run_id: "backfill-0123456789abcdef",
    signup: { utm: {} },
  });
  expect(event).not.toHaveProperty("run_id");
  expect(
    buildSignupsReplayedEvent({
      delivery: "reconcile",
      runId: "reconcile-2026-11-09",
      startedAt: new Date(now),
      userIds: ["u1", "u2"],
    }),
  ).toEqual({
    event: "signups_replayed",
    occurred_at: new Date(now).toISOString(),
    delivery: "reconcile",
    run_id: "reconcile-2026-11-09",
    user_ids: ["u1", "u2"],
  });
});

it.each([
  ["neither setting", {}],
  ["only the URL", { url: config.url }],
  ["only the secret", { secret }],
  ["a blank URL", { ...config, url: " " }],
  ["a blank secret", { ...config, secret: " " }],
])("sends nothing with %s", async (_, partial) => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(isSignupWebhookConfigured(partial)).toBe(false);
  await expect(sendSignupWebhook(event, partial, { fetchImpl })).resolves.toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("posts the event as JSON, signed over the exact bytes sent", async () => {
  const { ok, url, init, delivery } = await deliver();
  expect(ok).toBe(true);
  expect(isSignupWebhookConfigured(config)).toBe(true);
  expect(url).toBe(config.url);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(delivery.body)).toEqual(event);
  expect(delivery.headers).toEqual({
    "Content-Type": "application/json",
    "X-TraceRoot-Timestamp": String(now / 1000),
    "X-TraceRoot-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(accepts(delivery, secret)).toBe(true);
});

it("signs a replay summary the same way", async () => {
  const summary = buildSignupsReplayedEvent({
    delivery: "backfill",
    runId: "backfill-0123456789abcdef",
    startedAt: new Date(now),
    userIds: ["u1"],
  });
  const { delivery } = await deliver(summary, { timeoutMs: 10_000 });
  expect(JSON.parse(delivery.body)).toEqual(summary);
  expect(accepts(delivery, secret)).toBe(true);
});

it("fails a receiver's check once the body, signature or timestamp changes", async () => {
  const { delivery } = await deliver();
  const { headers } = delivery;
  const changed: Delivery[] = [
    { ...delivery, body: delivery.body.replace("u_123", "u_124") },
    { ...delivery, headers: { ...headers, "X-TraceRoot-Signature": "0".repeat(64) } },
    { ...delivery, headers: { ...headers, "X-TraceRoot-Timestamp": String(now / 1000 + 1) } },
  ];
  for (const tampered of changed) expect(accepts(tampered, secret)).toBe(false);
  expect(accepts(delivery, "other-secret")).toBe(false);
});

it("fails a receiver's check when it is stale or the receiver has no secret", async () => {
  const { delivery } = await deliver();
  expect(accepts(delivery, secret, now + 301_000)).toBe(false);
  expect(accepts(delivery, undefined)).toBe(false);
});

it("signs with the secret exactly as configured", async () => {
  const { delivery } = await deliver(event, { config: { ...config, secret: "s3\n" } });
  expect(accepts(delivery, "s3\n")).toBe(true);
  expect(accepts(delivery, "s3")).toBe(false);
});

it("throws on a non-2xx response so the caller logs it", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("no", { status: 500 }));
  await expect(sendSignupWebhook(event, config, { fetchImpl })).rejects.toThrow("failed (500)");
});
