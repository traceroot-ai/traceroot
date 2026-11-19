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
