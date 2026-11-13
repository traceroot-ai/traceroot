"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/social-providers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

const PROVIDERS: Record<SocialProvider, { label: string; mark: React.ReactNode }> = {
  google: { label: "Google", mark: <GoogleMark /> },
};

const START_FAILED = "Could not start sign-in. Please try again.";

/** The "Or continue with" divider and one button per configured provider. */
export function SocialSignInButtons({
  providers,
  callbackURL,
  onError,
}: {
  providers: SocialProvider[];
  callbackURL: string;
  onError: (message: string | null) => void;
}) {
  const [redirectingTo, setRedirectingTo] = useState<SocialProvider | null>(null);
  if (providers.length === 0) return null;

  async function signIn(provider: SocialProvider) {
    setRedirectingTo(provider);
    onError(null);
    // On success the browser leaves the page; on failure both buttons come back.
    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (!result?.error) return;
      onError(result.error.message || START_FAILED);
    } catch {
      onError(START_FAILED);
    }
    setRedirectingTo(null);
  }

  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-[12px] uppercase">
          <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
        </div>
      </div>

      <div className={cn("grid gap-2", providers.length > 1 && "grid-cols-2")}>
        {providers.map((provider) => (
          <Button
            key={provider}
            variant="outline"
            size="sm"
            className="h-8 w-full gap-2 text-[13px]"
            onClick={() => signIn(provider)}
            disabled={redirectingTo !== null}
          >
            {redirectingTo === provider ? (
              "Redirecting..."
            ) : (
              <>
                {PROVIDERS[provider].mark}
                {PROVIDERS[provider].label}
              </>
            )}
          </Button>
        ))}
      </div>
    </>
  );
}
