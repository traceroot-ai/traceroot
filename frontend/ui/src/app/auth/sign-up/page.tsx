import { getSocialAuthConfig } from "@/lib/social-auth";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const { enabledProviders } = getSocialAuthConfig();

  return <SignUpClient enabledProviders={enabledProviders} />;
}
