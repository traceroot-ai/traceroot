"use client";

import { useAuth } from "@/lib/auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

interface AuthGuardProps {
  children: React.ReactNode;
  isPublicRoute?: boolean;
}

// Routes that don't require authentication
const publicRoutes = ["/auth/auth-callback", "/sign-in"];

const IS_AUTH_DISABLED =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

export default function AuthGuard({
  children,
  isPublicRoute = false,
}: AuthGuardProps) {
  const { user, isLoaded, isAuthenticated } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // If auth is disabled, always allow access
  if (IS_AUTH_DISABLED) {
    return <>{children}</>;
  }

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
