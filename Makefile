# =============================================================================
# Traceroot Development
# =============================================================================

.PHONY: dev dev-autoreload dev-reset

## Start developing. Handles everything: deps, infra, migrations, tmux launch.
## Idempotent — safe to run repeatedly. Reattaches if already running.
dev:
	uv run python tmux_tools/launcher.py

## Same as dev, but with auto-reload for backend services (REST API + Celery).
dev-autoreload:
	uv run python tmux_tools/launcher.py --autoreload

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	uv run python tmux_tools/launcher.py --reset

# --- Production (Docker) ---------------------------------------------------

PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: prod prod-lite prod-reset

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python tmux_tools/launcher.py --prod

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite:
	@echo "Starting Traceroot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python tmux_tools/launcher.py --prod-reset
