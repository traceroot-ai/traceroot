# traceroot Documentation Guidelines

This directory contains the Mintlify documentation source for traceroot.

## Local preview

Run the pinned Mintlify CLI from this directory (Node.js 24 LTS is recommended):

```bash
npx --yes mint@4.2.1204 dev --no-open --no-telemetry --port 3000
```

Open `http://localhost:3000/getting-started/introduction`. The CLI's native dev
server serves from `/`; it does not support a `/docs` base path. Search and the
Assistant require a connected Mintlify project. This preview preserves their
native UI rather than substituting a local search or AI implementation.

To enter this local preview through the website, run the following in the sibling
`traceroot-website` checkout:

```bash
VITE_DOCS_DEV_URL=http://localhost:3000 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort
```

Visit `http://127.0.0.1:5175` and select **Docs**. In the development browser,
the link opens the configured Mintlify origin directly. Both development
processes must remain running. Production builds and server rendering always
use the published documentation URL; no local `/docs` redirect is added.

Validate changes with the same CLI version:

```bash
npx --yes mint@4.2.1204 validate
npx --yes mint@4.2.1204 broken-links
```

From the repository root, run `node --test tests/docs-*.test.mjs` for
analytics isolation, functional color and embedded font checks. These also run in CI.

## Brand styling

`docs.json` owns the theme, logo and navigation. `custom.css` uses Mintlify's
public layout IDs, component parts and width variables; the Introduction's
connected capability grid has its own `tr-capabilities` class. Original article
content, paths, metadata and the OpenAPI generation chain stay in place.

The current release is light-only. `appearance.default: "light"` and
`appearance.strict: true` in `docs.json` use Mintlify's native policy to force
light mode and hide the theme switch, including for visitors with a dark system
theme or a saved dark preference. Do not override the theme with CSS or rewrite
visitors' stored preferences. Only the approved light styles and assets ship.
After dark-mode design approval, implement and validate that theme before
changing the configuration policy.

The mint theme's hidden, inert Assistant bar is collapsed only in that semantic
state, so it does not leave an empty block before the footer. When Mintlify makes
the bar available, its native sticky layout remains active.

`docs.json` owns the native footer links in Product, Company, Trust and Community
groups. `footer.css` styles the groups in one outlined box, with two columns on
narrow screens. `footer.js` adds the animated wordmark. A bounded layout
adapter aligns the advanced footer to the article
and pagination without moving Mintlify-owned nodes or changing sidebar
scrolling. It refreshes on `mintlify:navigate` and observes article resizing;
it does not poll for the footer. Without the script, native links remain visible.
It adds no framework or analytics SDK.
The analytics ownership is documented in `brand/README.md`. Mintlify retains
its existing integration behavior.

`favicon.js` swaps Mintlify's generated tab icons for the website's 192px
`logo/favicon.png`, so the tab icon matches the website's size.

Brand assets and fonts are snapshots of the website, with sources listed in
`brand/README.md`. `brand/fonts.css` embeds both website WOFF2 snapshots so the
same CSS works at the local root and the production `/docs` subpath without a
root-level `/brand` proxy. `custom.css` sets Mintlify's heading and body font
variables. No `fonts` setting is needed in `docs.json`, which avoids Mintlify's
cross-origin font rewriting and automatic Google Fonts requests. Keep the
embedded sources in sync if the fonts change. The footer wordmark uses a
standalone export of the website Home animation and its CSS defaults, with a
static fallback if Canvas is unavailable.
Sync and verification instructions are in `brand/README.md`.
Functional turquoise text uses a darker tone for contrast;
Mintlify's functional primary also covers API field names and response tabs.
The original bright accent is retained for decorative elements.

After changing these files or upgrading Mintlify, inspect Introduction,
Quickstart, Integrations and a generated API endpoint at 1440px, 1024px, 768px and
390px. Verify light mode under both light/dark system preferences and a saved
dark preference, with no theme switch. Include mobile navigation, native copying,
client-side navigation/back/forward, footer fallback, and horizontal overflow.
Mintlify's preview and the production `/docs` deployment must both be checked for assets,
search/Assistant, Markdown export and canonical/sitemap behavior.

## Integration Documentation Template

All framework/provider integration pages under `docs/integrations/` follow a standard structure with eight sections in order:

1. **Install (`## Install`)**:
   Provide installation commands (`pip install` and/or `npm install`) for each supported language, explicitly naming `traceroot` or `@traceroot-ai/traceroot`, any required pip extras, and the underlying framework or provider package.

2. **Set up (`## Set up`)**:
   Show the initialization code snippet (`traceroot.initialize()` or `TraceRoot.initialize()`).

3. **Usage (`## Usage`)**:
   Provide a concise, runnable code sample demonstrating tracing with the provider or framework.

4. **Verify (`## Verify`)**:
   Tell the reader how to confirm their trace arrived:
   - In the traceroot UI under **Tracing > Traces** (specifying the root span name).
   - Via the CLI with `traceroot traces list`.

5. **What gets captured (`## What gets captured`)**:
   A table listing attributes captured on spans (e.g. Model, Messages, Response, Tool calls, Tokens, Latency).

6. **Limitations (`## Limitations`)**:
   Document known caveats, required extras, or state "None known."

7. **Run the example (`## Run the example`)**:
   Link to the runnable sample in `examples/`.

8. **Next steps (`## Next steps`)**:
   Provide at least two internal documentation links (such as the SDK reference and cost tracking).

Coding agent pages link the plugin repository in Run the example.
