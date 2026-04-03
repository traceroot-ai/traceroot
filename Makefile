# =============================================================================
# Traceroot Development
# =============================================================================

UV_RUN := uv run
FRONTEND_PNPM := pnpm --dir frontend
PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: dev dev-autoreload dev-reset lint format ci-check prod prod-lite prod-reset

## Start developing. Handles everything: deps, infra, migrations, tmux launch.
## Idempotent - safe to run repeatedly. Reattaches if already running.
dev:
	$(UV_RUN) python tmux_tools/launcher.py

## Same as dev, but with auto-reload for backend services (REST API + Celery).
dev-autoreload:
	$(UV_RUN) python tmux_tools/launcher.py --autoreload

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	$(UV_RUN) python tmux_tools/launcher.py --reset

## Run local lint checks for Python and frontend code.
lint:
	$(UV_RUN) ruff check .
	$(FRONTEND_PNPM) run lint

## Auto-format Python and frontend code.
format:
	$(UV_RUN) ruff format .
	$(FRONTEND_PNPM) run format

## Run the core checks contributors should pass before opening a PR.
ci-check:
	$(UV_RUN) ruff check .
	$(UV_RUN) ruff format --check .
	$(FRONTEND_PNPM) run lint
	$(FRONTEND_PNPM) run format:check
	$(UV_RUN) coverage run -m pytest tests/ --durations=10
	$(UV_RUN) coverage report

# --- Production (Docker) ---------------------------------------------------

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	$(UV_RUN) python tmux_tools/launcher.py --prod

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite:
	@echo "Starting Traceroot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	$(UV_RUN) python tmux_tools/launcher.py --prod-reset
