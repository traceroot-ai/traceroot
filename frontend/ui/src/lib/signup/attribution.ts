import type { GenericEndpointContext } from "@better-auth/core";
import { attributionProperties, readAttributionCookie } from "@/lib/marketing-attribution";

type SignupContext = Partial<Pick<GenericEndpointContext, "path" | "headers" | "request">>;

export function signupAttributionProperties(
  context: SignupContext | null | undefined,
): Record<string, string> {
  // A support/admin user's campaign must not be assigned to a user they create.
  if (context?.path === "/admin/create-user") return {};

  try {
    const cookie = context?.headers?.get("cookie") ?? context?.request?.headers.get("cookie");
    return attributionProperties(readAttributionCookie(cookie));
  } catch {
    // Optional analytics must never turn a successful registration into an error.
    return {};
  }
}
