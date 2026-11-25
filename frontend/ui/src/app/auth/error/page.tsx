"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/lib/i18n/provider";
import type { MessageKey } from "@/lib/i18n/messages/en";

// The message for each error code; the text itself is in the `authError` message group.
const errorMessages: Record<string, MessageKey> = {
  Configuration: "authError.configuration",
  AccessDenied: "authError.accessDenied",
  Verification: "authError.verification",
  OAuthAccountNotLinked: "authError.oauthNotLinked",
  // Codes better-auth sends from a failed OAuth callback.
  account_not_linked: "authError.accountNotLinked",
  access_denied: "authError.providerDenied",
  unable_to_get_user_info: "authError.noUserInfo",
  oauth_provider_not_found: "authError.providerNotFound",
  state_mismatch: "authError.expired",
  state_not_found: "authError.expired",
  state_invalid: "authError.expired",
  state_security_mismatch: "authError.expired",
  Default: "authError.fallback",
};

function AuthErrorContent() {
  const searchParams = useSearchParams();
  const t = useT();
  const error = searchParams.get("error");

  const errorMessage = t(
    error ? errorMessages[error] || errorMessages.Default : errorMessages.Default,
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-[15px] text-danger">{t("authError.title")}</CardTitle>
          <CardDescription>{errorMessage}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/auth/sign-in">
            <Button>{t("authError.backToSignIn")}</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorContent />
    </Suspense>
  );
}
