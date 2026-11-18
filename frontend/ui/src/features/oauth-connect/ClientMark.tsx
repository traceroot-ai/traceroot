import { Blocks, BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OAuthClientDisplay } from "@/lib/oauth/client-display";

// The assistant's side of the logo pair. Client logos are not loaded: they live
// on the client's own host, which the page's image policy does not allow, and a
// self-registered client could point one at any picture. A client vouched for by
// its host gets its initial; anything else a neutral glyph.
export function ClientMark({
  client,
  className,
}: {
  client: OAuthClientDisplay | null;
  className?: string;
}) {
  const verified = Boolean(client?.verifiedHost);
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-card text-foreground shadow-sm",
        className,
      )}
    >
      {verified && client ? (
        <span className="text-[17px] font-semibold leading-none">
          {client.name.trim().charAt(0).toUpperCase()}
        </span>
      ) : (
        <Blocks className="h-[18px] w-[18px] text-muted-foreground" strokeWidth={1.5} />
      )}
      {verified && (
        <BadgeCheck
          className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-card text-emerald-600 dark:text-emerald-400"
          strokeWidth={2}
        />
      )}
    </div>
  );
}
