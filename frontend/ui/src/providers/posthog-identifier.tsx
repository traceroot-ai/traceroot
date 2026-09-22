"use client";

import { usePostHog } from "posthog-js/react";
import { useSession } from "@/lib/auth-client";
import { useEffect } from "react";

export function PostHogIdentifier() {
  const { data: session, isPending } = useSession();
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog || isPending) return;
    if (!session?.user) {
      if (posthog.get_property("$user_state") === "identified") {
        posthog.reset();
      }
      return;
    }
    if (session.session?.impersonatedBy) return;
    posthog.identify(session.user.id, {
      email: session.user.email,
      name: session.user.name,
    });
  }, [session, isPending, posthog]);

  return null;
}
