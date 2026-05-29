import { env } from "@/env";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  const googleAuthConfigured = Boolean(
    env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim(),
  );

  return <SignInClient googleAuthConfigured={googleAuthConfigured} />;
}
