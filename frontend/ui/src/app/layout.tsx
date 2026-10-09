import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { AppLayout } from "@/components/layout/app-layout";
import { PHProvider } from "@/providers/posthog-provider";
import { PostHogPageView } from "@/providers/posthog-pageview";
import { PostHogIdentifier } from "@/providers/posthog-identifier";
import { Suspense } from "react";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TraceRoot",
  description: "Observability and self-improving layer for AI agents",
  icons: {
    icon: "/images/favicon.ico",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set per request by proxy.ts for the page's Content-Security-Policy. Reading it
  // also renders every page per request, which the policy needs: a prerendered
  // page has no nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <PHProvider>
          <Suspense fallback={null}>
            <PostHogPageView />
          </Suspense>
          <PostHogIdentifier />
          <Providers nonce={nonce}>
            <AppLayout>{children}</AppLayout>
          </Providers>
        </PHProvider>
      </body>
    </html>
  );
}
