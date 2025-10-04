import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Only apply middleware to /api routes
  if (!request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // Clone the request headers
  const requestHeaders = new Headers(request.headers);

  // Special handling for Autumn routes - they use cookie-based auth
  if (request.nextUrl.pathname.startsWith("/api/autumn/")) {
    // Autumn route handles its own cookie-based authentication
    // No need to extract JWT here
    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  }

  // For all other API routes, extract JWT from Authorization header
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Return 401 if Authorization header is missing or invalid
    return NextResponse.json(
      {
        success: false,
        error:
          "Missing or invalid Authorization header. Expected: Bearer <user_secret>",
      },
      { status: 401 },
    );
  }

  // Extract the token (remove 'Bearer ' prefix)
  const token = authHeader.substring(7);

  // Add the token to request headers for downstream use
  // This allows API routes to access it via request.headers.get('x-user-token')
  requestHeaders.set("x-user-token", token);

  // You can also add the full Authorization header if not already present
  if (!requestHeaders.has("authorization")) {
    requestHeaders.set("authorization", authHeader);
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

// Configure which routes the middleware should run on
export const config = {
  matcher: [
    // Match all API routes except static files
    "/api/:path*",
  ],
};
