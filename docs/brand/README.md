# Documentation brand assets

These are local snapshots of the matching assets in `traceroot-website`.
Keeping them in this content root lets Mintlify build and serve documentation
without loading the marketing site's JavaScript or depending on its asset URLs.

| Asset | Source in `traceroot-website` |
| --- | --- |
| `../logo/favicon.png` | `client/public/favicon.png`, copied byte for byte so the docs tab icon matches the website and app |
| `fonts.css` | `client/public/redesign/9b6f5ff45b278c74.woff2` (Geist) and `client/public/redesign/5f3d6ad60f29d6cb.woff2` (Geist Mono), embedded as data URLs in variable-weight `@font-face` rules |
| `footer-wordmark.svg` | `client/public/brand/footer-wordmark.svg`, copied byte for byte from the website |
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

Copy the website SVG to this directory whenever the footer artwork changes.
The website quality workflow compares its asset with this copy at a pinned
docs commit. Update the pin when syncing a new version. The image is decorative;
the navigation logo supplies the accessible brand name.

`docs.json` declares native footer links and social destinations. `footer.js`
enhances the advanced `#footer` with the brand wordmark and four-group layout.
It keeps native nodes in place and isolates their structure checks
and article alignment in one adapter. Removing or failing to load the script
leaves the native links visible. Check this boundary after Mintlify client
upgrades and on generated API pages.

## Analytics ownership

Mintlify owns the PostHog integration configured in `docs.json`, including its
initialization, persistence and default collection policy. The footer only
handles presentation; it has no cookie-preferences UI and
neither accesses a visitor SDK nor reads or writes analytics consent storage.
