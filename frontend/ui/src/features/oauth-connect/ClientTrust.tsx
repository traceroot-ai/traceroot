import type { OAuthClientDisplay } from "@/lib/oauth/client-display";

// Who vouches for the assistant on the connect screens. A client that
// identifies itself by a metadata document was published by whoever controls
// that host, so the host is named under the card title. A self-registered
// client sent its name in an unauthenticated request, so nothing vouches for it
// and the card says so in the app's warning banner.

export function ClientVerifiedBy({ client }: { client: OAuthClientDisplay | null }) {
  if (!client?.verifiedHost) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      Verified by <span className="font-medium text-foreground">{client.verifiedHost}</span>
    </p>
  );
}

export function UnverifiedClientNotice({ client }: { client: OAuthClientDisplay | null }) {
  if (!client || client.verifiedHost) return null;
  return (
    <p
      role="alert"
      className="border border-warning-border bg-warning-soft p-2 text-[12px] text-warning"
    >
      <span className="font-medium">Unverified application.</span> &ldquo;{client.name}&rdquo;
      registered itself, so traceroot can&apos;t confirm who made it. Only continue if you started
      this connection from an assistant you trust.
    </p>
  );
}
