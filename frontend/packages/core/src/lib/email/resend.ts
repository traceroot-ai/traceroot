// Resend client: sending email, plus the contact and topic calls that make opt-out work.
// `sendEmail` throws on a provider error because the caller owns the retry decision. The
// contact calls never throw: they log one `[resend]` line (never the key) and return {ok:false}.
// Product mail needs a topic (opt-out) and always carries the postal footer (legal).

import { normalizeEmail } from "./unsubscribe.ts";

const RESEND_API_URL = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 10_000;
/** Resend accepts only [A-Za-z0-9_-] in tag values. */
const TAG_VALUE_UNSAFE = /[^A-Za-z0-9_-]/g;

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

/** The address inside `Name <addr>`, or the whole string when it is bare. */
function bareAddress(from: string): string {
  const open = from.lastIndexOf("<");
  const close = from.indexOf(">", open);
  return open !== -1 && close !== -1 ? from.slice(open + 1, close).trim() : from.trim();
}

export interface ResendConfig {
  apiKey?: string;
  from?: string;
  replyTo?: string;
  productTopicId?: string;
}

export function resendConfig(env: NodeJS.ProcessEnv = process.env): ResendConfig {
  const from = nonBlank(env.TRACEROOT_EMAIL_FROM) ?? nonBlank(env.TRACEROOT_SMTP_MAIL_FROM);
  const fromAddress = from && bareAddress(from);
  return {
    apiKey: nonBlank(env.RESEND_API_KEY),
    from,
    replyTo: nonBlank(env.TRACEROOT_EMAIL_REPLY_TO) ?? fromAddress,
    productTopicId: nonBlank(env.RESEND_PRODUCT_TOPIC_ID),
  };
}

export interface ResendOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

type ApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; detail: string };

/** Never throws; the error body is capped so a log line stays a line. */
async function request(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  opts: { apiKey: string; fetchImpl: typeof fetch; headers?: Record<string, string> },
): Promise<ApiResult> {
  let response: Response;
  try {
    response = await opts.fetchImpl(`${RESEND_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: null, detail: String(error).slice(0, 300) };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: response.status, detail };
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  return { ok: true, status: response.status, body: parsed };
}

function describeFailure(result: { status: number | null; detail: string }): string {
  return `(${result.status ?? "network error"}): ${result.detail}`;
}

function warn(action: string, result: { status: number | null; detail: string }): void {
  console.warn(`[resend] ${action} failed ${describeFailure(result)}`);
}

export type EmailKind = "transactional" | "product";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: EmailKind;
  replyTo?: string;
  /** Resend returns the original id for a repeat within 24h, so a retry cannot double-deliver. */
  idempotencyKey?: string;
  tags?: Record<string, string>;
  headers?: Record<string, string>;
}

const POSTAL_ADDRESS = "989 Market St, San Francisco, CA 94103";

/** Product mail carries the postal address in both bodies, so the legal footer cannot be forgotten by a caller. */
function withProductFooter(email: Pick<OutboundEmail, "text" | "html">): {
  text: string;
  html?: string;
} {
  const text = `${email.text.trimEnd()}\n\nTraceRoot, Inc. · ${POSTAL_ADDRESS}`;
  if (!email.html) return { text };
  const footer = `<p style="font-size:12px;color:#777">TraceRoot, Inc. · ${POSTAL_ADDRESS}</p>`;
  const close = email.html.lastIndexOf("</body>");
  const html =
    close === -1
      ? `${email.html}${footer}`
      : `${email.html.slice(0, close)}${footer}${email.html.slice(close)}`;
  return { text, html };
}

export type SendSkipReason = "no-api-key" | "no-sender" | "product-requires-topic";

export type SendResult = { sent: true; id: string } | { sent: false; reason: SendSkipReason };

/** A 200 from /emails means accepted, not delivered; the outcome is `last_event` on the email. */
export async function sendEmail(
  email: OutboundEmail,
  options: ResendOptions = {},
): Promise<SendResult> {
  const config = resendConfig(options.env);
  if (!config.apiKey) return { sent: false, reason: "no-api-key" };
  if (!config.from) return { sent: false, reason: "no-sender" };
  // Product mail needs the topic: the topic is what enforces the recipient's opt-out.
  if (email.kind === "product" && !config.productTopicId) {
    return { sent: false, reason: "product-requires-topic" };
  }

  const headers: Record<string, string> = {};
  if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey;

  const { text, html } = email.kind === "product" ? withProductFooter(email) : email;
  const body: Record<string, unknown> = {
    from: config.from,
    to: [email.to],
    subject: email.subject,
    text,
  };
  if (html) body.html = html;
  const replyTo = email.replyTo ?? config.replyTo;
  if (replyTo) body.reply_to = replyTo;
  if (email.headers && Object.keys(email.headers).length > 0) body.headers = email.headers;
  if (email.tags && Object.keys(email.tags).length > 0) {
    body.tags = Object.entries(email.tags).map(([name, value]) => ({
      name,
      value: value.replace(TAG_VALUE_UNSAFE, "_"),
    }));
  }
  if (email.kind === "product") body.topic_id = config.productTopicId;

  const result = await request("POST", "/emails", body, {
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    headers,
  });
  if (!result.ok) throw new Error(`Resend send failed ${describeFailure(result)}`);
  const payload = result.body as { id?: string } | null;
  if (!payload?.id) throw new Error("Resend send succeeded without an email id");
  return { sent: true, id: payload.id };
}

export type TopicSubscription = "opt_in" | "opt_out";

export function splitName(name: string | null | undefined): { first?: string; last?: string } {
  const trimmed = name?.trim();
  if (!trimmed) return {};
  const space = trimmed.indexOf(" ");
  if (space === -1) return { first: trimmed };
  const first = trimmed.slice(0, space);
  const last = trimmed.slice(space + 1).trim();
  return last ? { first, last } : { first };
}

/**
 * Creates the contact when missing and leaves an existing one untouched, so one environment never
 * rewrites another's record. A read that lags a just-made create only repeats the create, which merges.
 */
export async function ensureContact(
  input: { email: string; name?: string | null },
  options: ResendOptions = {},
): Promise<{ ok: boolean }> {
  const config = resendConfig(options.env);
  if (!config.apiKey) {
    console.warn("[resend] contact create skipped: RESEND_API_KEY is not set");
    return { ok: false };
  }
  const opts = { apiKey: config.apiKey, fetchImpl: options.fetchImpl ?? fetch };
  const email = normalizeEmail(input.email);

  const existing = await request("GET", `/contacts/${encodeURIComponent(email)}`, undefined, opts);
  if (existing.ok) return { ok: true };
  if (existing.status !== 404) {
    warn("contact lookup", existing);
    return { ok: false };
  }

  const { first, last } = splitName(input.name);
  const body: Record<string, unknown> = { email };
  if (first) body.first_name = first;
  if (last) body.last_name = last;

  const created = await request("POST", "/contacts", body, opts);
  if (!created.ok) {
    warn("contact create", created);
    return { ok: false };
  }
  return { ok: true };
}

/** PATCH /contacts/{email}/topics; the body is a root-level array. */
export async function setTopicSubscription(
  email: string,
  subscription: TopicSubscription,
  options: ResendOptions = {},
): Promise<{ ok: boolean }> {
  const config = resendConfig(options.env);
  if (!config.apiKey || !config.productTopicId) {
    console.warn(
      "[resend] topic update skipped: RESEND_API_KEY and RESEND_PRODUCT_TOPIC_ID are both required",
    );
    return { ok: false };
  }

  const result = await request(
    "PATCH",
    `/contacts/${encodeURIComponent(normalizeEmail(email))}/topics`,
    [{ id: config.productTopicId, subscription }],
    { apiKey: config.apiKey, fetchImpl: options.fetchImpl ?? fetch },
  );
  if (!result.ok) {
    warn(`topic ${subscription}`, result);
    return { ok: false };
  }
  return { ok: true };
}
