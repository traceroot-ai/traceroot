"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeToQueryInvalidations } from "@/lib/cross-tab-sync";

/**
 * Bridges query invalidations across browser tabs: when another tab reports
 * it wrote data, refetch the matching queries here so every tab converges
 * without a manual refresh. Renders nothing.
 */
export function CrossTabQuerySync() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToQueryInvalidations((queryKey) => {
        void queryClient.invalidateQueries({ queryKey });
      }),
    [queryClient],
  );

  return null;
}
