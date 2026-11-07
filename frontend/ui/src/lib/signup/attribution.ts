import type { GenericEndpointContext } from "@better-auth/core";
import { attributionProperties, readAttributionCookie } from "@/lib/marketing-attribution";

// The part of better-auth's endpoint context that says how an account was
// created: the matched route and its params.
export interface SignupRequest {
  path?: string;
  params?: Record<string, string | undefined>;
}

export function isSelfSignup(context: { path?: string } | null): boolean {
  return context?.path !== "/admin/create-user";
}

// better-auth reports the matched route, not the URL: an OAuth sign-up's path
// is "/callback/:id", and the provider is the route's `id` param.
export function signupProvider(context: SignupRequest | null): string {
  if (context?.path?.includes("/sign-up/email")) return "email";
  const social = context?.path?.startsWith("/callback/") ? context.params?.id : undefined;
  return social ? social.toLowerCase() : "unknown";
}

// Stored with the account (users.signup_method) by the user.create.before
// hook, so a later replay knows a self-service sign-up from an account staff
// provisioned without guessing from the accounts linked since.
export function signupMethod(context: SignupRequest | null): string {
  return isSelfSignup(context) ? signupProvider(context) : "admin";
}

export function signupAttributionProperties(
  context: GenericEndpointContext | null,
): Record<string, string> {
  if (!isSelfSignup(context)) return {};
  // better-auth forwards the endpoint context (including request headers) to
  // database hooks for both email signup and the OAuth callback.
  return attributionProperties(readAttributionCookie(context?.headers?.get("cookie"), Date.now()));
}
