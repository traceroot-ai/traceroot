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
  // captureImmediate resolves even when PostHog refused the request or could not be
  // reached; the failure only comes out as the client's "error" event. Listen for it
  // while this send is in flight. Another send failing at the same moment can fail
  // this one too, which only makes the caller send it again.
  let failure: unknown;
  const stopListening = client.on("error", (err: unknown) => {
    failure ??= err ?? new Error("PostHog did not accept the request");
  });
  try {
    await client.captureImmediate({ distinctId, event: "$set", properties: { $set: properties } });
  } finally {
    stopListening();
  }
  if (failure !== undefined) throw failure;
}
