# @traceroot-ai/tools

TraceRoot's tool registry: generated from the public OpenAPI schema, one definition per tool,
dispatched generically by the CLI, MCP, and in-app agent surfaces.

```bash
npm install @traceroot-ai/tools   # Node >= 24
```

## What's inside

Everything public is re-exported from [`src/index.ts`](./src/index.ts):

| Export                                         | What it is                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `REGISTRY`                                     | The generated tool definitions (`RegistryEntry[]`)                                |
| `generateRegistry`                             | Builds registry entries from an OpenAPI document                                  |
| `ApiClient`, `bearerAuth`, `internalAuth`      | API client, plus request headers for API-key or internal service access           |
| `dispatch`, `fillPath`                         | Runs any registry entry against the API; fills `{param}` path placeholders        |
| `toPiAgentTool`                                | Adapts a registry entry to the pi agent tool shape                                |
| `INTERNAL_BINDINGS`, `INTERNAL_WRITE_BINDINGS` | Internal project-scoped routes, per tool, for surfaces that call the internal API |

## Development

The registry is generated from `backend/rest/openapi/public.json`. After changing the public
API, regenerate and commit the result; `registry-drift.test.ts` fails if the committed registry is
stale.

```bash
cd frontend
pnpm --filter @traceroot-ai/tools generate   # rewrite src/registry.generated.ts
pnpm --filter @traceroot-ai/tools build
pnpm --filter @traceroot-ai/tools test
```

Inside this repo, `frontend/ee/agent` depends on the package as `workspace:*`, so it picks up
changes without a publish. Publishing only matters for consumers outside the repo, such as
[`traceroot-cli`](https://github.com/traceroot-ai/traceroot-cli).

## Releasing

This package is versioned independently of the TraceRoot platform, and it **publishes silently**:
no git tag, no GitHub Release, no Discord announcement. Tags and releases in this repo are reserved
for `vX.Y.Z` platform releases.

A release is a normal PR that bumps the version. When it merges to `main`,
[`publish-tools.yml`](../../../.github/workflows/publish-tools.yml) sees a version that is not on
npm yet, builds, tests, and publishes it with provenance over npm trusted publishing.

### 1. Bump the version and write the changelog

```bash
git switch main && git pull
git switch -c chore/tools-0.3.0

cd frontend/packages/tools
npm version minor --no-git-tag-version   # patch | minor | major
```

Pre-1.0: `minor` for new tools or breaking changes, `patch` for fixes. `--no-git-tag-version` keeps
npm from creating a commit or a `vX.Y.Z` tag, which would look like a platform release.

Then add a section to the top of [`CHANGELOG.md`](./CHANGELOG.md):

```markdown
## 0.3.0 (YYYY-MM-DD)

- ...
```

### 2. Open a PR and merge it

```bash
git add package.json CHANGELOG.md
git commit -m "chore(tools): release 0.3.0"
git push -u origin chore/tools-0.3.0
gh pr create --fill
```

Merging is the release. Nothing else to run.

### 3. Confirm it published

```bash
gh run list --workflow publish-tools.yml --limit 1
npm view @traceroot-ai/tools version    # -> 0.3.0
```

### 4. Pick it up in the CLI

In `traceroot-cli`, which pins an exact version:

```bash
npm install --save-exact @traceroot-ai/tools@0.3.0
```

The CLI's own release notes are where tool changes reach users.

### Don't

- **Don't run `gh release create tools-v…` or push a `tools-v*` tag.** It lands on the platform's
  releases page and could be read as the platform version. It also no longer publishes anything.
- **Don't run `npm publish` locally.** It skips the CI build and tests and has no provenance.
- **Don't reuse a version.** npm versions are immutable, even after an unpublish.

### Troubleshooting

- **The workflow ran but published nothing.** The version in `package.json` is already on npm; the
  run's summary says so. Bump the version.
- **The publish failed after the version merged.** Fix the cause on `main`, then re-run it. It
  publishes `main`'s version only if that version is still missing from npm:

  ```bash
  gh workflow run publish-tools.yml --ref main
  ```
