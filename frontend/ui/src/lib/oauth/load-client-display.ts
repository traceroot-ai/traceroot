import { prisma } from "@traceroot/core";
import { describeOAuthClient, type OAuthClientDisplay } from "@/lib/oauth/client-display";

// The name and trust of a registered client, for the connect screens. Reads the
// database only: it never fetches a metadata document, so a link to the sign-in
// page cannot make the server fetch anything. The authorize endpoint has already
// created the row by the time a user reaches these pages; a client that does not
// exist, or is disabled, shows nothing.
export async function loadOAuthClientDisplay(
  clientId: string | null | undefined,
): Promise<OAuthClientDisplay | null> {
  if (!clientId || clientId.length > 2048) return null;
  const row = await prisma.oauthClient.findUnique({
    where: { clientId },
    select: {
      clientId: true,
      name: true,
      clientDiscoveryId: true,
      redirectUris: true,
      disabled: true,
    },
  });
  if (!row || row.disabled) return null;
  return describeOAuthClient(row);
}
