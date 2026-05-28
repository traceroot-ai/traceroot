import { isGoogleAuthConfigured } from "@/lib/google-auth-config";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return <SignInClient googleAuthConfigured={isGoogleAuthConfigured()} />;
}
