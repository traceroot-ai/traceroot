// What the connect screens (sign-in, project picker, consent) and the connected
// assistants list say about an OAuth client. Pure, so client components can use
// it; lib/oauth/load-client-display.ts reads the row on the server.

// Same as OAUTH_CONTINUE_PAGE in provider-options.ts (a test keeps them equal),
// which cannot be imported here because it pulls in the database.
export const CONTINUE_PATH = "/oauth/continue";

export interface OAuthClientDisplay {
  name: string;
  // The host that vouches for the client, or null when nothing does. A client
  // that identifies itself by a metadata document has its client_id at that
  // document's HTTPS URL, so the name and redirect URIs it shows were published
  // by whoever controls that host. A dynamically registered client sent its
  // name in an unauthenticated request, so nothing vouches for it.
  verifiedHost: string | null;
  // A self-registered client whose every redirect URI is a loopback address
  // (http://localhost, 127.0.0.1 or [::1], RFC 8252 §7.3): the authorization
  // code can only reach a program on the user's own computer, such as a CLI.
  // Still unverified, so it changes how the screens word the warning, not
  // what the client may do.
  localOnly?: boolean;
}

// better-auth's cimd plugin marks the rows it creates with this discovery id.
const METADATA_DOCUMENT_DISCOVERY = "cimd";

export function metadataDocumentHost(
  clientId: string,
  clientDiscoveryId: string | null | undefined,
): string | null {
  if (clientDiscoveryId !== METADATA_DOCUMENT_DISCOVERY) return null;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

export function describeOAuthClient(row: {
  clientId: string;
  name: string | null;
  clientDiscoveryId: string | null;
  redirectUris?: string[];
}): OAuthClientDisplay {
  const verifiedHost = metadataDocumentHost(row.clientId, row.clientDiscoveryId);
  const name =
    row.name?.trim() ||
    verifiedHost ||
    redirectHost(row.redirectUris?.[0]) ||
    "An unnamed application";
  const redirects = row.redirectUris ?? [];
  const localOnly = !verifiedHost && redirects.length > 0 && redirects.every(isLoopbackRedirect);
  return { name, verifiedHost, localOnly };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function redirectHost(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

// The client a sign-in is for, when the sign-in was started by an authorization:
// the OAuth provider sends a signed-out user to CONTINUE_PATH with the
// authorization request as its query, and the proxy puts that page in
// ?callbackUrl. Anything else is an ordinary sign-in.
export function clientIdFromCallbackUrl(callbackUrl: string | null | undefined): string | null {
  if (!callbackUrl) return null;
  let url: URL;
  try {
    url = new URL(callbackUrl, "http://same-origin.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://same-origin.invalid" || url.pathname !== CONTINUE_PATH) {
    return null;
  }
  return url.searchParams.get("client_id") || null;
}

export interface RedirectTarget {
  // What the user is shown: an origin for web callbacks, the scheme for apps.
  label: string;
  // Whether the browser shows a page there. A custom-scheme callback opens a
  // desktop app and leaves this tab where it is.
  opensPage: boolean;
}

// Where the user is sent after approving, shown so they can check it is the
// assistant they started from.
export function describeRedirectTarget(redirectUri: string | null): RedirectTarget | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return { label: `${url.protocol}//${url.host}`, opensPage: true };
    }
    return { label: url.protocol.replace(/:$/, ""), opensPage: false };
  } catch {
    return null;
  }
}

// The workspace is shown next to a project only when it says something the
// project name does not.
export function workspaceSuffix(projectName: string, workspaceName: string | null): string | null {
  if (!workspaceName) return null;
  return workspaceName.trim().toLowerCase() === projectName.trim().toLowerCase()
    ? null
    : workspaceName;
}
