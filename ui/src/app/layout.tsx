import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AppSidebar from "@/components/side-bar/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { Toaster } from "react-hot-toast";
import { AutumnProvider } from "autumn-js/react";
import { ThemeProvider } from "@/providers/theme-provider";
import AuthGuard from "@/components/auth/AuthGuard";
import SubscriptionGuard from "@/components/auth/SubscriptionGuard";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TraceRoot.AI",
  description: "Agentic debugging tool",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Check if payment/subscription features should be disabled for local development
  const isPaymentDisabled = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

  // Core app content that's wrapped differently based on payment settings
  const AppContent = () => (
    <AuthGuard>
      <SubscriptionGuard>
        {/* Make sidebar collapsed by default */}
        <SidebarProvider defaultOpen={false}>
          <AppSidebar />
          <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
      </SubscriptionGuard>
    </AuthGuard>
  );

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} h-screen overflow-hidden`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* Conditionally wrap with AutumnProvider only when payment is enabled */}
          {isPaymentDisabled ? (
            // Local development mode - no subscription/payment features
            <AppContent />
          ) : (
            // Production mode - full subscription/payment features enabled
            <AutumnProvider includeCredentials={true}>
              <AppContent />
            </AutumnProvider>
          )}
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: "#363636",
                color: "#fff",
              },
              success: {
                duration: 3000,
                iconTheme: {
                  primary: "#4ade80",
                  secondary: "#fff",
                },
              },
              error: {
                duration: 5000,
                iconTheme: {
                  primary: "#ef4444",
                  secondary: "#fff",
                },
              },
              loading: {
                iconTheme: {
                  primary: "#3b82f6",
                  secondary: "#fff",
                },
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
