// Posts the "new user registered" notice through the sign-up Slack incoming
// webhook (TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL); unset means no post.
import { escapeMrkdwn, truncate } from "@traceroot/slack/block-kit";
import { env as realEnv } from "@/env";
import type { PersonFacts } from "./posthog-person";

export interface SignupSlackInput {
  name: string | null;
  email: string;
  provider: string;
  viaInvite: boolean;
  facts: PersonFacts | null;
  supportConsoleUrl: string;
  totalUsers?: number;
}

export type SignupSlackEnv = Partial<Pick<typeof realEnv, "TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL">>;

export interface NotifySignupSlackOptions {
  fetchImpl?: typeof fetch;
  env?: SignupSlackEnv;
}

const WEBHOOK_TIMEOUT_MS = 5_000;
const SEPARATOR = " · ";
// Keeps user-controlled strings well inside Slack's 3,000-character section limit.
const MAX_IDENTITY_CHARS = 200;

function section(text: string) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function factsLine(facts: PersonFacts | null): string | undefined {
  if (!facts) return undefined;
  const parts: string[] = [];
  const location = [facts.city, facts.region, facts.country].filter(Boolean).join(", ");
  if (location) parts.push(location);
  for (const value of [facts.os, facts.browser, facts.deviceType]) {
    if (value) parts.push(value);
  }
  if (facts.referringDomain) parts.push(`from ${facts.referringDomain}`);
  if (facts.landingPath) parts.push(`landed on ${facts.landingPath}`);
  if (parts.length === 0) return undefined;
  return parts.map(escapeMrkdwn).join(SEPARATOR);
}

export function buildSignupSlackMessage(input: SignupSlackInput): {
  text: string;
  blocks: unknown[];
} {
  const name = input.name?.trim();
  const email = escapeMrkdwn(truncate(input.email, MAX_IDENTITY_CHARS));
  const who = name ? `${escapeMrkdwn(truncate(name, MAX_IDENTITY_CHARS))} (${email})` : email;
  const line1 = `🎉 ${who}, a new user has registered`;

  const line2 = factsLine(input.facts);

  const tail = [`via ${input.provider}`];
  if (input.viaInvite) tail.push("via invite");
  if (input.facts) tail.push(`<${input.facts.personUrl}|PostHog person>`);
  tail.push(`<${input.supportConsoleUrl}|Support console>`);
  const line3 = tail.join(SEPARATOR);

  const blocks: unknown[] = [section(line1)];
  if (line2) blocks.push(section(line2));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: line3 }] });
  if (input.totalUsers !== undefined) {
    const total = `${input.totalUsers.toLocaleString("en-US")} total registered users`;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: total }] });
  }

  return { text: line1, blocks };
}

export async function notifySignupSlack(
  input: SignupSlackInput,
  options: NotifySignupSlackOptions = {},
): Promise<boolean> {
  const e = options.env ?? realEnv;
  const webhookUrl = e.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSignupSlackMessage(input)),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Slack sign-up webhook failed (${response.status})`);
  }
  return true;
}
