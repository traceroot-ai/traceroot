// Posts a signed "user_signed_up" event to TRACEROOT_SIGNUP_WEBHOOK_URL. Nothing
// is sent unless TRACEROOT_SIGNUP_WEBHOOK_SECRET is set too. The receiver
// checks X-TraceRoot-Signature: the hex HMAC-SHA256, under the secret, of the
// X-TraceRoot-Timestamp value (delivery time, Unix seconds), a period, and the
// exact body bytes.
import { createHmac } from "node:crypto";
import { env as realEnv } from "@/env";

// The only campaign fields that leave the app.
const UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign"] as const;
type UtmField = (typeof UTM_FIELDS)[number];

export interface SignupWebhookEvent {
  event: "user_signed_up";
  occurred_at: string;
  user: { id: string; email: string; name: string | null };
  signup: { provider: string; via_invite: boolean; utm: Partial<Record<UtmField, string>> };
}

export interface SignupWebhookInput {
  user: { id: string; email: string; name: string | null; createdAt: Date };
  provider: string;
  viaInvite: boolean;
  attribution?: Record<string, string>;
}

export type SignupWebhookEnv = Partial<
  Pick<typeof realEnv, "TRACEROOT_SIGNUP_WEBHOOK_URL" | "TRACEROOT_SIGNUP_WEBHOOK_SECRET">
>;

export interface SendSignupWebhookOptions {
  fetchImpl?: typeof fetch;
  env?: SignupWebhookEnv;
}

const WEBHOOK_TIMEOUT_MS = 3_000;

export function buildSignupWebhookEvent(input: SignupWebhookInput): SignupWebhookEvent {
  const utm: Partial<Record<UtmField, string>> = {};
  for (const field of UTM_FIELDS) {
    const value = input.attribution?.[field];
    if (value) utm[field] = value;
  }
  return {
    event: "user_signed_up",
    occurred_at: input.user.createdAt.toISOString(),
    user: { id: input.user.id, email: input.user.email, name: input.user.name },
    signup: { provider: input.provider, via_invite: input.viaInvite, utm },
  };
}

export async function sendSignupWebhook(
  event: SignupWebhookEvent,
  options: SendSignupWebhookOptions = {},
): Promise<boolean> {
  const e = options.env ?? realEnv;
  const url = e.TRACEROOT_SIGNUP_WEBHOOK_URL?.trim();
  // Checked for blankness but signed exactly as set: the receiver holds the
  // same bytes, so trimming here alone would break every signature.
  const secret = e.TRACEROOT_SIGNUP_WEBHOOK_SECRET;
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
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Sign-up webhook failed (${response.status})`);
  }
  return true;
}
