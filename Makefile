# =============================================================================
# Traceroot Development
# =============================================================================

.PHONY: dev dev-autoreload dev-reset

## Start developing. Handles everything: deps, infra, migrations, tmux launch.
## Idempotent — safe to run repeatedly. Reattaches if already running.
dev:
	uv run python scripts/make_tasks.py dev

## Same as dev, but with auto-reload for backend services (REST API + Celery).
dev-autoreload:
	uv run python scripts/make_tasks.py dev-autoreload

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	uv run python scripts/make_tasks.py dev-reset

# --- Production (Docker) ---------------------------------------------------

PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: prod prod-reset

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python scripts/make_tasks.py prod

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python scripts/make_tasks.py prod-reset
