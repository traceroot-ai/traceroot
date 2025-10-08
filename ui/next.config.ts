import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable eslint during build
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Add security headers
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://clerk.traceroot.ai https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://clerk.traceroot.ai",
              "img-src 'self' data: https: http: https://*.clerk.accounts.dev https://clerk.traceroot.ai https://*.clerk.com",
              "font-src 'self' data:",
              "connect-src 'self' https: http: ws: wss: https://*.clerk.accounts.dev https://clerk.traceroot.ai https://*.clerk.com",
              "frame-src https: http: https://*.clerk.accounts.dev https://clerk.traceroot.ai", // Block data:, javascript:, file: protocols
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
