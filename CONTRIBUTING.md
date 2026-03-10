# Contributing to TraceRoot

Thanks for your interest in contributing! This guide will help you get started.

## Development Requirements

- Docker desktop app
- uv: Python package manager
- pnpm: Node.js package manager
- tmux: terminal multiplexer
- goose: clickHouse migration tool

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