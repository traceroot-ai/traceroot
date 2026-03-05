const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@traceroot/core"],
  // Include monorepo root so standalone output traces deps outside ui/
  outputFileTracingRoot: path.join(__dirname, "../"),
  // Force-include Prisma engine binary (pnpm symlinks break automatic tracing).
  // Paths are relative to the Next.js project root (ui/), so ../node_modules
  // reaches the workspace root where pnpm hoists the Prisma client.
  outputFileTracingIncludes: {
    "/*": ["../node_modules/.prisma/**/*"],
  },
};

module.exports = nextConfig;
