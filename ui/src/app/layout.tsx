import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AppSidebar from "@/components/side-bar/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { Toaster } from "react-hot-toast";
import { AutumnProvider } from "autumn-js/react";
import { ThemeProvider } from "@/components/theme-provider";
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
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} h-screen overflow-hidden`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AutumnProvider includeCredentials={true}>
            <AuthGuard>
              <SubscriptionGuard>
                {/* Make it false by default */}
                <SidebarProvider defaultOpen={false}>
                  <AppSidebar />
                  <SidebarInset>{children}</SidebarInset>
                </SidebarProvider>
              </SubscriptionGuard>
            </AuthGuard>
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
          </AutumnProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
