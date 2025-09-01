import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Handle traceroot-sdk-ts server-side bundling issues
      config.externals = config.externals || [];
      config.externals.push({
        // AWS and HTTP related
        'winston-cloudwatch-logs': 'commonjs winston-cloudwatch-logs',
        '@aws-sdk/node-http-handler': 'commonjs @aws-sdk/node-http-handler',
        'http2': 'commonjs http2',

        // Node.js built-ins
        'fs': 'commonjs fs',
        'path': 'commonjs path',
        'os': 'commonjs os',
        'util': 'commonjs util',
        'child_process': 'commonjs child_process',
        'stream': 'commonjs stream',
        'crypto': 'commonjs crypto',
        'events': 'commonjs events',
        'url': 'commonjs url',

        // Development tools that shouldn't be bundled
        'typescript': 'commonjs typescript',
        'ts-node': 'commonjs ts-node',
        'coffee-script': 'commonjs coffee-script',
        'vm2': 'commonjs vm2',
        'v8-compile-cache': 'commonjs v8-compile-cache',
        'v8-compile-cache-lib': 'commonjs v8-compile-cache-lib',

        // Optional dependencies that might be dynamically loaded
        '@swc/core': 'commonjs @swc/core',
        '@swc/helpers': 'commonjs @swc/helpers',
        'esbuild': 'commonjs esbuild',
        'source-map-support': 'commonjs source-map-support'
      });

      // Resolve modules properly
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        util: false,
        http2: false,
        child_process: false,
        stream: false,
        crypto: false,
        events: false,
        url: false,
        'coffee-script': false,
        vm2: false,
        typescript: false,
        'ts-node': false,
        'v8-compile-cache': false,
        'v8-compile-cache-lib': false,
        '@swc/core': false,
        '@swc/helpers': false,
        esbuild: false,
        'source-map-support': false,
      };
    }

    // Ignore dynamic require warnings for known patterns
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /node_modules\/typescript\/lib\/typescript\.js/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
      {
        module: /node_modules\/ts-node\/dist/,
        message: /(Critical dependency|require\.extensions is not supported)/,
      },
      {
        module: /node_modules\/v8-compile-cache/,
        message: /Critical dependency: require function is used in a way in which dependencies cannot be statically extracted/,
      },
      {
        module: /traceroot-sdk-ts.*\/dist\/utils\/configLoader\.js/,
        message: /Critical dependency: the request of a dependency is an expression/,
      }
    ];

    return config;
  },
  serverExternalPackages: ['traceroot-sdk-ts'],
  eslint: {
    // 🚫 Completely skip ESLint during builds
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
