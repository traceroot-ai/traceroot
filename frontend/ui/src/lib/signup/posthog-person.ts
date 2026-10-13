// Looks up the PostHog person behind a new user for the Slack notice. The
// browser's identify() lands a few seconds after the insert, hence the poll.
// Never throws: missing config, failed requests and an absent person all give null.
import { env as realEnv } from "@/env";

export interface PersonFacts {
  city?: string;
  region?: string;
  country?: string;
  os?: string;
  browser?: string;
  deviceType?: string;
  referringDomain?: string;
  landingPath?: string;
  personUrl: string;
}

export type PostHogEnv = Partial<
  Pick<typeof realEnv, "POSTHOG_PERSONAL_API_KEY" | "POSTHOG_PROJECT_ID" | "POSTHOG_API_HOST">
>;

export interface FindPostHogPersonOptions {
  fetchImpl?: typeof fetch;
  env?: PostHogEnv;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API_HOST = "https://us.posthog.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface PostHogPerson {
  id: string;
  distinct_ids: string[];
  properties: Record<string, unknown>;
  created_at: string;
}

const PROPERTY_TO_FACT: ReadonlyArray<
  [property: string, fact: keyof Omit<PersonFacts, "personUrl">]
> = [
  ["$geoip_city_name", "city"],
  ["$geoip_subdivision_1_code", "region"],
  ["$geoip_country_code", "country"],
  ["$os", "os"],
  ["$browser", "browser"],
  ["$device_type", "deviceType"],
  ["$initial_referring_domain", "referringDomain"],
  ["$initial_pathname", "landingPath"],
];

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function personFactsFromProperties(
  properties: Record<string, unknown>,
  personUrl: string,
): PersonFacts {
  const facts: PersonFacts = { personUrl };
  for (const [property, fact] of PROPERTY_TO_FACT) {
    const value = nonBlank(properties[property]);
    if (!value) continue;
    // "$direct" is PostHog's no-referrer marker, not a domain.
    if (fact === "referringDomain" && value === "$direct") continue;
    facts[fact] = value;
  }
  return facts;
}

export async function findPostHogPerson(
  userId: string,
  options: FindPostHogPersonOptions = {},
): Promise<PersonFacts | null> {
  const e = options.env ?? realEnv;
  const apiKey = nonBlank(e.POSTHOG_PERSONAL_API_KEY);
  const projectId = nonBlank(e.POSTHOG_PROJECT_ID);
  if (!apiKey || !projectId) return null;

  const host = (nonBlank(e.POSTHOG_API_HOST) ?? DEFAULT_API_HOST).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const encodedUserId = encodeURIComponent(userId);
  const lookupUrl =
    `${host}/api/projects/${encodeURIComponent(projectId)}/persons/` +
    `?distinct_id=${encodedUserId}&limit=1`;
  const personUrl = `${host}/project/${projectId}/person/${encodedUserId}`;

  const deadline = Date.now() + timeoutMs;
  let warned = false;

  for (;;) {
    try {
      const response = await fetchImpl(lookupUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`PostHog persons lookup failed (${response.status})`);
      }
      const payload = (await response.json()) as { results?: PostHogPerson[] };
      const person = payload.results?.[0];
      if (person) return personFactsFromProperties(person.properties ?? {}, personUrl);
    } catch (error) {
      // One warning per sign-up, not one per poll.
      if (!warned) {
        warned = true;
        console.warn(
          `[signup] PostHog person lookup for user ${userId} failed, retrying until deadline:`,
          error,
        );
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollMs, remaining));
  }
}
