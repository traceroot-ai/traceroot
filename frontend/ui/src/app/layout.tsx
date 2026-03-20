import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppLayout } from "@/components/layout/app-layout";
import { PHProvider } from "@/providers/posthog-provider";
import { PostHogPageView } from "@/providers/posthog-pageview";
import { PostHogIdentifier } from "@/providers/posthog-identifier";
import { Suspense } from "react";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Traceroot",
  description: "AI Observability Platform",
  icons: {
    icon: "/images/favicon.ico",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <PHProvider>
          <Suspense fallback={null}>
            <PostHogPageView />
          </Suspense>
          <PostHogIdentifier />
          <Providers>
            <AppLayout>{children}</AppLayout>
          </Providers>
        </PHProvider>
      </body>
    </html>
  );
}
