# Documentation brand assets

These are local snapshots of the matching assets in `traceroot-website`.
Keeping them in this content root lets Mintlify build and serve documentation
without loading the marketing site's JavaScript or depending on its asset URLs.

| Asset | Source in `traceroot-website` |
| --- | --- |
| `fonts.css` | `client/public/redesign/9b6f5ff45b278c74.woff2` (Geist) and `client/public/redesign/5f3d6ad60f29d6cb.woff2` (Geist Mono), embedded as data URLs in variable-weight `@font-face` rules |
| `footer-wordmark.svg` | Static export of `PIX` glyphs and Bayer dithering in `client/src/components/redesign/footer-wordmark.ts` |
| `footer-wordmark.runtime.js` | Generated standalone IIFE of Home's `footer-wordmark.ts`, `animation-scope.ts`, `motion-loop.ts` and CSS defaults; no React or external requests |
| `logo-light.svg` | Website `mark.svg` with the Geist wordmark converted to SVG outlines using a temporary fontkit tool; no runtime dependency |

The Geist font snapshots are Copyright 2024 The Geist Project Authors and are
distributed under the SIL Open Font License 1.1 in `OFL.txt`, copied from the
upstream `vercel/geist-font` 1.4.2 release. Font metadata is retained unchanged.

`custom.css` selects the embedded Geist family through Mintlify's heading and
body font variables. Leave the native `fonts` configuration unset: local paths
can be rewritten to a cross-origin asset host, and a family alone requests
Google Fonts. The embedded sources are the only font copies in this content root.
When updating a snapshot, regenerate its base64 source in `fonts.css` from the
website file listed above and run `node --test tests/docs-*.test.mjs` from the
repository root. Verify the deployed font faces are loaded, including on `/docs`,
rather than checking only the computed family name.

The wordmark uses Home's original 800:128 canvas, pixel glyphs, ink, dithering,
speed and still-mode setting. Still mode disables assembly/scattering while
retaining the turquoise sweep, exactly as configured on Home. Its original
motion helpers pause offscreen and in hidden tabs, and settle for reduced motion.
The adapter disposes the animation on removal. The SVG is a decorative fallback;
the footer's HTML logo supplies the accessible brand name. Docs use only the
light theme.

The website TS implementation is the only handwritten animation source. After
changing it or Home's wordmark defaults, run these commands from the sibling
`traceroot-website` checkout with its existing dependencies installed:

```bash
node scripts/export-docs-wordmark.mjs ../traceroot/docs
node scripts/export-docs-wordmark.mjs ../traceroot/docs --check
node --test tests/docs-wordmark.test.mjs
```

Commit the generated runtime with the docs changes. Its header records the
source SHA-256, covering the animation sources and the defaults it consumes.
The website quality workflow checks this export against a pinned public docs
commit; update the pin when intentionally updating the snapshot. Docs
deployment needs no website checkout or build step.
The IIFE registers a factory and emits a ready event; `footer.js` handles either
script order. It does not load a live marketing bundle. Match the static SVG
fallback if the glyphs change. Verify light mode under light/dark system
preferences, reduced motion, repeated navigation/disposal and the `/docs`
deployment after syncing.

When updating the website's brand assets, review the corresponding docs snapshots
and test light mode plus narrow screens. Do not copy website components
or framework dependencies into these files; regenerate the standalone animation.

`docs.json` declares native footer links and social destinations. `footer.js`
enhances the advanced `#footer` with the existing legal controls and brand
wordmark. It keeps native nodes in place and isolates their structure checks
and article alignment in one adapter. Removing or failing to load the script
leaves the native links visible. Check this boundary after Mintlify client
upgrades and on generated API pages.

## Analytics preference boundary

Mintlify owns the PostHog integration configured in `docs.json`, including its
initialization and existing persistence behavior. The footer only presents the
website-preferences fallback: its Cookie settings dialog links to the existing
preferences in the traceroot.ai footer. It neither accesses a visitor SDK nor
reads or writes analytics consent storage.

Website preferences may not apply to this documentation, as the dialog states.
Managing consent directly in Docs requires a supported Mintlify integration;
a module-private SDK or a hypothetical global instance is not such a contract.
The integration configuration and its default collection policy stay unchanged.
