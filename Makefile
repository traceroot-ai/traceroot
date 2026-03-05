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
	@echo "Resetting everything..."
	tmux -L development kill-session -t traceroot 2>/dev/null || true
	docker rm -f $$(docker ps -aq --filter "name=traceroot-sandbox-") 2>/dev/null || true
	docker compose down -v
	rm -rf frontend/node_modules frontend/ui/node_modules frontend/worker/node_modules frontend/packages/core/node_modules
	rm -rf .venv
	@echo "Done. Run 'make dev' to start fresh."

# --- Production (Docker) ---------------------------------------------------

PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: prod prod-reset

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python tmux_tools/launcher.py --prod

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	@echo "Resetting production environment..."
	tmux -L development kill-session -t traceroot-prod 2>/dev/null || true
	docker rm -f $$(docker ps -aq --filter "name=traceroot-sandbox-") 2>/dev/null || true
	$(PROD_COMPOSE) down -v --rmi local
	@echo "Done. Run 'make prod' to start fresh."
