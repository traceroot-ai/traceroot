# =============================================================================
# TraceRoot Development
# =============================================================================

PROD_COMPOSE := docker compose -f docker-compose.prod.yml
# Only vX.Y.Z tags are platform versions; other tags must not become the label.
APP_VERSION ?= $(shell git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || echo dev)

.PHONY: install-hooks dev dev-lite dev-autoreload dev-reset prod prod-lite prod-reset sync-openapi sync-cli-ref sync-doc-snippets

## Install repository git hooks for contributors.
install-hooks:
	uv run pre-commit install

## Start developing. Handles everything: deps, infra, migrations, tmux launch.
## Idempotent - safe to run repeatedly. Reattaches if already running.
dev: install-hooks
	uv run python tmux_tools/launcher.py

## Same as dev, but with auto-reload for backend services (REST API + Celery).
dev-autoreload: install-hooks
	uv run python tmux_tools/launcher.py --autoreload

## Windows contributors: full dev env without tmux requirement.
dev-lite: install-hooks
	@uv run python tmux_tools/launcher.py --env-only
	@test -d frontend/node_modules || pnpm --dir frontend install
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	APP_VERSION=$(APP_VERSION) $(PROD_COMPOSE) up --build

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	uv run python tmux_tools/launcher.py --reset

# --- Production (Docker) ---------------------------------------------------

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python tmux_tools/launcher.py --prod

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite:
	@test -f .env || cp .env.example .env
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	APP_VERSION=$(APP_VERSION) $(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python tmux_tools/launcher.py --prod-reset

# --- Documentation & Reference Generation ----------------------------------

## Regenerate public OpenAPI schema and dashboard widget registry snapshot.
sync-openapi:
	uv run python scripts/sync_public_openapi.py

## Regenerate CLI command reference from OpenAPI schema and placements.
sync-cli-ref:
	uv run python scripts/sync_cli_reference.py

## Extract doc snippets from runnable examples and sync into docs.
sync-doc-snippets:
	uv run python scripts/sync_doc_snippets.py
