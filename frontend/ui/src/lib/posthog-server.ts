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
