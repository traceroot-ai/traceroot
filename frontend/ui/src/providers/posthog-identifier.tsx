"use client";

import { usePostHog } from "posthog-js/react";
import { useSession } from "@/lib/auth-client";
import { useEffect } from "react";

export function PostHogIdentifier() {
  const { data: session } = useSession();
  const posthog = usePostHog();

  useEffect(() => {
    if (session?.user && posthog) {
      posthog.identify(session.user.id, {
        email: session.user.email,
        name: session.user.name,
      });
    }
  }, [session, posthog]);

  return null;
}
