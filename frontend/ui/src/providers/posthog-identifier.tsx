"use client";

import { usePostHog } from "posthog-js/react";
import { useSession } from "@/lib/auth-client";
import { useEffect } from "react";
import { attributionPersonProperties } from "@/lib/marketing-attribution";
import {
  captureBrowserAttribution,
  clearBrowserAttribution,
} from "@/lib/marketing-attribution-browser";

export function PostHogIdentifier() {
  const { data: session, isPending } = useSession();
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog || isPending) return;
    if (!session?.user) {
      if (posthog.get_property("$user_state") === "identified") {
        posthog.reset();
        // Do not transfer a previous account's touch to a different person.
        // Preserve a fresh campaign on this landing page after the reset.
        clearBrowserAttribution();
        captureBrowserAttribution(true);
      }
      return;
    }
    if (session.session?.impersonatedBy) return;
    posthog.identify(session.user.id, {
      email: session.user.email,
      name: session.user.name,
      // Explicitly backfill the most recent campaign for anonymous arrivals.
      // PostHog continues to own its immutable $initial_utm_* properties.
      ...attributionPersonProperties(captureBrowserAttribution()),
    });
    // Signup's server hook has the request-cookie snapshot already. Once this
    // touch is assigned, don't leave it available for another account to claim.
    clearBrowserAttribution();
  }, [session, isPending, posthog]);

  return null;
}
