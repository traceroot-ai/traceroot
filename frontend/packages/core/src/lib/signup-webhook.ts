/**
 * The signed events sent to TRACEROOT_SIGNUP_WEBHOOK_URL. The web app's
 * sign-up hook sends one `user_signed_up` per self-service sign-up as it
 * happens (delivery "live"). The worker replays sign-ups the live send may
 * have missed (weekly, "reconcile") and, once, existing users ("backfill"),
 * and ends each replay with a `signups_replayed` summary of the users it
 * covered. Nothing is sent unless both the URL and the secret are set.
 *
 * X-TraceRoot-Signature is the hex HMAC-SHA256, under the secret, of the
 * X-TraceRoot-Timestamp value (delivery time, Unix seconds), a period, and
 * the exact body bytes. The secret is checked for blankness but used exactly
 * as set: the receiver holds the same bytes, so trimming here alone would
 * break every signature.
 */
import { createHmac } from "node:crypto";

export type SignupDelivery = "live" | "backfill" | "reconcile";

// The only campaign fields that leave the app.
const UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign"] as const;
type UtmField = (typeof UTM_FIELDS)[number];

export interface SignupWebhookEvent {
  event: "user_signed_up";
  occurred_at: string;
  delivery: SignupDelivery;
  user: { id: string; email: string; name: string | null };
  signup: { provider: string; via_invite: boolean; utm: Partial<Record<UtmField, string>> };
}

export interface SignupsReplayedEvent {
  event: "signups_replayed";
  occurred_at: string;
  delivery: Exclude<SignupDelivery, "live">;
  window: { from: string; to: string };
  user_ids: string[];
}

export interface SignupWebhookInput {
  user: { id: string; email: string; name: string | null; createdAt: Date };
  provider: string;
  viaInvite: boolean;
  attribution?: Record<string, string>;
  delivery?: SignupDelivery;
}

export interface SignupWebhookConfig {
  url?: string;
  secret?: string;
}

export function isSignupWebhookConfigured(config: SignupWebhookConfig): boolean {
  return Boolean(config.url?.trim() && config.secret?.trim());
}

export function buildSignupWebhookEvent(input: SignupWebhookInput): SignupWebhookEvent {
  const utm: Partial<Record<UtmField, string>> = {};
  for (const field of UTM_FIELDS) {
    const value = input.attribution?.[field];
    if (value) utm[field] = value;
  }
  return {
    event: "user_signed_up",
    occurred_at: input.user.createdAt.toISOString(),
    delivery: input.delivery ?? "live",
    user: { id: input.user.id, email: input.user.email, name: input.user.name },
    signup: { provider: input.provider, via_invite: input.viaInvite, utm },
  };
}

export function buildSignupsReplayedEvent(input: {
  delivery: Exclude<SignupDelivery, "live">;
  startedAt: Date;
  from: Date;
  to: Date;
  userIds: string[];
}): SignupsReplayedEvent {
  return {
    event: "signups_replayed",
    occurred_at: input.startedAt.toISOString(),
    delivery: input.delivery,
    window: { from: input.from.toISOString(), to: input.to.toISOString() },
    user_ids: input.userIds,
  };
}

export interface SendSignupWebhookOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function sendSignupWebhook(
  event: SignupWebhookEvent | SignupsReplayedEvent,
  config: SignupWebhookConfig,
  options: SendSignupWebhookOptions = {},
): Promise<boolean> {
  const url = config.url?.trim();
  const secret = config.secret;
  if (!url || !secret?.trim()) return false;

  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TraceRoot-Timestamp": timestamp,
      "X-TraceRoot-Signature": signature,
    },
    body,
    // A redirect would carry the signed event to a host nobody configured.
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
  });
  if (!response.ok) {
    throw new Error(`Sign-up webhook failed (${response.status})`);
  }
  return true;
}
