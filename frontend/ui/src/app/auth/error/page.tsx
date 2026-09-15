"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const errorMessages: Record<string, string> = {
  Configuration: "There is a problem with the server configuration.",
  AccessDenied: "Access denied. You do not have permission to sign in.",
  Verification: "The verification link has expired or has already been used.",
  OAuthAccountNotLinked:
    "This email is already associated with another account. Please sign in with the original provider.",
  Default: "An error occurred during authentication.",

  // The codes a social sign-in sends here, which arrive lower-cased and
  // underscored from the OAuth callback. Only the ones that change what the
  // user should do next are spelled out; the rest are plumbing failures the
  // default message already describes, and an unrecognised code still falls
  // back to it rather than rendering blank.
  access_denied: "The sign-in was cancelled before the provider could confirm it.",
  account_not_linked:
    "This email is already associated with another account. Please sign in with the original provider.",
  account_already_linked_to_different_user:
    "That provider account is already connected to a different account.",
  "email_doesn't_match": "The provider returned a different email than the account being linked.",
  email_not_found:
    "The provider did not share an email address. Grant access to your email and try again.",
  signup_disabled: "New accounts cannot be created with this provider.",
  unable_to_link_account: "The provider account could not be connected. Please try again.",
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
          <CardTitle className="text-2xl text-red-600">Authentication Error</CardTitle>
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
