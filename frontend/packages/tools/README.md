# @traceroot-ai/tools

TraceRoot's tool registry: generated from the public OpenAPI schema, one definition per tool,
dispatched generically by the CLI, MCP, and in-app agent surfaces.

## Development

```bash
cd frontend
pnpm --filter @traceroot-ai/tools generate   # after changing backend/rest/openapi/public.json
pnpm --filter @traceroot-ai/tools build
pnpm --filter @traceroot-ai/tools test
```

## Releasing

Versioned independently of the platform. Merging a version bump to `main` publishes it to npm
([`publish-tools.yml`](../../../.github/workflows/publish-tools.yml)). No tag or GitHub Release.

```bash
git fetch origin && git switch -c chore/tools-0.3.0 origin/main
cd frontend/packages/tools
npm version minor --no-git-tag-version   # patch | minor | major
git commit -am "chore(tools): release 0.3.0"
git push -u origin chore/tools-0.3.0 && gh pr create --fill
```

After it merges, bump `@traceroot-ai/tools` in `traceroot-cli`. Don't create `tools-v*` tags or
releases, or run `npm publish` locally.
