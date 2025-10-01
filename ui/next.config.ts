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
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: http:",
              "font-src 'self' data:",
              "connect-src 'self' https: http: ws: wss:",
              "frame-src https: http:", // Block data:, javascript:, file: protocols
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
