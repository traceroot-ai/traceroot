# =============================================================================
# TraceRoot Development
# =============================================================================

PROD_COMPOSE := docker compose -f docker-compose.prod.yml
# Secrets docker-compose.prod.yml marks required with ${VAR:?...}. Kept in sync
# by tests/test_published_secrets.py, which reads both this list and the compose file.
REQUIRED_SECRETS := INTERNAL_API_SECRET BETTER_AUTH_SECRET SQL_GATEWAY_BOOTSTRAP_PASSWORD
# Values this repository published in .env.example or a compose file. Nobody chose
# them, so an .env still carrying one is repaired rather than believed. Mirrors
# PUBLISHED_PLACEHOLDERS in tmux_tools/launcher.py, which the same test pins to this.
PUBLISHED_PLACEHOLDERS := dev-internal-secret internal-secret your-better-auth-secret \
	local-dev-secret-change-in-production changeme dev-sql-gateway-bootstrap
# Only vX.Y.Z tags are platform versions; other tags must not become the label.
APP_VERSION ?= $(shell git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || echo dev)

.PHONY: install-hooks dev dev-lite dev-autoreload dev-reset prod prod-lite prod-reset env-secrets

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

## Give every required secret a value in .env. Needs only openssl, so the
## self-hosting path stays free of the uv/python toolchain. The generated
## value reaches awk through its environment, never argv: a process argument
## list is readable by every local user, a process environment is not.
##
## Both awk passes trim carriage returns as well as spaces and tabs, and they
## agree on where the key name ends. A CRLF .env otherwise compares a value as
## "published-default\r", which matches no placeholder and reads as configured,
## leaving the published secret in place for Compose to use.
##
## The rewrite goes through a per-process temp name that is removed first, not
## a fixed .env.tmp. Shell redirection follows a symlink and umask does not
## protect a target that already exists, so anyone able to write the checkout
## could pre-plant .env.tmp pointing at a file they own and read every secret
## out of it.
env-secrets:
	@umask 077; test -f .env || cp .env.example .env; chmod 600 .env
	@umask 077; for key in $(REQUIRED_SECRETS); do \
		if awk -F= -v k="$$key" -v published="$(PUBLISHED_PLACEHOLDERS)" 'BEGIN { split(published, list, " "); for (i in list) known[list[i]] = 1; quotes = "[\"" sprintf("%c", 39) "]+" } { name = $$1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/[ \t\r]+$$/, "", name) } name == k { value = substr($$0, index($$0, "=") + 1); sub(/[ \t]+#.*/, "", value); gsub(/^[ \t\r]+|[ \t\r]+$$/, "", value); sub("^" quotes, "", value); sub(quotes "$$", "", value); if (value != "" && !(tolower(value) in known)) configured = 1 } END { exit !configured }' .env; then \
			continue; \
		fi; \
		value=$$(openssl rand -hex 32) || exit 1; \
		tmp=".env.tmp.$$$$"; rm -f "$$tmp"; \
		TRACEROOT_GENERATED_SECRET="$$value" awk -F= -v k="$$key" 'BEGIN { OFS = "=" } { name = $$1; sub(/^[ \t]*export[ \t]+/, "", name); sub(/[ \t\r]+$$/, "", name) } name == k { print name, ENVIRON["TRACEROOT_GENERATED_SECRET"]; found = 1; next } { print } END { if (!found) print k, ENVIRON["TRACEROOT_GENERATED_SECRET"] }' .env > "$$tmp" || { rm -f "$$tmp"; exit 1; }; \
		mv "$$tmp" .env; \
		echo "Generated $$key in .env"; \
	done

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite: env-secrets
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	APP_VERSION=$(APP_VERSION) $(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python tmux_tools/launcher.py --prod-reset
