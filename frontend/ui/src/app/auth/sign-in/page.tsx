import { getSocialAuthConfig } from "@/lib/social-auth";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  const { enabledProviders } = getSocialAuthConfig();

  return <SignInClient enabledProviders={enabledProviders} />;
}
