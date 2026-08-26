import { cn } from "@/lib/utils";
import { formatStamp } from "../utils";

/**
 * Absolute timestamp, rendered as local time.
 *
 * Every call site sits behind a client-side `useQuery`, so there is no
 * server-seeded data for this to mismatch against on first paint — the
 * server and the first client render both show the surrounding view's
 * loading state, and this only ever mounts once real data has arrived.
 * Rendering local time immediately (rather than gating on a `mounted` flag)
 * avoids painting an unlabeled UTC value that would otherwise be
 * indistinguishable from local time.
 */
export function Timestamp({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning className={cn("whitespace-nowrap", className)}>
      {formatStamp(iso)}
    </time>
  );
}
