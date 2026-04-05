# Contributing to TraceRoot

Thanks for your interest in contributing! This guide will help you get started.

## Development Requirements

- Docker desktop app
- uv: Python package manager
- pnpm: Node.js package manager
- tmux: terminal multiplexer
- goose: ClickHouse migration tool

## Quick Start

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
cp .env.example .env
make dev
```

On Windows or in environments without tmux, use `make dev-lite` instead.

## Before You Start

- Check for an existing issue before starting larger work, or open one first so the change has clear scope.
- If you do not have push access, fork the repo first, create your branch from `main`, push to your fork, and open the PR back to `traceroot-ai/traceroot`.
- If you have push access, still create a branch from `main` and open a PR instead of working directly on `main`.
- Keep each pull request focused on one problem and link the related issue when possible.

## Development Commands

| Command | Description |
|---------|-------------|
| `make dev` | Start dev environment. Idempotent - reattaches to existing tmux session if running and installs the pre-commit hook. |
| `make dev-autoreload` | Same as `make dev`, but services auto-restart on code changes. |
| `make dev-lite` | Start the local Docker workflow without tmux and install the pre-commit hook. Helpful on Windows. |
| `make dev-reset` | Nuclear reset: kills tmux, destroys containers/volumes/node_modules. Run `make dev` after. |
| `make prod` | Start all services in Docker with tmux log viewer. |
| `make prod-lite` | Run the Docker stack directly without tmux. Helpful on Windows and in environments without tmux. |

`make dev`, `make dev-autoreload`, and `make dev-lite` install the pre-commit hook automatically on first run.

The tmux-based commands handle deps, Docker containers, migrations, and launch services in tmux (one window per service).

<div align="center">
  <kbd><img src="docs/images/local_dev_mode_v1.png" alt="Local dev mode"></kbd>
</div>

## Workflow

1. Create a branch from `main`.
2. Make the smallest change that fully solves the issue.
3. Commit your changes and let the pre-commit hook run automatically.
4. Run the relevant tests for your change before pushing.
5. Open a pull request and link the issue when applicable.

## Commit Message Best Practices

Please use Conventional Commit style for commit messages and PR titles when possible:

- `feat: add ci-check make target`
- `fix: handle missing ClickHouse migration binary`
- `docs: improve contribution workflow`
- `ci: align local checks with GitHub Actions`

Helpful defaults:

- Start with a type such as `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, or `chore`.
- Add a scope when it helps, for example `feat(frontend): add trace filters`.
- Use the imperative mood, for example `fix: avoid duplicate span writes`.
- Keep the summary short and specific.

## Pull Request Best Practices

- Keep the PR scoped to one logical change.
- Explain what changed, why it changed, and how it was validated.
- Add or update tests for behavior changes.
- Update documentation for setup, command, or UX changes.
- Add screenshots or recordings for UI changes.
- Reference the issue in the PR body when relevant, for example `Closes #581`.
- Make sure pre-commit and the relevant tests pass before requesting review.

## License

This project is licensed under [Apache 2.0](LICENSE) with additional [Enterprise features](./ee/LICENSE).

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot). You only need to do this once.
