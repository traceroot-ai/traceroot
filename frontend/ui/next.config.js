const { execSync } = require("child_process");
const path = require("path");

function resolveAppVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    // Only vX.Y.Z tags are platform versions; other tags must not become the label.
    return execSync("git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*'", {
      cwd: path.join(__dirname, "../"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

// Sent on every response, static assets included. Browsers ignore HSTS on
// plain-HTTP responses, so local and HTTP-only self-hosted setups are unaffected,
// and it leaves out includeSubDomains so a self-hosted deployment never pins the
// operator's other subdomains to HTTPS. Nothing embeds the app, so no page may
// be framed.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Don't advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: resolveAppVersion(),
  },
  transpilePackages: ["@traceroot/core", "@traceroot/github", "@traceroot/slack"],
  // Include monorepo root so standalone output traces deps outside ui/
  outputFileTracingRoot: path.join(__dirname, "../"),
  // Force-include Prisma engine binary (pnpm symlinks break automatic tracing).
  // Paths are relative to the Next.js project root (ui/), so ../node_modules
  // reaches the workspace root where pnpm hoists the Prisma client.
  outputFileTracingIncludes: {
    "/*": ["../node_modules/.prisma/**/*"],
  },
  // Pin Turbopack's project root to the monorepo root (matches
  // outputFileTracingRoot) instead of letting it infer one. Having a
  // turbopack key also keeps a bare `next dev` (no bundler flag) from
  // hard-exiting over the webpack config below.
  turbopack: {
    root: path.join(__dirname, "../"),
  },
  // The transpiled workspace packages (core/github/slack) import their own
  // sources with explicit `.ts` extensions (rewritten to `.js` in their tsc
  // dist builds via rewriteRelativeImportExtensions) because Turbopack has no
  // webpack-style extensionAlias. This alias stays as a safety net for
  // `next build --webpack` in case a NodeNext-style `.js` import sneaks back
  // in — webpack doesn't auto-resolve `.js` → `.ts` like tsx / vite-node do.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

module.exports = nextConfig;
