import { PostHog } from "posthog-node";
import { clientEnv } from "@/env.client";
import { supportRequest } from "@/lib/support/request-context";

const { NEXT_PUBLIC_POSTHOG_KEY: key, NEXT_PUBLIC_POSTHOG_HOST: host } = clientEnv;

const client = key && host ? new PostHog(key, { host, flushAt: 1, flushInterval: 0 }) : undefined;

client?.on("error", (err) => console.error("[analytics] failed to send:", err));

export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!client) return;
  if (supportRequest.getStore()?.impersonation) return;
  try {
    client.capture({ distinctId, event, properties });
  } catch (err) {
    console.error("[analytics] failed to capture:", err);
  }
}

/** Whether this deployment sends server-side analytics at all. */
export function isServerAnalyticsEnabled(): boolean {
  return client !== undefined;
}

/**
 * Sets properties on a person profile and waits until PostHog has accepted them,
 * under the same rules as captureServerEvent. Rejects when PostHog does not accept,
 * so a caller that records the send can leave it to be retried.
 */
export async function sendServerPersonProperties(
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  if (!client) return;
  if (supportRequest.getStore()?.impersonation) return;
  await client.captureImmediate({ distinctId, event: "$set", properties: { $set: properties } });
}
