import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth";

// RFC 8414 authorization-server metadata for the issuer <app>/api/auth. Clients
// that learn the issuer from the MCP server's protected-resource metadata look
// for it here, with the issuer's path appended to the well-known prefix.
export const GET = oauthProviderAuthServerMetadata(auth);
