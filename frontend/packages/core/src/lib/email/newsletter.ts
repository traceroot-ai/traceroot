// Who is on the newsletter segment, and adding them. The newsletter itself is
// written and sent by hand as a Resend broadcast to that segment; this only
// keeps its membership: everyone 14 days after sign-up (the scheduled tick),
// and everyone who signed up before that started (a one-time import, see
// scripts/newsletter-import.ts). Both go through `runNewsletterAudience`.
//
// Left out: team and listed test accounts (the same settings and rule as the
// lead service), AI agents' AgentID accounts, and anyone who has opted out of
// product email, here (`user_onboarding.unsubscribed_at`) or at the provider
// (the contact unsubscribed, or opted out of the product topic, which the
// newsletter shares with the other product email). A provider opt-out found
// here is recorded locally, so the follow-up emails see it too.
//
// Each person is added at most once: the provider call is safe to repeat and
// `newsletter_added_at` is stamped only after it succeeds, so a run that is
// retried, interrupted or overlaps another just finishes the rest. A dry run
// writes nothing and calls only the provider's read endpoints. Logs carry
// counts and user ids, never addresses.
import type { PrismaClient } from "@prisma/client";
import { ensureContact, resendConfig } from "./resend.ts";
import { normalizeEmail } from "./unsubscribe.ts";

const RESEND_API_URL = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after sign-up someone joins the newsletter. */
export const NEWSLETTER_DELAY_MS = 14 * DAY_MS;
/** The AgentID sign-in's provider id: AI agents, who sign up in bulk. */
const AGENT_PROVIDER_ID = "agentid";

export interface AudienceSettings {
  /** RESEND_NEWSLETTER_SEGMENT_ID; nothing is added without it. */
  segmentId?: string;
  /** TEAM_EMAIL_DOMAINS, default traceroot.ai; subdomains count. */
  teamDomains: string[];
  /** SKIP_EMAILS: exact test addresses. */
  skipEmails: string[];
  /** NEWSLETTER_START_AT: the scheduled job adds people who signed up from then; the import, before. */
  startAt: Date | null;
}

const list = (raw: string | undefined, fallback = "") =>
  (raw ?? fallback)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export function audienceSettings(env: NodeJS.ProcessEnv = process.env): AudienceSettings {
  const start = env.NEWSLETTER_START_AT?.trim();
  const startAt = start ? new Date(start) : null;
  return {
    segmentId: env.RESEND_NEWSLETTER_SEGMENT_ID?.trim() || undefined,
    teamDomains: list(env.TEAM_EMAIL_DOMAINS, "traceroot.ai"),
    skipEmails: list(env.SKIP_EMAILS),
    startAt: startAt && !Number.isNaN(startAt.getTime()) ? startAt : null,
  };
}

export type Exclusion =
  | "team_account"
  | "listed_test_account"
  | "agent_account"
  | "unsubscribed"
  | "provider_unsubscribed";

/** Why someone is left out by what we hold ourselves, or null. */
export function localExclusion(
  person: { email: string; providers: readonly string[]; unsubscribedAt: Date | null },
  settings: Pick<AudienceSettings, "teamDomains" | "skipEmails">,
): Exclusion | null {
  const email = normalizeEmail(person.email);
  if (settings.skipEmails.includes(email)) return "listed_test_account";
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (settings.teamDomains.some((team) => domain === team || domain.endsWith(`.${team}`)))
    return "team_account";
  if (person.providers.length > 0 && person.providers.every((p) => p === AGENT_PROVIDER_ID))
    return "agent_account";
  if (person.unsubscribedAt) return "unsubscribed";
  return null;
}

type Fetch = typeof fetch;

/** Spaces the provider calls out, to stay under its rate limit. */
export function pacedFetch(fetchImpl: Fetch, minIntervalMs: number): Fetch {
  let next = 0;
  return (async (...args: Parameters<Fetch>) => {
    const wait = next - Date.now();
    next = Math.max(Date.now(), next) + minIntervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return fetchImpl(...args);
  }) as Fetch;
}

async function call(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  fetchImpl: Fetch,
): Promise<{ status: number | null; body: unknown }> {
  try {
    const response = await fetchImpl(`${RESEND_API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

export type ProviderState = "subscribed" | "no_contact" | "unsubscribed" | "unknown";

/** Where the person stands at the provider. Reads only. */
export async function providerState(
  email: string,
  options: { apiKey: string; productTopicId?: string; fetchImpl: Fetch },
): Promise<ProviderState> {
  const path = `/contacts/${encodeURIComponent(normalizeEmail(email))}`;
  const contact = await call("GET", path, options.apiKey, options.fetchImpl);
  if (contact.status === 404) return "no_contact";
  if (contact.status !== 200) return "unknown";
  if ((contact.body as { unsubscribed?: boolean } | null)?.unsubscribed) return "unsubscribed";
  if (!options.productTopicId) return "subscribed";
  const topics = await call("GET", `${path}/topics?limit=100`, options.apiKey, options.fetchImpl);
  if (topics.status !== 200) return "unknown";
  const product = (
    topics.body as { data?: { id: string; subscription: string }[] } | null
  )?.data?.find((topic) => topic.id === options.productTopicId);
  return product?.subscription === "opt_out" ? "unsubscribed" : "subscribed";
}

export type AudienceMode =
  /** Signed up from NEWSLETTER_START_AT and at least 14 days ago. */
  | { kind: "scheduled"; now: Date }
  /** Signed up before NEWSLETTER_START_AT. */
  | { kind: "import" };

export interface AudienceRun {
  mode: AudienceMode["kind"];
  apply: boolean;
  /** People not yet on the segment who were looked at. */
  considered: number;
  excluded: Partial<Record<Exclusion, number>>;
  /** Added, or in a dry run, would be. */
  added: number;
  /** Of those, how many have no contact yet (one is made when applied). */
  withoutContact: number;
  /** The provider could not be read or written; tried again next run. */
  failed: number;
  /** Left for a later run by the batch limit. */
  remaining: number;
  /** Set when nothing could run, and why. */
  notRun?: "no_segment" | "no_api_key" | "no_start";
}

export type AudienceClient = Pick<PrismaClient, "user" | "userOnboarding">;

export async function runNewsletterAudience(
  db: AudienceClient,
  options: {
    mode: AudienceMode;
    /** False is a dry run: nothing is written anywhere. */
    apply: boolean;
    /** At most this many people per run; the rest wait for the next. */
    limit?: number;
    /** Minimum time between provider calls. */
    minIntervalMs?: number;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Fetch;
    log?: (line: string) => void;
  },
): Promise<AudienceRun> {
  const { mode, apply } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const settings = audienceSettings(options.env);
  const config = resendConfig(options.env);
  const run: AudienceRun = {
    mode: mode.kind,
    apply,
    considered: 0,
    excluded: {},
    added: 0,
    withoutContact: 0,
    failed: 0,
    remaining: 0,
  };
  if (!settings.segmentId) return { ...run, notRun: "no_segment" };
  if (!config.apiKey) return { ...run, notRun: "no_api_key" };
  if (!settings.startAt) return { ...run, notRun: "no_start" };
  const fetchImpl = pacedFetch(options.fetchImpl ?? fetch, options.minIntervalMs ?? 600);

  const signedUp =
    mode.kind === "scheduled"
      ? { gte: settings.startAt, lte: new Date(mode.now.getTime() - NEWSLETTER_DELAY_MS) }
      : { lt: settings.startAt };
  const where = {
    createdAt: signedUp,
    OR: [{ onboarding: { is: null } }, { onboarding: { is: { newsletterAddedAt: null } } }],
  };
  const people = await db.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      accounts: { select: { providerId: true } },
      onboarding: { select: { unsubscribedAt: true } },
    },
    orderBy: { createdAt: "asc" },
    ...(options.limit ? { take: options.limit } : {}),
  });
  if (options.limit && people.length === options.limit) {
    run.remaining = (await db.user.count({ where })) - people.length;
  }

  const exclude = (reason: Exclusion) => {
    run.excluded[reason] = (run.excluded[reason] ?? 0) + 1;
  };
  const segmentPath = (email: string) =>
    `/contacts/${encodeURIComponent(normalizeEmail(email))}/segments/${encodeURIComponent(settings.segmentId!)}`;

  for (const person of people) {
    run.considered += 1;
    const local = localExclusion(
      {
        email: person.email,
        providers: person.accounts.map((a) => a.providerId),
        unsubscribedAt: person.onboarding?.unsubscribedAt ?? null,
      },
      settings,
    );
    if (local) {
      exclude(local);
      continue;
    }
    const state = await providerState(person.email, {
      apiKey: config.apiKey,
      productTopicId: config.productTopicId,
      fetchImpl,
    });
    if (state === "unknown") {
      run.failed += 1;
      continue;
    }
    if (state === "unsubscribed") {
      exclude("provider_unsubscribed");
      if (apply) await recordProviderOptOut(db, person.id);
      continue;
    }
    if (state === "no_contact") run.withoutContact += 1;
    if (!apply) {
      run.added += 1;
      continue;
    }
    if (state === "no_contact") {
      const contact = await ensureContact({ email: person.email }, { env: options.env, fetchImpl });
      if (!contact.ok) {
        run.failed += 1;
        continue;
      }
    }
    const added = await call("POST", segmentPath(person.email), config.apiKey, fetchImpl);
    if (added.status === null || added.status >= 300) {
      log(`[newsletter] user ${person.id}: not added (${added.status ?? "network error"})`);
      run.failed += 1;
      continue;
    }
    await stampAdded(db, person.id);
    run.added += 1;
  }
  log(`[newsletter] ${apply ? "applied" : "dry run"} (${mode.kind}): ${JSON.stringify(run)}`);
  return run;
}

/** Stamps the addition once; an earlier stamp (an overlapping run) is kept. */
async function stampAdded(db: AudienceClient, userId: string, now = new Date()) {
  await db.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
  await db.userOnboarding.updateMany({
    where: { userId, newsletterAddedAt: null },
    data: { newsletterAddedAt: now },
  });
}

async function recordProviderOptOut(db: AudienceClient, userId: string, now = new Date()) {
  await db.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
  await db.userOnboarding.updateMany({
    where: { userId, unsubscribedAt: null },
    data: { unsubscribedAt: now },
  });
}
