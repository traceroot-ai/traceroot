import { isGoogleAuthConfigured } from "@/lib/google-auth-config";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return <SignUpClient googleAuthConfigured={isGoogleAuthConfigured()} />;
}
