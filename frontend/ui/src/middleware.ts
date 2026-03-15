import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        // Allow auth pages without token
        if (req.nextUrl.pathname.startsWith("/auth/")) {
          return true;
        }
        // Require token for all other pages
        return !!token;
      },
    },
  },
);

export const config = {
  matcher: [
    // Protect all routes except:
    // - api/auth (NextAuth routes)
    // - api/internal (internal API for Python backend, uses X-Internal-Secret)
    // - api/billing/webhook (Stripe webhook, uses signature verification)
    // - auth/* (sign-in, sign-up pages)
    // - _next (Next.js internals)
    // - static files
    "/((?!api/auth|api/internal|api/billing/webhook|api/github/token|api/github/callback|api/github/install-callback|auth/|_next/static|_next/image|images/|favicon.ico).*)",
  ],
};
