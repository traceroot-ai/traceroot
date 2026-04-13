"""TraceRoot development environment launcher.

Launches all services in a tmux session with named windows.
Handles all setup automatically: deps, infra, migrations.

Usage:
    python tmux_tools/launcher.py                # normal mode
    python tmux_tools/launcher.py --autoreload   # auto-reload backend on file changes
    python tmux_tools/launcher.py --reset        # reset the development environment
    python tmux_tools/launcher.py --prod         # production mode (all services in Docker)
    python tmux_tools/launcher.py --prod-reset   # reset the production environment
"""

import argparse
import os
import shlex
import shutil
import socket
import subprocess
from pathlib import Path

from db.clickhouse.migrate import run_goose
from tmux_tools import schema

REST_PORT = 8000
FRONTEND_PORT = 3000
AGENT_PORT = 8100
ROOT = Path(__file__).resolve().parent.parent
DOCKER_COMPOSE = "docker compose"
PROD_COMPOSE = "docker compose -f docker-compose.prod.yml"
DEV_NODE_MODULES = [
    ROOT / "frontend" / "node_modules",
    ROOT / "frontend" / "ui" / "node_modules",
    ROOT / "frontend" / "worker" / "node_modules",
    ROOT / "frontend" / "packages" / "core" / "node_modules",
]


def _run(
    command: str | list[str],
    *,
    check: bool = True,
    capture_output: bool = False,
    cwd: str | Path | None = None,
) -> subprocess.CompletedProcess:
    args = shlex.split(command) if isinstance(command, str) else command
    return subprocess.run(
        args,
        check=check,
        capture_output=capture_output,
        text=True,
        cwd=cwd,
    )


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
    print("Ensuring infrastructure is running (PostgreSQL, ClickHouse, MinIO, Redis)...")
    print("Waiting for containers to be healthy...")
    _run(
        f"{DOCKER_COMPOSE} up -d --wait postgres clickhouse minio redis",
    )
    # minio-init is a one-shot, idempotent setup container — start it after MinIO is healthy.
    _run(f"{DOCKER_COMPOSE} up -d minio-init")


def ensure_python_deps():
    """Install Python deps if .venv doesn't exist or is stale."""
    print("Syncing Python dependencies...")
    _run(["uv", "sync"])


def ensure_frontend_deps():
    """Install frontend deps if node_modules missing."""
    if not os.path.exists("frontend/node_modules"):
        print("Installing frontend dependencies...")
        _run(["pnpm", "install"], cwd="frontend")
    else:
        print("Frontend dependencies already installed.")
    print("Generating Prisma client...")
    _run(
        ["pnpm", "db:generate"],
        cwd="frontend/packages/core",
    )


def ensure_migrations():
    """Run pending migrations for both Postgres and ClickHouse."""
    print("Running PostgreSQL migrations (Prisma)...")
    _run(
        ["pnpm", "db:migrate"],
        cwd="frontend/packages/core",
    )
    print("Running ClickHouse migrations (goose)...")
    run_goose("up", docker_fallback=True)


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
    _run(f"{PROD_COMPOSE} build")

    print("Starting infrastructure (PostgreSQL, ClickHouse, MinIO, Redis)...")
    _run(f"{PROD_COMPOSE} up -d --wait postgres clickhouse minio redis")
    # minio-init is a one-shot container — start it separately (--wait fails on exit-0 containers)
    _run(f"{PROD_COMPOSE} up -d minio-init")

    # Migrations run as a dependency of each app service via depends_on:
    # service_completed_successfully in docker-compose.prod.yml. Starting the
    # services here causes Compose to run migrate/migrate-clickhouse first and
    # only bring up each app container after its migration dependency exits 0.
    print("Starting application services (migrations run automatically before app services)...")
    _run(f"{PROD_COMPOSE} up -d web rest worker billing agent")

    print("\nAll containers started. Launching log viewer...\n")


def _remove_path(path: Path) -> None:
    if not path.exists():
        return
    if path.is_file() or path.is_symlink():
        path.unlink()
        return
    shutil.rmtree(path)


def _kill_tmux_session(session_name: str) -> None:
    try:
        _run(
            ["tmux", "-L", "development", "kill-session", "-t", session_name],
            check=False,
            capture_output=True,
        )
    except FileNotFoundError:
        return


def _remove_sandbox_containers() -> None:
    result = _run(
        ["docker", "ps", "-aq", "--filter", "name=traceroot-sandbox-"],
        check=False,
        capture_output=True,
    )
    container_ids = result.stdout.split()
    if container_ids:
        _run(["docker", "rm", "-f", *container_ids], check=False, capture_output=True)


def reset_dev_environment() -> None:
    print("Resetting everything...")
    _kill_tmux_session("traceroot")
    _remove_sandbox_containers()
    _run(f"{DOCKER_COMPOSE} down -v")
    for path in DEV_NODE_MODULES:
        _remove_path(path)
    _remove_path(ROOT / ".venv")
    print("Done. Run 'make dev' to start fresh.")


def reset_prod_environment() -> None:
    print("Resetting production environment...")
    _kill_tmux_session("traceroot-prod")
    _remove_sandbox_containers()
    _run(f"{PROD_COMPOSE} down -v --rmi local")
    print("Done. Run 'make prod' to start fresh.")


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
    ]


def _port_instructions(port):
    if os.name == "nt":
        return (
            f"Port {port} is in use. Find and stop the process with:\n"
            f"    Get-NetTCPConnection -LocalPort {port} | Select-Object LocalAddress, LocalPort, OwningProcess\n"
            "    Stop-Process -Id <PID>"
        )
    return (
        f"Port {port} is in use. Find and kill the process:\n"
        f"    lsof -nP -iTCP:{port} -sTCP:LISTEN\n"
        "    kill <PID>"
    )


def _check_port_available(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            return schema.CheckResult(
                False,
                f"Port {port} is in use or unavailable.\n"
                f"System error: {exc}\n"
                f"{_port_instructions(port)}",
            )
    return schema.CheckResult(True, "")


def port_available(port):
    """Check that a port is not in use."""
    return schema.Prerequisite(
        name=f"port {port} is available",
        check_fn=lambda: _check_port_available(port),
        instructions=_port_instructions(port),
    )


# ---------------------------------------------------------------------------
# Development environment configuration
# ---------------------------------------------------------------------------


def infra_services():
    """Individual services for each infrastructure component."""
    return [
        schema.Service(
            title="PostgreSQL",
            command=f"{DOCKER_COMPOSE} logs -f --tail=50 postgres",
            web_urls=[],
        ),
        schema.Service(
            title="ClickHouse",
            command=f"{DOCKER_COMPOSE} logs -f --tail=50 clickhouse",
            web_urls=[],
        ),
        schema.Service(
            title="Redis",
            command=f"{DOCKER_COMPOSE} logs -f --tail=50 redis",
            web_urls=[],
        ),
        schema.Service(
            title="MinIO",
            command=f"{DOCKER_COMPOSE} logs -f --tail=50 minio",
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
                    ("TraceRoot UI", f"http://localhost:{FRONTEND_PORT}"),
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
                    ("TraceRoot UI", f"http://localhost:{FRONTEND_PORT}"),
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch TraceRoot dev environment")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--autoreload",
        action="store_true",
        help="Enable auto-reload for backend services on file changes",
    )
    mode.add_argument(
        "--prod",
        action="store_true",
        help="Launch production mode (all services in Docker)",
    )
    mode.add_argument(
        "--reset",
        action="store_true",
        help="Reset the development environment and exit",
    )
    mode.add_argument(
        "--prod-reset",
        action="store_true",
        help="Reset the production environment and exit",
    )
    args = parser.parse_args()

    os.chdir(ROOT)

    if args.reset:
        reset_dev_environment()
        return
    if args.prod_reset:
        reset_prod_environment()
        return
    if args.prod:
        driver = make_prod_driver()
    else:
        driver = make_driver(autoreload=args.autoreload)
    driver.run()


if __name__ == "__main__":
    main()
