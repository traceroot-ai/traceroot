"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";
import { CrossTabQuerySync } from "@/components/cross-tab-query-sync";

interface ProvidersProps {
  children: ReactNode;
  // The page's Content-Security-Policy nonce (see proxy.ts).
  nonce?: string;
}

export function Providers({ children, nonce }: ProvidersProps) {
  //useState + lazy init, ensure only one QueryClient is created under HMR
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <CrossTabQuerySync />
      {/* next-themes sets the theme with an inline script before first paint;
          the nonce lets the page's Content-Security-Policy run it. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        nonce={nonce}
      >
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
