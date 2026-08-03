import { env } from "@/env";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const googleAuthConfigured = isGoogleAuthConfigured(
    env.AUTH_GOOGLE_CLIENT_ID,
    env.AUTH_GOOGLE_CLIENT_SECRET,
  );

  return <SignUpClient googleAuthConfigured={googleAuthConfigured} />;
}
