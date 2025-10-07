"use client";

import { useUser } from "@/hooks/useUser";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AuthGuardProps {
  children: React.ReactNode;
}

// Routes that don't require authentication
const publicRoutes = ["/auth/auth-callback"];

export default function AuthGuard({ children }: AuthGuardProps) {
  const { user, isLoading } = useUser();
  const pathname = usePathname();

  // Allow access to public routes without authentication
  if (publicRoutes.includes(pathname)) {
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <Dialog open={true}>
        <DialogContent className="sm:max-w-[425px]" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-center">
              Authentication Required
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col space-y-4 pt-4">
            <p className="text-center text-muted-foreground">
              Please sign in to access this application.
            </p>
            <Button asChild className="mx-auto">
              <a
                href="https://prod1.traceroot.ai/sign-in"
                target="_blank"
                rel="noopener noreferrer"
              >
                Sign In / Register
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return <>{children}</>;
}
