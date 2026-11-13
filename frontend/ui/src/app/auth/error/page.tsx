"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENTID_OWNER_LIMIT_REACHED, AGENTID_OWNER_MISSING } from "@/lib/agentid-owner-cap";

const errorMessages: Record<string, string> = {
  Configuration: "There is a problem with the server configuration.",
  AccessDenied: "Access denied. You do not have permission to sign in.",
  Verification: "The verification link has expired or has already been used.",
  OAuthAccountNotLinked:
    "This email is already associated with another account. Please sign in with the original provider.",
  // Codes better-auth sends from a failed OAuth callback.
  account_not_linked:
    "An account with this email already exists, and this sign-in was not linked to it. Sign in the way you did before.",
  access_denied: "Sign-in was cancelled or not allowed by the provider.",
  unable_to_get_user_info: "The sign-in provider did not confirm your identity. Please try again.",
  oauth_provider_not_found: "That sign-in method is not available.",
  state_mismatch: "Your sign-in expired. Please start again.",
  state_not_found: "Your sign-in expired. Please start again.",
  state_invalid: "Your sign-in expired. Please start again.",
  state_security_mismatch: "Your sign-in expired. Please start again.",
  [AGENTID_OWNER_LIMIT_REACHED]:
    "This AgentMail account or organization already has the maximum number of AgentID agents on traceroot.",
  [AGENTID_OWNER_MISSING]:
    "AgentID did not say which AgentMail account or organization this agent belongs to, which traceroot needs to create the account.",
  Default: "An error occurred during authentication.",
};

function AuthErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  const errorMessage = error
    ? errorMessages[error] || errorMessages.Default
    : errorMessages.Default;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-[15px] text-danger">Authentication Error</CardTitle>
          <CardDescription>{errorMessage}</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/auth/sign-in">
            <Button>Back to Sign In</Button>
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
