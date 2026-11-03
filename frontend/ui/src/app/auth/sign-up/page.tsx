import { env } from "@/env";
import { turnstileKeys } from "@/lib/signup/captcha";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const googleAuthConfigured = Boolean(
    env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim(),
  );

  // Passed at request time rather than as NEXT_PUBLIC_*, so turning the
  // CAPTCHA on needs no rebuild and the widget can never be on without the
  // server check (or the reverse).
  const turnstileSiteKey = turnstileKeys(env)?.siteKey ?? null;

  return (
    <SignUpClient googleAuthConfigured={googleAuthConfigured} turnstileSiteKey={turnstileSiteKey} />
  );
}
