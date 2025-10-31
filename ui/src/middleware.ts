import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const IS_AUTH_DISABLED =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

// Define public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/auth-callback(.*)",
  "/api/autumn(.*)",
]);

export default function middleware(req: NextRequest) {
  // If auth is disabled, allow all requests
  if (IS_AUTH_DISABLED) {
    return NextResponse.next();
  }

  // Otherwise use Clerk middleware
  return clerkMiddleware(async (auth, req) => {
    // Allow public routes without auth
    if (isPublicRoute(req)) {
      return;
    }

    // Protect all other routes - redirect to sign-in if not authenticated
    await auth.protect();
  })(req);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
