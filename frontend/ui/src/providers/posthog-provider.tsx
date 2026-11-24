"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { scrubCaptureResult } from "@/lib/analytics-scrub";

if (
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_POSTHOG_KEY &&
  process.env.NEXT_PUBLIC_POSTHOG_HOST
) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    ui_host: "https://us.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: false,
    capture_pageleave: true,
    // Secret query parameters (a password reset link's token) never leave the browser.
    before_send: (result) => scrubCaptureResult(result),
    loaded: (ph) => {
      if (process.env.NODE_ENV === "development") ph.debug();
    },
  });
}

export function PHProvider({ children }: { children: React.ReactNode }) {
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
