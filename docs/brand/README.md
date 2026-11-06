# Documentation brand assets

These are local snapshots of the matching assets in `traceroot-website`.
Keeping them in this content root lets Mintlify build and serve documentation
without loading the marketing site's JavaScript or depending on its asset URLs.

| Asset | Source in `traceroot-website` |
| --- | --- |
| `mark.svg`, `github.svg`, `linkedin.svg`, `discord.svg` | `client/public/redesign/`, copied with repository newline normalization |
| `geist.woff2` | `client/public/redesign/9b6f5ff45b278c74.woff2`, copied unchanged |
| `geist-mono.woff2` | `client/public/redesign/5f3d6ad60f29d6cb.woff2`, copied unchanged |
| `geist-mono.css` | `geist-mono.woff2` embedded as a data URL in an `@font-face`; this avoids a root-relative font URL under the production `/docs` prefix |
| `footer-wordmark.svg` | Static export of `PIX` glyphs and Bayer dithering in `client/src/components/redesign/footer-wordmark.ts` |
| `footer-wordmark.runtime.js` | Generated standalone IIFE of Home's `footer-wordmark.ts`, `animation-scope.ts`, `motion-loop.ts` and CSS defaults; no React or external requests |
| `logo-light.svg`, `logo-dark.svg` | Website `mark.svg` with the Geist wordmark converted to SVG outlines using a temporary fontkit tool; no runtime dependency |

The Geist font snapshots are Copyright 2024 The Geist Project Authors and are
distributed under the SIL Open Font License 1.1 in `OFL.txt`, copied from the
upstream `vercel/geist-font` 1.4.2 release. Font metadata is retained unchanged.

The wordmark uses Home's original 800:128 canvas, pixel glyphs, ink, dithering,
speed and still-mode setting. Still mode disables assembly/scattering while
retaining the turquoise sweep, exactly as configured on Home. Its original
motion helpers pause offscreen and in hidden tabs, and settle for reduced motion.
The adapter disposes the animation on removal and remounts when the docs theme
changes. The SVG is a decorative fallback; the footer's HTML logo supplies the
accessible brand name.

The website TS implementation is the only handwritten animation source. After
changing it or Home's wordmark defaults, run these commands from the sibling
`traceroot-website` checkout with its existing dependencies installed:

```bash
node scripts/export-docs-wordmark.mjs ../traceroot/docs
node scripts/export-docs-wordmark.mjs ../traceroot/docs --check
node --test tests/docs-wordmark.test.mjs
```

Commit the generated runtime with the docs changes. Its header records the
source SHA-256. Docs deployment needs no website checkout or build step.
The IIFE registers a factory and emits a ready event; `footer.js` handles either
script order. It does not load a live marketing bundle. Match the static SVG
fallback if the glyphs change. Verify light/dark themes, reduced motion, repeated
navigation/disposal and the `/docs` deployment after syncing.

When updating the website's brand assets, review the corresponding docs snapshots
and test light/dark themes plus narrow screens. Do not copy website components
or framework dependencies into these files; regenerate the standalone animation.

`footer.js` enhances Mintlify's native `#footer` only after the custom stylesheet
and brand mark are available. Removing or failing to load that script leaves
the native footer visible. Its DOM dependency is intentionally isolated there;
check the footer after Mintlify client upgrades and on generated API pages.

## Analytics preference boundary

The adapter does not initialize or replace analytics. It only calls documented
PostHog consent methods if `window.posthog.get_config("token")` matches the
visitor-project public token configured in `docs.json`. If that token changes,
update the verification constant in `footer.js` together with the integration.
It uses the website's `traceroot-analytics-consent` key and `allowed` / `denied`
values on the same origin. A local preview can save only its own local choice.

Mintlify's local preview currently does not expose a visitor SDK. On a deployed
site without a verified SDK, the dialog explains that documentation preferences
cannot be applied and links to the working website preferences; it does not
pretend that saving a local key stopped an unknown collector. Production SDK
exposure and consent before its first event still need deployment verification.
Stored choices are applied at script initialization, window load, navigation,
storage changes and explicit saves. When a verified SDK is not ready, a single
bounded backoff chain retries for up to 9.5 seconds, reading the latest choice
each time. It stops on success, a missing choice, disposal or the retry limit.
No stored choice means no probes. This is best-effort synchronization of a late
SDK, not a guarantee of consent before its first event; that belongs to the
SDK initialization policy. No extra SDK is loaded.
