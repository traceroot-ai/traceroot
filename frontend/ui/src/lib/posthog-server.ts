import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { clientEnv } from "@/env.client";
import { supportRequest } from "@/lib/support/request-context";

const { NEXT_PUBLIC_POSTHOG_KEY: key, NEXT_PUBLIC_POSTHOG_HOST: host } = clientEnv;

const client = key && host ? new PostHog(key, { host, flushAt: 1, flushInterval: 0 }) : undefined;

client?.on("error", (err) => console.error("[analytics] failed to send:", err));

/**
 * Sends a server-side event. `timestamp` is when it happened, for an event recorded
 * after the fact; PostHog places the event there, which is what funnels and time
 * windows read, instead of at the time it was sent.
 */
export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
  timestamp?: Date,
): void {
  if (!client) return;
  if (supportRequest.getStore()?.impersonation) return;
  try {
    client.capture({ distinctId, event, properties, ...(timestamp && { timestamp }) });
  } catch (err) {
    console.error("[analytics] failed to capture:", err);
  }
}

/** Whether this deployment sends server-side analytics at all. */
export function isServerAnalyticsEnabled(): boolean {
  return client !== undefined;
}

/** How long one person-property request may take before it counts as not accepted. */
export const PERSON_PROPERTIES_TIMEOUT_MS = 10_000;

/**
 * Sets properties on a person profile and resolves once PostHog has accepted them,
 * under the same rules as captureServerEvent. Rejects when PostHog answers with an
 * error, cannot be reached, or does not answer within PERSON_PROPERTIES_TIMEOUT_MS
 * (or before `signal` aborts), so a caller that records the send can leave it to be
 * retried.
 *
 * Each call is its own request to PostHog's capture API, and its result is that
 * request's answer. The shared client only reports a failed delivery as an "error"
 * event that any concurrent send could have caused, so it cannot say whether this
 * particular update arrived.
 */
export async function sendServerPersonProperties(
  distinctId: string,
  properties: Record<string, unknown>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!client || !key || !host) return;
  if (supportRequest.getStore()?.impersonation) return;
  const timeout = AbortSignal.timeout(PERSON_PROPERTIES_TIMEOUT_MS);
  const response = await fetch(`${host.replace(/\/+$/, "")}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      batch: [
        {
          event: "$set",
          distinct_id: distinctId,
          // As the shared client sends it: no location from the server's address.
          properties: { $set: properties, $geoip_disable: true },
          timestamp: new Date().toISOString(),
          uuid: randomUUID(),
        },
      ],
    }),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`PostHog answered ${response.status} to a person-property update`);
  }
}
