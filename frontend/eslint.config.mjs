import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// These trees are bundled by Next.js, and Turbopack (`next dev`) cannot resolve
// NodeNext-style relative `.js` imports to `.ts` sources the way webpack's
// extensionAlias could. Relative imports here must use real `.ts` extensions;
// the packages' tsc builds rewrite them to `.js` in dist via
// rewriteRelativeImportExtensions.
//
// Hoisted because `no-restricted-imports` options are replaced wholesale rather
// than merged, so every block that sets the rule has to restate these.
const relativeImportPatterns = [
  {
    group: ["./**/*.js", "../**/*.js"],
    message:
      "Use the real .ts extension for relative imports (Turbopack does not resolve .js → .ts).",
  },
];

// Glyphs owned by the domain-icon registry. Picking these directly per file is
// what let one concept drift to several glyphs across the app. Matched by
// pattern so lucide's `*Icon` suffix and `Lucide*` prefix forms, plus its
// deprecated aliases (all of which resolve to the same component), can't sneak
// past the ban.
//
// Only glyphs with a single meaning in this app are listed. Eye (password
// visibility), Hash (Slack channel), Clock (durations), ArrowRight (CTA),
// Sparkle ("magic") and CircleAlert (generic warnings) each have an unrelated
// second use, so they stay free. CheckCircle2 — the deprecated alias of the
// status glyph — is also free for now: two surfaces use it for a success state
// the registry has no entry for yet, and banning it would force a migration
// that belongs in its own change.
const registryGlyphPattern =
  "^(Lucide)?(Bot|BotMessageSquare|Box|CircleCheck|CircleDollarSign|CircleStop|StopCircle|" +
  "FolderKanban|Globe|Layers|Layers3|LayoutDashboard|LayoutGrid|Shapes|Users|" +
  "Workflow|Wrench)(Icon)?$";

// The public demo workspace has every user as a member. A query over one user's
// memberships must say whether the demo counts, or it silently changes things
// like onboarding and the "only workspace" guard. These selectors reject a
// hand-written per-user `where` (one with userId but no workspaceId) and a
// list of all workspaces; use userMembershipWhere() / isDemoWorkspace() from
// ui/src/lib/demo-workspace.ts, or say why the demo is fine with an
// eslint-disable comment.
const demoWorkspaceQueryRestrictions = [
  {
    selector:
      "CallExpression[callee.object.property.name='workspaceMember'][callee.property.name=/^(findMany|findFirst|count)$/] > ObjectExpression > Property[key.name='where'] > ObjectExpression:has(> Property[key.name='userId']):not(:has(> Property[key.name='workspaceId']))",
    message:
      'Build a per-user membership `where` with userMembershipWhere(userId, "include-demo" | "exclude-demo") from @/lib/demo-workspace, so the query chooses whether the demo workspace counts.',
  },
  {
    selector:
      "CallExpression[callee.object.property.name='workspace'][callee.property.name='findMany']",
    message:
      "A list of all workspaces includes the demo workspace (DEMO_WORKSPACE_ID). Filter it with isDemoWorkspace(), or say why it belongs in the list with an eslint-disable-next-line comment.",
  },
];

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
    files: [
      "ui/src/**/*.{ts,tsx}",
      "packages/core/src/**/*.ts",
      "packages/slack/src/**/*.ts",
      "packages/github/src/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: relativeImportPatterns }],
    },
  },
  {
    // The registry lives in the Next app, so the ban is scoped there — the
    // packages above don't depend on lucide-react and couldn't resolve the
    // `@/` alias the message points at.
    files: ["ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...relativeImportPatterns,
            {
              group: ["lucide-react"],
              importNamePattern: registryGlyphPattern,
              message:
                "Import the concept from @/components/icons/domain-icons (DOMAIN_ICONS) instead of picking the lucide glyph directly.",
            },
          ],
        },
      ],
    },
  },
  {
    // The registry defines the concept -> glyph mapping, and icon-identity
    // tests assert against the glyphs themselves, so both must import lucide
    // directly. The relative-import guard still applies to them.
    files: ["ui/src/components/icons/domain-icons.ts", "ui/src/**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: relativeImportPatterns }],
    },
  },
  {
    files: ["ui/src/**/*.{ts,tsx}"],
    ignores: ["**/*.{test,spec}.{ts,tsx}", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": ["error", ...demoWorkspaceQueryRestrictions],
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
