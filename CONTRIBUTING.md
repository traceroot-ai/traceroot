# Contributing to TraceRoot

Thanks for your interest in contributing to TraceRoot. This guide is meant to help new contributors get from clone to pull request with a simple, low-friction workflow.

## Before You Start

- Check for an existing issue before starting larger work, or open one first so the change has clear scope.
- Keep each pull request focused on one problem. Small, reviewable PRs get merged faster.
- Do not commit directly to `main`. Use a short-lived feature or fix branch for every change.

## Requirements

- Docker Desktop
- `tmux`
- `uv`
- Node.js 20+
- `pnpm` 10+
- `goose` for local ClickHouse migrations used by `make dev`

## Quick Start

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
cp .env.example .env
make dev
```

`make dev` is the fastest way to get started. It bootstraps the local developer workflow, starts the required services, runs migrations, and opens the app inside tmux-managed processes.

If you only want to run checks without starting the full stack, install the local dependencies once:

```bash
uv sync --dev
pnpm --dir frontend install --frozen-lockfile
```

## Common Commands

| Command | Description |
| --- | --- |
| `make dev` | Start the local development environment. Safe to rerun. |
| `make dev-autoreload` | Start the local environment with backend autoreload enabled. |
| `make dev-reset` | Reset local dev state, containers, and related dependencies. |
| `make lint` | Run Python lint checks with Ruff and frontend lint checks with ESLint. |
| `make format` | Apply Python formatting with Ruff and frontend formatting with Prettier. |
| `make ci-check` | Run the local pre-PR checks: lint and backend tests. |
| `make prod` | Start the production-style Docker workflow with tmux logs. |
| `make prod-lite` | Run the Docker stack directly without tmux. |

## Recommended Workflow

1. Sync your branch with the latest `main`.
2. Create a branch such as `fix/issue-581-contributing-guide` or `feat/add-ci-check-target`.
3. Make the smallest change that fully solves the issue.
4. Run `make format` and `make ci-check` before pushing.
5. Update tests and docs when behavior, commands, or developer workflow changes.
6. Open a pull request with a clear summary and link the issue when applicable.

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
- Make sure `make ci-check` passes before requesting review.

The repository also includes pre-commit protections such as blocking direct commits to `main`, so staying on a feature branch will save time.

## License

This project is licensed under [Apache 2.0](LICENSE) with additional [Enterprise features](./ee/LICENSE).

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot). You only need to do this once.
