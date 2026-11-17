"""traceroot development environment launcher.

Launches all services in a tmux session with named windows.
Handles all setup automatically: deps, infra, migrations.

Usage:
    python tmux_tools/launcher.py                # normal mode
    python tmux_tools/launcher.py --autoreload   # auto-reload backend on file changes
    python tmux_tools/launcher.py --reset        # reset the development environment
    python tmux_tools/launcher.py --prod         # production mode (all services in Docker)
    python tmux_tools/launcher.py --prod-reset   # reset the production environment
    python tmux_tools/launcher.py --env-only     # create/repair .env, then exit
"""

import argparse
import contextlib
import os
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import tempfile
from pathlib import Path

from db.clickhouse.migrate import run_goose
from tmux_tools import schema

REST_PORT = 8000
FRONTEND_PORT = 3000
AGENT_PORT = 8100
ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
ENV_EXAMPLE_PATH = ROOT / ".env.example"
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
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    args = shlex.split(command) if isinstance(command, str) else command
    return subprocess.run(
        args,
        check=check,
        capture_output=capture_output,
        text=True,
        cwd=cwd,
        env=env,
    )


# ---------------------------------------------------------------------------
# Setup steps — these RUN the setup, not just check it
# ---------------------------------------------------------------------------


# Keys that must hold a unique, unguessable value in every install. .env.example
# ships them empty because a value committed here is a value every install shares.
GENERATED_KEYS = ("INTERNAL_API_SECRET", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY")

# Generated only when empty or absent, never replaced. Stored provider keys and Slack
# tokens are encrypted under whatever value is there, so swapping a non-empty one
# would make them unreadable; `make rotate-encryption-key` is the way to change it.
FRESH_ONLY_KEYS = frozenset({"ENCRYPTION_KEY"})

# Required by docker-compose.prod.yml, which refuses to start without it, but
# supplied by docker-compose.yml as one of the dev stack's deliberately weak known
# defaults. The dev path therefore has nothing to repair and leaves .env silent
# about it; every path that brings up prod compose has to fill it.
PROD_GENERATED_KEYS = (
    "SQL_GATEWAY_BOOTSTRAP_PASSWORD",
    "CLICKHOUSE_PASSWORD",
    "MINIO_ROOT_PASSWORD",
)

ALL_GENERATED_KEYS = GENERATED_KEYS + PROD_GENERATED_KEYS

# Values this repository published at some point in .env.example or
# docker-compose.prod.yml. Nobody chose them, so replacing them is safe; a value
# that is not on this list is left alone, however weak it looks.
PUBLISHED_PLACEHOLDERS = frozenset(
    {
        "dev-internal-secret",
        "internal-secret",
        "your-better-auth-secret",
        "local-dev-secret-change-in-production",
        "changeme",
        "dev-sql-gateway-bootstrap",
        "clickhouse",
        "minio-password",
    }
)


def _cleaned(assigned: str) -> str:
    return re.split(r"\s#", assigned, maxsplit=1)[0].strip().strip("\"'")


def is_placeholder(assigned: str) -> bool:
    """True if the text after ``KEY=`` is empty or a string we published.

    Takes everything to the end of the line, so a trailing comment is dropped
    before the comparison -- the published lines carried a "# CHANGEME" note.
    Only whitespace followed by "#" opens a comment, so a secret that merely
    contains a "#" is compared, and kept, in full.
    """
    cleaned = _cleaned(assigned)
    return not cleaned or cleaned.lower() in PUBLISHED_PLACEHOLDERS


ENV_VALUE_SCRIPT = ROOT / "scripts" / "env-value.sh"
STATE_DIR = ROOT / ".env.encryption-key.d"


def _env_value(*args: str, new_value: str | None = None) -> str:
    """Run scripts/env-value.sh, which asks Docker Compose what an env file resolves to."""
    env = dict(os.environ)
    if new_value is not None:
        env["ENV_VALUE_NEW"] = new_value
    result = subprocess.run(
        ["sh", str(ENV_VALUE_SCRIPT), *args], capture_output=True, text=True, env=env
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "could not read .env with docker compose")
    return result.stdout


def _needs_value(key: str, resolved: str) -> bool:
    """Whether the value Compose resolves for ``key`` should be replaced with a generated one."""
    # Compose reads `NAME=   # note` as the value "# note"; that is a comment, not a value.
    if not resolved or resolved.startswith("#"):
        return True
    return key not in FRESH_ONLY_KEYS and resolved.lower() in PUBLISHED_PLACEHOLDERS


def effective_value(text: str, key: str) -> str:
    """The value Docker Compose resolves for ``key`` in .env text (empty when unset)."""
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / ".env"
        _write_private(path, text)
        return _env_value("get", key, str(path))


def fill_secrets(text: str, keys: tuple[str, ...] = GENERATED_KEYS) -> str:
    """Give every key in ``keys`` a generated value unless Docker Compose already resolves one.

    What counts is the value Compose resolves, not the text of any one line, so an
    assignment written in any form it accepts (indented, exported, ``NAME: value``,
    quoted, repeated, inside a multi-line value) is judged the way the services see it.
    """
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / ".env"
        _write_private(path, text)
        for key in keys:
            if _needs_value(key, _env_value("get", key, str(path))):
                _write_private(
                    path, _env_value("set", key, str(path), new_value=secrets.token_hex(32))
                )
        return path.read_text()


@contextlib.contextmanager
def key_lock():
    """Hold the encryption key lock while starting services or rewriting .env.

    Same protocol as scripts/with-key-lock.sh: a rotation holds the lock for its whole run,
    so nothing starts with a key the database is being moved away from. Refuses while a
    rotation has not finished. Re-entrant through TRACEROOT_KEY_LOCK_HELD.
    """
    if os.environ.get("COMPOSE_ENV_FILES") not in (None, "", ".env"):
        raise SystemExit(
            "COMPOSE_ENV_FILES is set to a file other than .env, so Docker Compose would not "
            "read the .env this command manages. Unset it and run again."
        )
    if os.name == "nt" or os.environ.get("TRACEROOT_KEY_LOCK_HELD"):
        yield
        return
    if STATE_DIR.is_symlink():
        raise SystemExit(f"{STATE_DIR.name} is a symlink. Remove it and run again.")
    STATE_DIR.mkdir(mode=0o700, exist_ok=True)
    try:
        fd = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise SystemExit(
            f"{STATE_DIR.name} must be a directory. Remove it and run again."
        ) from None
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise SystemExit(
                f"{STATE_DIR.name} must be owned by you with mode 700. Remove it and run again."
            )
        try:
            os.mkdir("lock", 0o700, dir_fd=fd)
        except FileExistsError:
            raise SystemExit(
                "Another start or key rotation is running. Wait for it to finish, or remove "
                f"{STATE_DIR.name}/lock if none is."
            ) from None
        try:
            pid_fd = os.open("lock/pid", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
            with os.fdopen(pid_fd, "w") as handle:
                handle.write(f"{os.getpid()}\n")
            try:
                os.stat("pending", dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise SystemExit(
                    "A key rotation did not finish. Run make rotate-encryption-key again to "
                    f"finish it (or remove {STATE_DIR.name}/pending to abandon it) before starting."
                )
            os.environ["TRACEROOT_KEY_LOCK_HELD"] = "1"
            yield
        finally:
            os.environ.pop("TRACEROOT_KEY_LOCK_HELD", None)
            for name in ("lock/pid",):
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(name, dir_fd=fd)
            with contextlib.suppress(FileNotFoundError):
                os.rmdir("lock", dir_fd=fd)
    finally:
        os.close(fd)


def _write_private(path: Path, text: str) -> None:
    """Replace ``path`` with ``text`` through a private temporary file in the same directory.

    The temporary file is created exclusively with mode 0600 and renamed over the target,
    so the new content is never readable by others and a link at the target is replaced
    rather than followed.
    """
    fd, tmp_name = tempfile.mkstemp(prefix=f"{path.name}.tmp.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def ensure_env_file(
    env_path: Path = ENV_PATH,
    example_path: Path = ENV_EXAMPLE_PATH,
    keys: tuple[str, ...] = GENERATED_KEYS,
) -> None:
    """Create .env if absent, then give every placeholder secret a real value."""
    with key_lock():
        _ensure_env_file(env_path, example_path, keys)


def _ensure_env_file(env_path: Path, example_path: Path, keys: tuple[str, ...]) -> None:
    if env_path.is_symlink():
        raise SystemExit(
            f"{env_path} is a symlink. Refusing to write secrets through it -- "
            "replace it with a regular file."
        )
    if not env_path.exists():
        print("Creating .env from .env.example...")
        _write_private(env_path, example_path.read_text())
    else:
        print("Found existing .env file.")
        os.chmod(env_path, 0o600)  # it holds generated secrets, not just defaults

    text = env_path.read_text()
    filled = fill_secrets(text, keys)
    if filled != text:
        print("  Generated a unique value for the local auth secrets.")
        _write_private(env_path, filled)


def ensure_infra():
    """Start docker containers if not already running."""
    print("Ensuring infrastructure is running (PostgreSQL, ClickHouse, MinIO, Redis)...")
    print("Waiting for containers to be healthy...")
    _run(
        f"{DOCKER_COMPOSE} up -d --wait postgres clickhouse minio redis",
    )
    # minio-init is a one-shot, idempotent setup container — start it after MinIO is healthy.
    _run(f"{DOCKER_COMPOSE} up -d minio-init")
    # clickhouse-init provisions the SQL-gateway DB users (sql_gateway_writer is the
    # DEFINER of migration 012's views, so it must exist before goose runs). Run it to
    # completion here: the goose docker fallback uses `--no-deps` and the local-goose
    # path bypasses compose, so neither honors the migrate-clickhouse depends_on.
    _run(f"{DOCKER_COMPOSE} run --rm --no-deps clickhouse-init")


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
    # The agent service imports @traceroot-ai/tools, which resolves through its
    # compiled dist (the package ships dist-only exports for npm publishing, so
    # unlike @traceroot/core it can't be consumed from source in dev). Build it
    # here so `make dev` mirrors the Dockerfile's build-tools-before-agent step;
    # without it the Agent window crashes on startup with ERR_MODULE_NOT_FOUND.
    print("Building shared tools package (@traceroot-ai/tools)...")
    _run(
        ["pnpm", "build"],
        cwd="frontend/packages/tools",
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


def run_env_only(env_path: Path = ENV_PATH, example_path: Path = ENV_EXAMPLE_PATH) -> None:
    """Repair .env for the ``dev-lite`` make target, then let make take over.

    ``dev-lite`` brings the stack up with docker-compose.prod.yml, so the set it
    needs is prod compose's, not the dev one: repairing only the dev keys left
    compose aborting on the ``:?`` gate of the prod-only secret.
    """
    ensure_env_file(env_path, example_path, keys=ALL_GENERATED_KEYS)


def run_prod_setup():
    """Build Docker images and start all services. Idempotent."""
    # One lock for the whole start, so a key rotation cannot begin between steps.
    with key_lock():
        _start_prod_services()


def _start_prod_services():
    ensure_env_file(keys=ALL_GENERATED_KEYS)

    # Compose reports only that preflight failed; running it directly prints which value to change.
    _run(f"{PROD_COMPOSE} run --rm preflight")

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
    _run(f"{PROD_COMPOSE} up -d web rest worker billing detector agent")

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


def _teardown_env() -> dict[str, str]:
    """Environment for compose commands that only remove things.

    Compose interpolates every required variable even for ``down``, so a reset
    would otherwise fail before removing anything when .env is missing. Nothing
    here reaches a container -- the containers are on their way out.
    """
    env = dict(os.environ)
    for key in ALL_GENERATED_KEYS:
        env.setdefault(key, "unused-for-teardown")
    return env


def reset_prod_environment() -> None:
    print("Resetting production environment...")
    _kill_tmux_session("traceroot-prod")
    _remove_sandbox_containers()
    _run(f"{PROD_COMPOSE} down -v --rmi local", env=_teardown_env())
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

    # TZ=UTC ensures all Python processes use UTC as local time, so
    # naive datetimes from otel_transform and clickhouse-connect are consistent.
    tz_prefix = "TZ=UTC "

    # macOS fork safety — Celery's prefork pool + Redis triggers an Objective-C
    # runtime crash (SIGABRT) unless this is set before the process starts.
    objc_prefix = (
        "OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES " if os.uname().sysname == "Darwin" else ""
    )

    if autoreload:
        rest_command = (
            f"{tz_prefix}"
            "uv run uvicorn rest.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend"
        )
        celery_command = (
            f"{tz_prefix}{objc_prefix}"
            "uv run watchfiles --filter python "
            "'celery -A worker.celery_app worker --loglevel=info' "
            "backend/worker"
        )
    else:
        rest_command = f"{tz_prefix}uv run python backend/rest/main.py"
        celery_command = (
            f"{tz_prefix}{objc_prefix}uv run celery -A worker.celery_app worker --loglevel=info"
        )

    return schema.Driver(
        name="traceroot",
        on_start=run_setup,
        services=[
            schema.Service(
                title="Frontend",
                command="cd frontend/ui && pnpm dev",
                web_urls=[
                    ("traceroot UI", f"http://localhost:{FRONTEND_PORT}"),
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
                command="cd frontend/worker && pnpm dev:billing",
                web_urls=[],
            ),
            schema.Service(
                title="Detector Worker",
                command="cd frontend/worker && pnpm dev:detectors",
                web_urls=[],
            ),
            schema.Service(
                title="Agent",
                command="cd frontend/ee/agent && pnpm dev",
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
                    ("traceroot UI", f"http://localhost:{FRONTEND_PORT}"),
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
                title="Detector Worker",
                command=f"{PROD_COMPOSE} logs -f --tail=50 detector",
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
    parser = argparse.ArgumentParser(description="Launch traceroot dev environment")
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
    mode.add_argument(
        "--env-only",
        action="store_true",
        help="Create or repair .env and exit (used by the dev-lite make target)",
    )
    args = parser.parse_args()

    # Ensure the launcher process itself uses UTC, so inline steps like
    # run_goose() and Prisma migrations produce consistent timestamps.
    os.environ.setdefault("TZ", "UTC")

    os.chdir(ROOT)

    if args.env_only:
        run_env_only()
        return
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
