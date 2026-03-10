# Contributing to TraceRoot

Thanks for your interest in contributing! This guide will help you get started.

## Development Requirements

You need these installed before running anything:

- [Docker](https://docs.docker.com/get-docker/) (must be running)
- [uv](https://docs.astral.sh/uv/) — Python package manager
- [pnpm](https://pnpm.io/) — Node package manager
- [tmux](https://github.com/tmux/tmux) — terminal multiplexer
- [goose](https://github.com/pressly/goose) — ClickHouse migrations (`brew install goose` on Mac)

## Quick Start

```bash
cp .env.example .env  # First time only — then edit with your API keys
make dev              # Start the full dev environment
make dev-authreload   # Restart with fresh auth state
make dev-reset        # Nuke everything to start clean
```

`make dev` handles the rest automatically: installs deps, starts Docker containers, runs migrations, and launches everything in tmux, where each tmux window corresponds to a service.

## License

TraceRoot is Apache-2.0 licensed. See [LICENSE](LICENSE) for more details.

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot). You only need to do this once.