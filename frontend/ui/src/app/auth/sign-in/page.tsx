import { env } from "@/env";
import { isSmtpConfigured } from "@/lib/email/send-password-reset-email";
import { configuredSocialProviders } from "@/lib/social-providers";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <SignInClient
      socialProviders={configuredSocialProviders(env)}
      passwordResetEnabled={isSmtpConfigured()}
    />
  );
}
