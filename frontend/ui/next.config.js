const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.APP_VERSION || `v${require("./package.json").version}`,
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
