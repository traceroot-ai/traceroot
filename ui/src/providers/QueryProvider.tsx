"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // query client config
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Cache TTL for 10 minutes
            staleTime: 10 * 60 * 1000,
            // Cache data for 15 minutes after last use
            gcTime: 15 * 60 * 1000,
            // No auto refetching on window focus
            refetchOnWindowFocus: false,
            // Retry only once after failure
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
