const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@traceroot/core", "@traceroot/github", "@traceroot/slack"],
  // Include monorepo root so standalone output traces deps outside ui/
  outputFileTracingRoot: path.join(__dirname, "../"),
  // Force-include Prisma engine binary (pnpm symlinks break automatic tracing).
  // Paths are relative to the Next.js project root (ui/), so ../node_modules
  // reaches the workspace root where pnpm hoists the Prisma client.
  outputFileTracingIncludes: {
    "/*": ["../node_modules/.prisma/**/*"],
  },
  // Our workspace packages are now `"type": "module"` and use NodeNext-style
  // `.js` imports for source files (e.g. `from "./lib/prisma.js"`). webpack
  // doesn't auto-resolve `.js` → `.ts` like tsx / vite-node do — this alias
  // tells it to try `.ts`/`.tsx` first, falling back to a real `.js`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

module.exports = nextConfig;
