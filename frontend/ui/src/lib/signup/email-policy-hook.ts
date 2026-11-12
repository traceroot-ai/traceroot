import type { GenericEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth/api";
import { isSelfSignup } from "./attribution";
import { signupEmailError } from "./email-policy";

export async function enforceSignupEmailPolicy(
  user: { email: string },
  context: GenericEndpointContext | null,
): Promise<void> {
  if (!isSelfSignup(context)) return;
  const error = signupEmailError(user.email);
  if (error) throw new APIError("BAD_REQUEST", error);
}
