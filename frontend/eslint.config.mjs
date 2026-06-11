import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    // These trees are bundled by Next.js, and Turbopack (`next dev`) cannot
    // resolve NodeNext-style relative `.js` imports to `.ts` sources the way
    // webpack's extensionAlias could. Relative imports here must use real
    // `.ts` extensions; the packages' tsc builds rewrite them to `.js` in
    // dist via rewriteRelativeImportExtensions.
    files: [
      "ui/src/**/*.{ts,tsx}",
      "packages/core/src/**/*.ts",
      "packages/slack/src/**/*.ts",
      "packages/github/src/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./**/*.js", "../**/*.js"],
              message:
                "Use the real .ts extension for relative imports (Turbopack does not resolve .js → .ts).",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "packages/core/src/generated/**",
      "**/*.config.js",
    ],
  },
];
