"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/social-providers";

const START_FAILED = "Could not start sign-in. Please try again.";

export type SocialSignIn = {
  /** The configured providers; only these get a working action. */
  providers: SocialProvider[];
  /** The provider the browser is being sent to, while a sign-in starts. */
  redirectingTo: SocialProvider | null;
  signIn: (provider: SocialProvider) => void;
};

/**
 * Starts a GitHub, Google or AgentID sign-in that comes back to `callbackURL`. On success the
 * browser leaves the page; on failure `onError` gets the reason and every option
 * comes back.
 */
export function useSocialSignIn(
  providers: SocialProvider[],
  callbackURL: string,
  onError: (message: string | null) => void,
): SocialSignIn {
  const [redirectingTo, setRedirectingTo] = useState<SocialProvider | null>(null);
  // Going Back from the provider can restore this page from the back/forward
  // cache, state and all, so the options would stay on "Redirecting...".
  // A restore fires `pageshow` with `persisted`; that clears it.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirectingTo(null);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  async function signIn(provider: SocialProvider) {
    setRedirectingTo(provider);
    onError(null);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (!result?.error) return;
      onError(result.error.message || START_FAILED);
    } catch {
      onError(START_FAILED);
    }
    setRedirectingTo(null);
  }

  return { providers, redirectingTo, signIn: (provider) => void signIn(provider) };
}
