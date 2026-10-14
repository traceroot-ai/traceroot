import type { GenericEndpointContext } from "@better-auth/core";
import { attributionProperties, readAttributionCookie } from "@/lib/marketing-attribution";

export function isSelfSignup(context: { path?: string } | null): boolean {
  return context?.path !== "/admin/create-user";
}

export function signupAttributionProperties(
  context: GenericEndpointContext | null,
): Record<string, string> {
  if (!isSelfSignup(context)) return {};
  // better-auth forwards the endpoint context (including request headers) to
  // database hooks for both email signup and the OAuth callback.
  return attributionProperties(readAttributionCookie(context?.headers?.get("cookie"), Date.now()));
}
