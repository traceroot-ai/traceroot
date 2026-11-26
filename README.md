# Workspace invitation verification

PR #3379. Base `c5bdaaceb`; verified head `56a4b6ad9`.

- `local-e2e.json` records Chrome verification with the local application, real PostgreSQL and a local SMTP inbox. `company-choice-*.png` shows the actual registration flow.
- `before-*`, `after-*` and `diff-*` compare the actual Next.js page with a fixed fresh company account. All captures have zero horizontal overflow.
- `before.webm` shows the previous automatic create request. `after.webm` shows the invitation guidance and creation only after the button is clicked. The fixtures hold the create request open so the transition is visible.

| Element | Light contrast | Dark contrast |
| --- | ---: | ---: |
| Create button text | 19.19:1 | 17.18:1 |
| Invitation guidance on card | 6.70:1 | 7.70:1 |
| Focus ring on card | 5.04:1 | 7.44:1 |
