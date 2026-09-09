"use client";

import { useEffect, useState } from "react";
import { FaGithub } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { EnabledSocialAuthProviders, SocialAuthProvider } from "@/lib/social-auth";

type SocialAuthButtonsProps = {
  callbackURL: string;
  enabledProviders: EnabledSocialAuthProviders;
  onError: (message: string | null) => void;
  verb: "sign in" | "sign up";
};

const providerLabels: Record<SocialAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};

// Anything that goes wrong once the browser has left for the provider fails on
// the OAuth callback, which is a server redirect and so can never resolve back
// into `onError` below: without a destination of our own those failures render
// better-auth's built-in error page, outside the app shell. Naming one sends
// them to /auth/error instead, which reads the `?error=<code>` that better-auth
// appends.
const errorCallbackURL = "/auth/error";

export function SocialAuthButtons({
  callbackURL,
  enabledProviders,
  onError,
  verb,
}: SocialAuthButtonsProps) {
  const [loadingProvider, setLoadingProvider] = useState<SocialAuthProvider | null>(null);
  const hasSocialProviders = enabledProviders.google || enabledProviders.github;

  // A redirect that starts successfully deliberately leaves the pending state
  // set, because the tab is on its way to the provider and every button should
  // stay inert until it goes. If the user comes back, though, the browser may
  // restore this page from the back/forward cache, which replays the React
  // state exactly as it was - no remount, no re-render, no effect - and would
  // leave both buttons disabled on "Redirecting..." until a hard reload.
  // `pageshow` with `persisted` is the one event that marks that restore;
  // `visibilitychange` also fires on an ordinary tab switch, which would clear
  // the state while a redirect was still in flight.
  useEffect(() => {
    function clearPendingProvider(event: PageTransitionEvent) {
      if (event.persisted) {
        setLoadingProvider(null);
      }
    }

    window.addEventListener("pageshow", clearPendingProvider);
    return () => window.removeEventListener("pageshow", clearPendingProvider);
  }, []);

  if (!hasSocialProviders) {
    return null;
  }

  // Resolves to the message to report, or to null once the browser is on its
  // way to the provider. Reporting and unlocking stay with the caller so there
  // is a single place that clears the pending state, rather than one per exit.
  async function requestSocialAuth(provider: SocialAuthProvider): Promise<string | null> {
    try {
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL,
        errorCallbackURL,
      });
      if (!error) {
        return null;
      }
      return error.message || `Failed to ${verb} with ${providerLabels[provider]}`;
    } catch {
      return "An unexpected error occurred";
    }
  }

  async function handleSocialAuth(provider: SocialAuthProvider) {
    setLoadingProvider(provider);
    onError(null);

    const message = await requestSocialAuth(provider);
    if (message !== null) {
      onError(message);
      setLoadingProvider(null);
    }
  }

  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-[11px] uppercase">
          <span className="bg-card px-2 text-muted-foreground">Or</span>
        </div>
      </div>

      <div className="space-y-2">
        {enabledProviders.google && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full text-[13px]"
            onClick={() => handleSocialAuth("google")}
            disabled={loadingProvider !== null}
          >
            {loadingProvider === "google" ? "Redirecting..." : "Continue with Google"}
          </Button>
        )}

        {enabledProviders.github && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full gap-2 text-[13px]"
            onClick={() => handleSocialAuth("github")}
            disabled={loadingProvider !== null}
          >
            <FaGithub className="h-[15px] w-[15px]" aria-hidden="true" />
            {loadingProvider === "github" ? "Redirecting..." : "Continue with GitHub"}
          </Button>
        )}
      </div>
    </>
  );
}
