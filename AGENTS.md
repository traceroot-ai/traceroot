# Agent Instructions

## Project Map

- `backend/`: Python backend services and workers.
- `frontend/ui/`: Next.js frontend app.
- `frontend/packages/`: shared TypeScript packages.
- `frontend/worker/`: TypeScript worker services.
- `tests/`: backend pytest tests.

## Setup

Read `CONTRIBUTING.md` for contributor setup and workflow. Use `make dev` for the tmux-based development environment, or `make dev-lite` for the Docker workflow without tmux.

## Validation

Run checks relevant to the changed files:

- Python lint/format: `uv run ruff check . && uv run ruff format --check .`
- Backend tests with coverage: `uv run coverage run -m pytest tests/ && uv run coverage report`
- Frontend lint/format: `pnpm --dir frontend lint && pnpm --dir frontend format:check`
- Frontend package tests with coverage: `pnpm --dir frontend/ui test:coverage` or the changed package

Pull requests must pass GitHub Actions, including 80% diff coverage on changed production lines.

## Working Rules

- Keep changes scoped to the requested problem.
- Prefer existing project patterns over new abstractions.
- Add or update focused tests when behavior changes.
- Do not revert user changes unless explicitly asked.
