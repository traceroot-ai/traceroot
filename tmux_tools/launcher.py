"""Traceroot development environment launcher.

Launches all services in a tmux session with named windows.
Handles all setup automatically: deps, infra, migrations.

Usage:
    python tmux_tools/launcher.py
"""

import os
import shutil
import subprocess

from tmux_tools import schema

REST_PORT = 8000
FRONTEND_PORT = 3000


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
        capture_output=True, text=True,
    )
    if not result.stdout.strip():
        print("Starting infrastructure (PostgreSQL, ClickHouse, MinIO, Redis)...")
        subprocess.run(["docker", "compose", "up", "-d"], check=True)
        print("Waiting for containers to be healthy...")
        # Wait for the main services (not minio-init which is a one-shot container)
        subprocess.run(
            ["docker", "compose", "up", "-d", "--wait",
             "postgres", "clickhouse", "minio", "redis"],
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
        ["pnpm", "db:generate"], cwd="frontend/packages/core", check=True,
    )


def ensure_migrations():
    """Run pending migrations for both Postgres and ClickHouse."""
    print("Running PostgreSQL migrations (Prisma)...")
    subprocess.run(
        ["pnpm", "db:migrate"], cwd="frontend/packages/core", check=True,
    )
    print("Running ClickHouse migrations (goose)...")
    subprocess.run(
        ["./migrate.sh", "up"], cwd="backend/db/clickhouse", check=True,
    )


def run_setup():
    """Run all setup steps. Idempotent — skips what's already done."""
    ensure_env_file()
    ensure_infra()
    ensure_python_deps()
    ensure_frontend_deps()
    ensure_migrations()
    print("\nSetup complete. Launching development environment...\n")


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


def make_driver():
    """Full stack: Frontend + REST API + Celery Worker + Infra logs."""
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
                command="uv run python backend/rest/main.py",
                web_urls=[
                    ("REST API docs", f"http://localhost:{REST_PORT}/docs"),
                ],
            ),
            schema.Service(
                title="Celery Worker",
                command=(
                    "uv run celery -A worker.celery_app worker "
                    "--loglevel=info"
                ),
                web_urls=[],
            ),
        ] + infra_services(),
        prerequisites=(
            tool_prerequisites()
            + [port_available(REST_PORT), port_available(FRONTEND_PORT)]
        ),
    )


if __name__ == "__main__":
    driver = make_driver()
    driver.run()
