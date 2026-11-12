import type { GenericEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth/api";
import { isSelfSignup } from "./attribution";
import { isSignupEmailPolicyEnabled, signupEmailError } from "./email-policy";

export function signupEmailPolicyHook(authURL: string) {
  if (!isSignupEmailPolicyEnabled(authURL)) return;

  return async (user: { email: string }, context: GenericEndpointContext | null): Promise<void> => {
    if (!isSelfSignup(context)) return;
    const error = signupEmailError(user.email);
    if (error) throw new APIError("BAD_REQUEST", error);
  };
}
