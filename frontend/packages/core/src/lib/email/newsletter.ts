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
import type { Prisma, PrismaClient } from "@prisma/client";
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

const isSuccess = (result: { status: number | null; body: unknown }, segmentId: string) =>
  result.status !== null &&
  result.status >= 200 &&
  result.status < 300 &&
  (result.body as { id?: string } | null)?.id === segmentId;

/** Most pages read for one contact's segments; a contact is in very few. */
const MAX_SEGMENT_PAGES = 20;

/**
 * Whether the contact is in this exact segment, reading every page of their
 * segments; null when that cannot be read.
 */
export async function inSegment(
  email: string,
  segmentId: string,
  apiKey: string,
  fetchImpl: Fetch,
): Promise<boolean | null> {
  const base = `/contacts/${encodeURIComponent(normalizeEmail(email))}/segments?limit=100`;
  let after: string | undefined;
  for (let page = 0; page < MAX_SEGMENT_PAGES; page += 1) {
    const result = await call(
      "GET",
      after ? `${base}&after=${encodeURIComponent(after)}` : base,
      apiKey,
      fetchImpl,
    );
    if (result.status !== 200) return null;
    const body = result.body as { data?: { id: string }[]; has_more?: boolean } | null;
    const data = body?.data ?? [];
    if (data.some((segment) => segment.id === segmentId)) return true;
    if (!body?.has_more || data.length === 0) return false;
    after = data[data.length - 1].id;
  }
  return null;
}

export type ProviderState = "subscribed" | "no_contact" | "unsubscribed" | "unknown";

/** Most pages of a contact's topics read; an account has a handful. */
const MAX_TOPIC_PAGES = 20;

/**
 * Where the person stands at the provider. Reads only. Anything it cannot read
 * for certain (an error, a body it does not understand, the product topic
 * missing from every page of the contact's topics, a value other than opt_in
 * or opt_out) is "unknown": nobody is added on a guess, and an unknown is tried
 * again on a later run.
 */
export async function providerState(
  email: string,
  options: { apiKey: string; productTopicId?: string; fetchImpl: Fetch },
): Promise<ProviderState> {
  if (!options.productTopicId) return "unknown";
  const path = `/contacts/${encodeURIComponent(normalizeEmail(email))}`;
  const contact = await call("GET", path, options.apiKey, options.fetchImpl);
  if (contact.status === 404) return "no_contact";
  if (contact.status !== 200) return "unknown";
  const unsubscribed = (contact.body as { unsubscribed?: unknown } | null)?.unsubscribed;
  if (typeof unsubscribed !== "boolean") return "unknown";
  if (unsubscribed) return "unsubscribed";

  let after: string | undefined;
  for (let page = 0; page < MAX_TOPIC_PAGES; page += 1) {
    const query = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const topics = await call("GET", `${path}/topics?${query}`, options.apiKey, options.fetchImpl);
    if (topics.status !== 200) return "unknown";
    const body = topics.body as { data?: unknown; has_more?: unknown } | null;
    if (!Array.isArray(body?.data)) return "unknown";
    const data = body.data as { id?: unknown; subscription?: unknown }[];
    const product = data.find((topic) => topic?.id === options.productTopicId);
    if (product) {
      if (product.subscription === "opt_out") return "unsubscribed";
      return product.subscription === "opt_in" ? "subscribed" : "unknown";
    }
    const last = data[data.length - 1]?.id;
    if (body.has_more !== true || typeof last !== "string") return "unknown";
    after = last;
  }
  return "unknown";
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
  /** Left for a later run by the batch limit or the time budget. */
  remaining: number;
  /** Set when nothing could run, and why. */
  notRun?: "no_segment" | "no_api_key" | "no_topic" | "no_start";
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
    /** Stop starting new people after this long; the rest wait for the next run. */
    budgetMs?: number;
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
  // The newsletter shares the product email's opt-out topic; without it no
  // one's preference can be read.
  if (!config.productTopicId) return { ...run, notRun: "no_topic" };
  if (!settings.startAt) return { ...run, notRun: "no_start" };
  const fetchImpl = pacedFetch(options.fetchImpl ?? fetch, options.minIntervalMs ?? 600);

  const signedUp =
    mode.kind === "scheduled"
      ? { gte: settings.startAt, lte: new Date(mode.now.getTime() - NEWSLETTER_DELAY_MS) }
      : { lt: settings.startAt };
  // Everyone in the window not yet on the segment, and of them who is left out.
  // The left-out are filtered in the query rather than skipped one by one, so a
  // batch never fills up with people it will not add.
  const pending: Prisma.UserWhereInput = {
    createdAt: signedUp,
    OR: [{ onboarding: { is: null } }, { onboarding: { is: { newsletterAddedAt: null } } }],
  };
  const left = exclusionFilters(settings);
  const order: LocalExclusion[] = [
    "listed_test_account",
    "team_account",
    "agent_account",
    "unsubscribed",
  ];
  const candidates: Prisma.UserWhereInput = {
    AND: [pending, { NOT: order.map((reason) => left[reason]) }],
  };
  for (const [i, reason] of order.entries()) {
    const count = await db.user.count({
      where: { AND: [pending, left[reason], { NOT: order.slice(0, i).map((r) => left[r]) }] },
    });
    if (count) run.excluded[reason] = count;
    run.considered += count;
  }
  const people = await db.user.findMany({
    where: candidates,
    select: {
      id: true,
      email: true,
      accounts: { select: { providerId: true } },
      onboarding: { select: { unsubscribedAt: true } },
    },
    // Not tried yet first, then the longest since a failed try: people who keep
    // failing are retried without holding up everyone behind them.
    orderBy: [
      { onboarding: { newsletterTriedAt: { sort: "asc", nulls: "first" } } },
      { createdAt: "asc" },
    ],
    ...(options.limit ? { take: options.limit } : {}),
  });
  const total = options.limit ? await db.user.count({ where: candidates }) : people.length;
  const started = Date.now();

  const exclude = (reason: Exclusion) => {
    run.excluded[reason] = (run.excluded[reason] ?? 0) + 1;
  };
  const segmentPath = (email: string) =>
    `/contacts/${encodeURIComponent(normalizeEmail(email))}/segments/${encodeURIComponent(settings.segmentId!)}`;

  // Not added this time, to be tried again on a later run. Applied, the try is
  // recorded, which puts the person behind those not tried yet.
  const failed = async (userId: string) => {
    run.failed += 1;
    if (apply) await stampTried(db, userId);
  };

  let processed = 0;
  for (const person of people) {
    // A time budget, so a backlog cannot hold up the caller; the rest wait for the next run.
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs) break;
    processed += 1;
    run.considered += 1;
    // The query left these out already; checked again in case a setting reads differently.
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
      await failed(person.id);
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
        await failed(person.id);
        continue;
      }
    }
    const added = await call("POST", segmentPath(person.email), config.apiKey, fetchImpl);
    // The provider documents the success answer only (the segment's id). A
    // lost answer, an error or anything else may still have added them, or
    // they may have been a member already, so their membership of this exact
    // segment decides.
    const confirmed =
      isSuccess(added, settings.segmentId) ||
      (await inSegment(person.email, settings.segmentId, config.apiKey, fetchImpl)) === true;
    if (!confirmed) {
      log(`[newsletter] user ${person.id}: not added (${added.status ?? "network error"})`);
      await failed(person.id);
      continue;
    }
    await stampAdded(db, person.id);
    run.added += 1;
  }
  run.remaining = total - processed;
  log(`[newsletter] ${apply ? "applied" : "dry run"} (${mode.kind}): ${JSON.stringify(run)}`);
  return run;
}

/** The query filters for each kind of left-out person, matching `localExclusion`. */
type LocalExclusion = Exclude<Exclusion, "provider_unsubscribed">;

function exclusionFilters(
  settings: AudienceSettings,
): Record<LocalExclusion, Prisma.UserWhereInput> {
  const insensitive = "insensitive" as const;
  return {
    listed_test_account: { email: { in: settings.skipEmails, mode: insensitive } },
    team_account: {
      OR: settings.teamDomains.flatMap((team) => [
        { email: { endsWith: `@${team}`, mode: insensitive } },
        { email: { endsWith: `.${team}`, mode: insensitive } },
      ]),
    },
    agent_account: {
      AND: [
        { accounts: { some: { providerId: AGENT_PROVIDER_ID } } },
        { accounts: { every: { providerId: AGENT_PROVIDER_ID } } },
      ],
    },
    unsubscribed: { onboarding: { is: { unsubscribedAt: { not: null } } } },
  };
}

/** Stamps the addition once; an earlier stamp (an overlapping run) is kept. */
async function stampAdded(db: AudienceClient, userId: string, now = new Date()) {
  await db.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
  await db.userOnboarding.updateMany({
    where: { userId, newsletterAddedAt: null },
    data: { newsletterAddedAt: now },
  });
}

async function stampTried(db: AudienceClient, userId: string, now = new Date()) {
  await db.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
  await db.userOnboarding.updateMany({ where: { userId }, data: { newsletterTriedAt: now } });
}

/**
 * Records an opt-out the provider holds on the account, unless the account has a
 * choice of its own that the provider has not been confirmed to hold yet (a
 * Subscribe again whose sync is still under way shows the old opt-out at the
 * provider until it lands): then the account's choice stands and the scheduled
 * run brings the provider in line with it. One guarded statement, so a choice
 * made meanwhile is never overwritten; the new version makes a sync in flight
 * look again. The person is left out of the newsletter either way.
 */
async function recordProviderOptOut(db: AudienceClient, userId: string, now = new Date()) {
  await db.userOnboarding.createMany({ data: [{ userId }], skipDuplicates: true });
  await db.userOnboarding.updateMany({
    where: {
      userId,
      unsubscribedAt: null,
      OR: [{ emailPreferenceAt: null }, { emailProviderSettledAt: { not: null } }],
    },
    data: { unsubscribedAt: now, emailPreferenceVersion: { increment: 1 } },
  });
}
