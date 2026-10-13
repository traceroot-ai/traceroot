"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";
import { captureBrowserAttribution } from "@/lib/marketing-attribution-browser";
import { useSession } from "@/lib/auth-client";

export function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const posthog = usePostHog();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    // RootLayout runs identification/reset first. Do not send the landing page
    // under a stale account while the session is still being resolved.
    if (!isPending && !session?.session?.impersonatedBy && pathname && posthog) {
      captureBrowserAttribution();
      posthog.capture("$pageview", { $current_url: window.location.href });
    }
  }, [pathname, searchParams, posthog, isPending, session?.session?.impersonatedBy]);

  return null;
}
