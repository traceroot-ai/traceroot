# =============================================================================
# TraceRoot Development
# =============================================================================

PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: install-hooks dev dev-lite dev-autoreload dev-reset prod prod-lite prod-reset

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
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	uv run python tmux_tools/launcher.py --reset

# --- Production (Docker) ---------------------------------------------------

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python tmux_tools/launcher.py --prod

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite:
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python tmux_tools/launcher.py --prod-reset
