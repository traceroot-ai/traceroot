"""Traceroot development environment launcher.

Launches all services in a tmux session with named windows.
Handles all setup automatically: deps, infra, migrations.

Usage:
    python tmux_tools/launcher.py                # normal mode
    python tmux_tools/launcher.py --autoreload   # auto-reload backend on file changes
    python tmux_tools/launcher.py --prod         # production mode (all services in Docker)
"""

import argparse
import os
import shutil
import subprocess

from tmux_tools import schema

REST_PORT = 8000
FRONTEND_PORT = 3000
AGENT_PORT = 8100
PROD_COMPOSE = "docker compose -f docker-compose.prod.yml"


# ---------------------------------------------------------------------------
# Setup steps — these RUN the setup, not just check it
# ---------------------------------------------------------------------------


def ensure_env_file():
    """Copy .env.example to .env if it doesn't exist."""
    if not os.path.exists(".env"):
        print("Creating .env from .env.example...")
        shutil.copy(".env.example", ".env")
        print("  Created .env — edit it if you need to change defaults.")
    else:
        print("Found existing .env file.")


def ensure_infra():
    """Start docker containers if not already running."""
    result = subprocess.run(
        ["docker", "compose", "ps", "--status", "running", "-q"],
        capture_output=True,
        text=True,
    )
    if not result.stdout.strip():
        print("Starting infrastructure (PostgreSQL, ClickHouse, MinIO, Redis)...")
        subprocess.run(["docker", "compose", "up", "-d"], check=True)
        print("Waiting for containers to be healthy...")
        # Wait for the main services (not minio-init which is a one-shot container)
        subprocess.run(
            ["docker", "compose", "up", "-d", "--wait", "postgres", "clickhouse", "minio", "redis"],
            check=True,
        )
    else:
        print("Infrastructure already running.")


def ensure_python_deps():
    """Install Python deps if .venv doesn't exist or is stale."""
    print("Syncing Python dependencies...")
    subprocess.run(["uv", "sync"], check=True)


def ensure_frontend_deps():
    """Install frontend deps if node_modules missing."""
    if not os.path.exists("frontend/node_modules"):
        print("Installing frontend dependencies...")
        subprocess.run(["pnpm", "install"], cwd="frontend", check=True)
    else:
        print("Frontend dependencies already installed.")
    print("Generating Prisma client...")
    subprocess.run(
        ["pnpm", "db:generate"],
        cwd="frontend/packages/core",
        check=True,
    )


def ensure_migrations():
    """Run pending migrations for both Postgres and ClickHouse."""
    print("Running PostgreSQL migrations (Prisma)...")
    subprocess.run(
        ["pnpm", "db:migrate"],
        cwd="frontend/packages/core",
        check=True,
    )
    print("Running ClickHouse migrations (goose)...")
    subprocess.run(
        ["./migrate.sh", "up"],
        cwd="backend/db/clickhouse",
        check=True,
    )


def run_setup():
    """Run all setup steps. Idempotent — skips what's already done."""
    ensure_env_file()
    ensure_infra()
    ensure_python_deps()
    ensure_frontend_deps()
    ensure_migrations()
    print("\nSetup complete. Launching development environment...\n")


def run_prod_setup():
    """Build Docker images and start all services. Idempotent."""
    ensure_env_file()

    print("Building Docker images (cached if unchanged)...")
    subprocess.run(
        f"{PROD_COMPOSE} build".split(),
        check=True,
    )

    print("Starting infrastructure (PostgreSQL, ClickHouse, MinIO, Redis)...")
    subprocess.run(
        f"{PROD_COMPOSE} up -d --wait postgres clickhouse minio redis".split(),
        check=True,
    )
    # minio-init is a one-shot container — start it separately (--wait fails on exit-0 containers)
    subprocess.run(
        f"{PROD_COMPOSE} up -d minio-init".split(),
        check=True,
    )

    print("Running database migrations (PostgreSQL)...")
    subprocess.run(
        f"{PROD_COMPOSE} run --rm migrate".split(),
        check=True,
    )

    print("Running database migrations (ClickHouse)...")
    subprocess.run(
        f"{PROD_COMPOSE} run --rm migrate-clickhouse".split(),
        check=True,
    )

    print("Starting application services (web, rest, worker, billing, agent)...")
    subprocess.run(
        f"{PROD_COMPOSE} up -d web rest worker billing agent".split(),
        check=True,
    )

    print("\nAll containers started. Launching log viewer...\n")


# ---------------------------------------------------------------------------
# Prerequisite checks — validate tools we can't auto-fix
# ---------------------------------------------------------------------------


def tool_prerequisites():
    """Check that required CLI tools are installed (we can't install these)."""
    return [
        schema.Prerequisite(
            name="docker is installed and running",
            command="docker ps",
            instructions="Install Docker: https://docs.docker.com/get-docker/",
        ),
        schema.Prerequisite(
            name="uv is installed",
            command="uv --version",
            instructions="Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh",
        ),
        schema.Prerequisite(
            name="pnpm is installed",
            command="pnpm --version",
            instructions="Install pnpm: npm install -g pnpm",
        ),
        schema.Prerequisite(
            name="goose is installed",
            command="goose --version",
            instructions=(
                "Install goose:\n"
                "    Mac:   brew install goose\n"
                "    Other: go install github.com/pressly/goose/v3/cmd/goose@latest"
            ),
        ),
    ]


def port_available(port):
    """Check that a port is not in use."""
    return schema.Prerequisite(
        name=f"port {port} is available",
        command=f'bash -c "! lsof -nP -iTCP:{port} -sTCP:LISTEN"',
        instructions=(
            f"Port {port} is in use. Find and kill the process:\n"
            f"    lsof -nP -iTCP:{port} -sTCP:LISTEN\n"
            f"    kill <PID>"
        ),
    )


# ---------------------------------------------------------------------------
# Development environment configuration
# ---------------------------------------------------------------------------


def infra_services():
    """Individual services for each infrastructure component."""
    return [
        schema.Service(
            title="PostgreSQL",
            command="docker compose logs -f --tail=50 postgres",
            web_urls=[],
        ),
        schema.Service(
            title="ClickHouse",
            command="docker compose logs -f --tail=50 clickhouse",
            web_urls=[],
        ),
        schema.Service(
            title="Redis",
            command="docker compose logs -f --tail=50 redis",
            web_urls=[],
        ),
        schema.Service(
            title="MinIO",
            command="docker compose logs -f --tail=50 minio",
            web_urls=[
                ("MinIO Console", "http://localhost:9091"),
            ],
        ),
    ]


def make_driver(autoreload=False):
    """Full stack: Frontend + REST API + Celery Worker + Infra logs."""

    if autoreload:
        rest_command = (
            "uv run uvicorn rest.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend"
        )
        celery_command = (
            "uv run watchfiles --filter python "
            "'celery -A worker.celery_app worker --loglevel=info' "
            "backend/worker"
        )
    else:
        rest_command = "uv run python backend/rest/main.py"
        celery_command = "uv run celery -A worker.celery_app worker --loglevel=info"

    return schema.Driver(
        name="traceroot",
        on_start=run_setup,
        services=[
            schema.Service(
                title="Frontend",
                command="cd frontend/ui && pnpm dev",
                web_urls=[
                    ("Traceroot UI", f"http://localhost:{FRONTEND_PORT}"),
                ],
            ),
            schema.Service(
                title="Rest API",
                command=rest_command,
                web_urls=[
                    ("REST API docs", f"http://localhost:{REST_PORT}/docs"),
                ],
            ),
            schema.Service(
                title="Celery Worker",
                command=celery_command,
                web_urls=[],
            ),
            schema.Service(
                title="Billing Worker",
                command="cd frontend/worker && pnpm dev",
                web_urls=[],
            ),
            schema.Service(
                title="Agent",
                command="cd frontend/packages/agent && pnpm dev",
                web_urls=[
                    ("Agent API", f"http://localhost:{AGENT_PORT}"),
                ],
            ),
        ]
        + infra_services(),
        prerequisites=(
            tool_prerequisites()
            + [port_available(REST_PORT), port_available(FRONTEND_PORT), port_available(AGENT_PORT)]
        ),
    )


def prod_infra_services():
    """Infrastructure log streams for prod mode."""
    return [
        schema.Service(
            title="PostgreSQL",
            command=f"{PROD_COMPOSE} logs -f --tail=50 postgres",
            web_urls=[],
        ),
        schema.Service(
            title="ClickHouse",
            command=f"{PROD_COMPOSE} logs -f --tail=50 clickhouse",
            web_urls=[],
        ),
        schema.Service(
            title="Redis",
            command=f"{PROD_COMPOSE} logs -f --tail=50 redis",
            web_urls=[],
        ),
        schema.Service(
            title="MinIO",
            command=f"{PROD_COMPOSE} logs -f --tail=50 minio",
            web_urls=[
                ("MinIO Console", "http://localhost:9091"),
            ],
        ),
    ]


def make_prod_driver():
    """Full stack in Docker: all app + infra services as containers."""
    return schema.Driver(
        name="traceroot-prod",
        welcome_title="production environment (local Docker)",
        on_start=run_prod_setup,
        services=[
            schema.Service(
                title="Web",
                command=f"{PROD_COMPOSE} logs -f --tail=50 web",
                web_urls=[
                    ("Traceroot UI", f"http://localhost:{FRONTEND_PORT}"),
                ],
            ),
            schema.Service(
                title="REST API",
                command=f"{PROD_COMPOSE} logs -f --tail=50 rest",
                web_urls=[
                    ("REST API docs", f"http://localhost:{REST_PORT}/docs"),
                ],
            ),
            schema.Service(
                title="Celery Worker",
                command=f"{PROD_COMPOSE} logs -f --tail=50 worker",
                web_urls=[],
            ),
            schema.Service(
                title="Billing Worker",
                command=f"{PROD_COMPOSE} logs -f --tail=50 billing",
                web_urls=[],
            ),
            schema.Service(
                title="Agent",
                command=f"{PROD_COMPOSE} logs -f --tail=50 agent",
                web_urls=[
                    ("Agent API", f"http://localhost:{AGENT_PORT}"),
                ],
            ),
        ]
        + prod_infra_services(),
        prerequisites=[
            schema.Prerequisite(
                name="docker is installed and running",
                command="docker ps",
                instructions="Install Docker: https://docs.docker.com/get-docker/",
            ),
        ],
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch Traceroot dev environment")
    parser.add_argument(
        "--autoreload",
        action="store_true",
        help="Enable auto-reload for backend services on file changes",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="Launch production mode (all services in Docker)",
    )
    args = parser.parse_args()

    if args.prod:
        driver = make_prod_driver()
    else:
        driver = make_driver(autoreload=args.autoreload)
    driver.run()
