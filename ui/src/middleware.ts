import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

// Define public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/auth-callback(.*)",
  "/api/autumn(.*)",
]);

// Self-host mode: skip all Clerk authentication
const selfHostMiddleware = () => {
  return NextResponse.next();
};

// Cloud mode: use Clerk authentication
const cloudMiddleware = clerkMiddleware(async (auth, req) => {
  // Allow public routes without auth
  if (isPublicRoute(req)) {
    return;
  }

  // Protect all other routes - redirect to sign-in if not authenticated
  await auth.protect();
});

export default LOCAL_MODE ? selfHostMiddleware : cloudMiddleware;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
