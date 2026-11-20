"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

// /onboarding's own URL, for a round trip that has to come back to it. Whatever a
// waiting `traceroot setup` terminal is polling against travels on it, because
// a sign-in that drops `callbackUrl` strands that terminal for the whole
// device-code lifetime with nothing left pointing back at the handoff.
//
// `?workspaceId=` is deliberately not carried. It names a workspace owned by
// the account being signed *out* of, and the point of the round trip is to come
// back as someone else — who cannot add a project to it. An account that signs
// back in as itself gets the parameter re-derived from /onboarding's setup
// check, so nothing is lost either way.
function onboardingReturnUrl(returnTo: string | null): string {
  return returnTo === null
    ? "/onboarding"
    : `/onboarding?callbackUrl=${encodeURIComponent(returnTo)}`;
}

// Sign-in, returning to /onboarding afterwards. better-auth stores the whole
// callbackUrl — query included — in the OAuth state and redirects to it
// verbatim, so the hand-back survives the Google hop and not just an email
// sign-in. Shared by the signed-out redirect and "Not you? Sign out" so the two
// cannot drift, which is how /device says the same thing (see deviceSignInUrl).
export function onboardingSignInUrl(returnTo: string | null): string {
  return `/auth/sign-in?callbackUrl=${encodeURIComponent(onboardingReturnUrl(returnTo))}`;
}

/**
 * "Not you? Sign out" for the sign-up steps that have no app shell, and so no
 * user menu: sign out, then sign in again and start /onboarding over as that
 * account, keeping a waiting terminal's hand-back (`returnTo`).
 *
 * `before` is waited for first: work still in flight for the account being
 * left (the questions' answers) lands on that account, not nowhere.
 */
export function useSwitchAccount(returnTo: string | null) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchAccount(before?: Promise<unknown>) {
    setSwitching(true);
    setError(null);
    await before?.catch(() => {});
    let cleared: boolean;
    try {
      // The client answers an HTTP failure in `error` and rejects only when the
      // request never completed, so both have to be read before the session can
      // be called cleared. A rate limit or a proxy error leaves the cookie in
      // place, and leaving on it sends the user to a sign-in that the live
      // session hands straight back here as the same account.
      const { error: signOutError } = await authClient.signOut();
      cleared = !signOutError;
    } catch {
      cleared = false;
    }
    if (!cleared) {
      setError("Could not sign out. Please try again.");
      setSwitching(false);
      return;
    }
    router.push(onboardingSignInUrl(returnTo));
  }

  return { switching, error, switchAccount };
}
