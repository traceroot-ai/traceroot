"use client";

import { useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

interface AuthGuardProps {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}

// Routes that don't require authentication
const publicRoutes = ["/auth/auth-callback", "/sign-in"];

const LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

export default function AuthGuard({
  children,
  isPublicRoute = false,
}: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Always call useUser to satisfy hooks rules, but ignore result in self-host mode
  const { user: clerkUser, isLoaded: clerkIsLoaded } = useUser();

  // In self-host mode, override with mock values
  const user = LOCAL_MODE ? { id: "local-user" } : clerkUser;
  const isLoaded = LOCAL_MODE ? true : clerkIsLoaded;

  // User is authenticated if they're logged in with Clerk or in self-host mode
  const isAuthenticated = LOCAL_MODE || !!user;

  // Check if current route is public (from prop or pathname)
  const isPublic = isPublicRoute || publicRoutes.includes(pathname);

  // Redirect to sign-in page if not authenticated
  useEffect(() => {
    if (isLoaded && !isAuthenticated && !isPublic) {
      router.push("/sign-in");
    }
  }, [isLoaded, isAuthenticated, isPublic, router, pathname]);

  // Allow access to public routes without authentication
  if (isPublic) {
    return <>{children}</>;
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
