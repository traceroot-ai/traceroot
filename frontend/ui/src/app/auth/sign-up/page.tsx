import { env } from "@/env";
import { configuredSocialProviders } from "@/lib/social-providers";
import { SignUpClient } from "./sign-up-client";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return <SignUpClient socialProviders={configuredSocialProviders(env)} />;
}
