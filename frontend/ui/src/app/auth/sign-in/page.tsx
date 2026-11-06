import { env } from "@/env";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  const googleAuthConfigured = isGoogleAuthConfigured(
    env.AUTH_GOOGLE_CLIENT_ID,
    env.AUTH_GOOGLE_CLIENT_SECRET,
  );

  return <SignInClient googleAuthConfigured={googleAuthConfigured} />;
}
