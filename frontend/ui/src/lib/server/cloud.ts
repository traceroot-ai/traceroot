import { env } from "@/env";

export function isCloud(): boolean {
  return env.TRACEROOT_CLOUD_ENV !== undefined;
}
