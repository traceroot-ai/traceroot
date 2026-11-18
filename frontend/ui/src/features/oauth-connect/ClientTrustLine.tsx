import { BadgeCheck, CircleAlert } from "lucide-react";
import type { OAuthClientDisplay } from "@/lib/oauth/client-display";

// One line saying who vouches for the assistant. "Verified by <host>" only when
// its identity is published at that host; a self-registered client is said to be
// unverified, because nothing checked the name it gave.
export function ClientTrustLine({ client }: { client: OAuthClientDisplay }) {
  if (client.verifiedHost) {
    return (
      <p className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <BadgeCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <span>
          {client.name} · verified by{" "}
          <span className="font-medium text-foreground">{client.verifiedHost}</span>
        </span>
      </p>
    );
  }
  return (
    <p className="inline-flex items-center gap-1 text-[12px] text-amber-700 dark:text-amber-300">
      <CircleAlert className="h-3.5 w-3.5" aria-hidden />
      <span>Unverified application</span>
    </p>
  );
}
