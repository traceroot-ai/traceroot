import { env } from "@/env";
import { isSignupEmailPolicyEnabled } from "@/lib/signup/email-policy";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const googleAuthConfigured = Boolean(
    env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim(),
  );

  return (
    <SignUpClient
      googleAuthConfigured={googleAuthConfigured}
      emailDomainPolicyEnabled={isSignupEmailPolicyEnabled(env.BETTER_AUTH_URL)}
    />
  );
}
