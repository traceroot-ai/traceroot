import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { AppLayout } from "@/components/layout/app-layout";
import { PHProvider } from "@/providers/posthog-provider";
import { PostHogPageView } from "@/providers/posthog-pageview";
import { PostHogIdentifier } from "@/providers/posthog-identifier";
import { Suspense } from "react";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "traceroot",
  description: "traceroot: the open-source platform that continuously improves your ai agents.",
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
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
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
