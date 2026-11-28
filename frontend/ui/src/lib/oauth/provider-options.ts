import { APIError } from "better-auth/api";
import { assertNotImpersonating } from "@/lib/oauth/impersonation-guard";
import { clearProjectSelection, readProjectSelection } from "@/lib/oauth/project-selection";

// What an assistant is granted when a user connects it: read access to the
// traces, sessions, findings and other data of ONE project, nothing more.
export const MCP_READ_SCOPE = "mcp:read";
// Lets the assistant keep the connection without asking the user to sign in
// again. It grants no data access of its own.
const REFRESH_SCOPE = "offline_access";
const SCOPES = [MCP_READ_SCOPE, REFRESH_SCOPE];

type AuthSession = { id: string; impersonatedBy?: string | null };

export const OAUTH_SELECT_PROJECT_PAGE = "/oauth/select-project";
export const OAUTH_CONSENT_PAGE = "/oauth/consent";
export const OAUTH_CONTINUE_PAGE = "/oauth/continue";

// Options for better-auth's oauthProvider, for the MCP server at `resource`.
//
// Order of the flow: the assistant registers itself (dynamic registration), sends
// the user to /api/auth/oauth2/authorize, the user signs in (OAUTH_CONTINUE_PAGE
// sends them through the normal sign-in page and back), picks a project, consents,
// and the assistant exchanges the code (PKCE) for a token whose `aud` is the MCP
// server and whose `project_id` is the project picked. The picker runs on every
// authorization, so a user never grants a project they did not just choose.
export function mcpOAuthProviderOptions(resource: string) {
  return {
    loginPage: OAUTH_CONTINUE_PAGE,
    consentPage: OAUTH_CONSENT_PAGE,
    scopes: SCOPES,
    resources: [{ identifier: resource, name: "TraceRoot MCP", allowedScopes: SCOPES }],
    // Assistants cannot be pre-registered one by one: each registers itself the
    // first time a user adds the server. Registered clients are public (PKCE, no
    // secret) and can only ask for the scopes and resource above. Registration is
    // rate limited in auth.ts.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: SCOPES,
    clientRegistrationAllowedScopes: SCOPES,
    clientRegistrationDefaultResources: [resource],
    postLogin: {
      page: OAUTH_SELECT_PROJECT_PAGE,
      // The first pass of every authorization asks the user to choose again. A
      // return from the picker is only trusted once the choice is on record: the
      // continue request is the client's to send, so it proves nothing by itself.
      shouldRedirect: async ({
        session,
        isContinuation,
      }: {
        session: AuthSession;
        isContinuation: boolean;
      }) => {
        assertNotImpersonating(session);
        if (!isContinuation) {
          await clearProjectSelection(session.id);
          return true;
        }
        return (await readProjectSelection(session.id)) === null;
      },
      consentReferenceId: async ({ session }: { session: AuthSession }) => {
        assertNotImpersonating(session);
        const projectId = await readProjectSelection(session.id);
        if (!projectId) {
          throw new APIError("BAD_REQUEST", { message: "Choose a project first" });
        }
        return projectId;
      },
    },
    // The project the user chose is the consent's reference. It is carried in the
    // token so the API can serve that project and no other.
    customAccessTokenClaims: ({ referenceId }: { referenceId?: string }) =>
      referenceId ? { project_id: referenceId } : {},
  };
}
