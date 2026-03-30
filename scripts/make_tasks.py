"""Cross-platform implementations for the repository's make targets."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from tmux_tools.launcher import make_driver, make_prod_driver
from tmux_tools.process import run_command

ROOT = Path(__file__).resolve().parent.parent
DEV_NODE_MODULES = [
    ROOT / "frontend" / "node_modules",
    ROOT / "frontend" / "ui" / "node_modules",
    ROOT / "frontend" / "worker" / "node_modules",
    ROOT / "frontend" / "packages" / "core" / "node_modules",
]


def _remove_path(path: Path) -> None:
    if not path.exists():
        return
    if path.is_file() or path.is_symlink():
        path.unlink()
        return
    shutil.rmtree(path)


def _kill_tmux_session(session_name: str) -> None:
    run_command(
        ["tmux", "-L", "development", "kill-session", "-t", session_name],
        check=False,
        capture_output=True,
    )


def _remove_sandbox_containers() -> None:
    result = run_command(
        ["docker", "ps", "-aq", "--filter", "name=traceroot-sandbox-"],
        check=False,
        capture_output=True,
    )
    container_ids = result.stdout.split()
    if container_ids:
        run_command(["docker", "rm", "-f", *container_ids], check=False, capture_output=True)


def dev() -> None:
    make_driver().run()


def dev_autoreload() -> None:
    make_driver(autoreload=True).run()


def dev_reset() -> None:
    print("Resetting everything...")
    _kill_tmux_session("traceroot")
    _remove_sandbox_containers()
    run_command(["docker", "compose", "down", "-v"])
    for path in DEV_NODE_MODULES:
        _remove_path(path)
    _remove_path(ROOT / ".venv")
    print("Done. Run 'make dev' to start fresh.")


def prod() -> None:
    make_prod_driver().run()


def prod_reset() -> None:
    print("Resetting production environment...")
    _kill_tmux_session("traceroot-prod")
    _remove_sandbox_containers()
    run_command(["docker", "compose", "-f", "docker-compose.prod.yml", "down", "-v", "--rmi", "local"])
    print("Done. Run 'make prod' to start fresh.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "target",
        choices=["dev", "dev-autoreload", "dev-reset", "prod", "prod-reset"],
        help="Make target to execute.",
    )
    args = parser.parse_args()

    os.chdir(ROOT)

    if args.target == "dev":
        dev()
    elif args.target == "dev-autoreload":
        dev_autoreload()
    elif args.target == "dev-reset":
        dev_reset()
    elif args.target == "prod":
        prod()
    else:
        prod_reset()


if __name__ == "__main__":
    main()
