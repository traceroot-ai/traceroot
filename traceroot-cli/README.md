# traceroot-cli

> **Status: scaffold** — command implementations are stubs; real behaviour lands in follow-on issues.

Read-only CLI for [TraceRoot](https://traceroot.ai) — inspect traces, spans, and service health from your terminal.

## Requirements

- Node ≥ 20
- A TraceRoot workspace and a personal access token

## Installation

```sh
npm install -g traceroot-cli
# or, without installing:
npx traceroot-cli --help
```

## Usage

```sh
traceroot --help
traceroot --version

traceroot login token <TOKEN>      # save PAT to ~/.traceroot/config.json
traceroot status                   # show auth status and active workspace

traceroot traces list              # list recent traces (table)
traceroot traces list --json       # newline-delimited JSON
traceroot traces get <traceId>     # render a single trace as a span tree
traceroot traces get <traceId> --json
```

### Environment variables

| Variable              | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `TRACEROOT_TOKEN`     | Auth token (overrides `~/.traceroot/config.json`)  |
| `TRACEROOT_API_URL`   | API base URL (default: `https://api.traceroot.ai`) |
| `TRACEROOT_WORKSPACE` | Active workspace slug                              |
| `NO_COLOR`            | Suppress all ANSI colour output                    |

## Development

```sh
npm install
npm run build        # compile TypeScript → dist/
npm run typecheck    # type-check without emitting
npm run lint         # ESLint
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)
npm test             # Vitest (requires build for bin integration tests)
npm run test:watch   # Vitest in watch mode
```

## Architecture

```
traceroot-cli/
  bin/traceroot.mjs          # thin ESM entry → dist/cli.js
  src/
    cli.ts                   # commander program; registers subcommands
    output.ts                # stdout/stderr/exit-code/NO_COLOR contract
    commands/
      login.ts               # traceroot login [token]
      status.ts              # traceroot status
      traces.ts              # traceroot traces list / get
    config/
      schema.ts              # config shape + type guard
      manager.ts             # ~/.traceroot/config.json read/write
      resolve.ts             # auth resolution (env → config fallback)
    api/
      client.ts              # fetch-based HTTP client
      generated/             # typed stubs (replaced by codegen in #1084)
    render/
      table.ts               # padded column table renderer
      tree.ts                # span-tree renderer
    util/
      index.ts               # shared helpers (truncate, plural, …)
  test/                      # Vitest, mirrors src/
  scripts/                   # codegen + release helpers (see #1084)
  openapi.json               # vendored public schema snapshot
```

## Related issues

| Issue                      | Topic                                    |
| -------------------------- | ---------------------------------------- |
| [#1082](../../issues/1082) | This scaffold                            |
| [#1083](../../issues/1083) | Config, auth resolution, output contract |
| [#1084](../../issues/1084) | OpenAPI codegen                          |
| [#1089](../../issues/1089) | Epic                                     |

## License

MIT
