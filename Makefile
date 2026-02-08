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

## Nuclear reset: kill tmux, destroy all containers/volumes/deps, then restart.
dev-reset:
	@echo "Resetting everything..."
	tmux -L development kill-session -t traceroot 2>/dev/null || true
	docker compose down -v
	rm -rf frontend/node_modules frontend/ui/node_modules frontend/worker/node_modules frontend/packages/core/node_modules
	rm -rf .venv
	uv run python tmux_tools/launcher.py
