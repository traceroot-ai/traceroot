"""ClickHouse migration helpers."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

DEFAULTS = {
    "CLICKHOUSE_HOST": "localhost",
    "CLICKHOUSE_PORT": "9000",
    "CLICKHOUSE_USER": "clickhouse",
    "CLICKHOUSE_PASSWORD": "clickhouse",
    "CLICKHOUSE_DATABASE": "default",
}
PRESSLY_GOOSE_MARKERS = (
    "-dir string",
    "GOOSE_DRIVER",
    "Usage: goose DRIVER DBSTRING [OPTIONS] COMMAND",
)
DOCKER_GOOSE_ACTIONS = {"up", "down", "status"}


def _run_command(
    command: list[str],
    *,
    check: bool = True,
    capture_output: bool = False,
    text: bool = True,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        check=check,
        capture_output=capture_output,
        text=text,
        cwd=cwd,
        env=env,
        timeout=timeout,
    )


def migrations_dir() -> Path:
    return Path(__file__).resolve().parent / "migrations"


def goose_dbstring(env: dict[str, str] | None = None) -> str:
    values = {**DEFAULTS, **(env or {})}
    return (
        "tcp://"
        f"{values['CLICKHOUSE_HOST']}:{values['CLICKHOUSE_PORT']}"
        f"?username={values['CLICKHOUSE_USER']}"
        f"&password={values['CLICKHOUSE_PASSWORD']}"
        f"&database={values['CLICKHOUSE_DATABASE']}"
    )


def _goose_candidates(env: dict[str, str] | None = None) -> list[Path]:
    merged_env = {**os.environ, **(env or {})}
    candidates = [
        Path.home() / "bin" / "goose",
        Path.home() / "go" / "bin" / "goose",
    ]

    resolved = shutil.which("goose", path=merged_env.get("PATH"))
    if resolved:
        candidates.append(Path(resolved))

    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def is_pressly_goose(executable: str | Path, env: dict[str, str] | None = None) -> bool:
    candidate = Path(executable)
    if not candidate.exists():
        return False

    try:
        result = _run_command(
            [str(candidate), "--help"],
            check=False,
            capture_output=True,
            env={**os.environ, **(env or {})},
        )
    except OSError:
        return False

    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    return result.returncode == 0 and any(marker in output for marker in PRESSLY_GOOSE_MARKERS)


def resolve_pressly_goose(env: dict[str, str] | None = None) -> str | None:
    for candidate in _goose_candidates(env):
        if is_pressly_goose(candidate, env):
            return str(candidate)
    return None


def goose_command(
    action: str,
    *,
    name: str | None = None,
    env: dict[str, str] | None = None,
    executable: str | None = None,
) -> list[str]:
    command = [
        executable or "goose",
        "-dir",
        str(migrations_dir()),
        "clickhouse",
        goose_dbstring(env),
        action,
    ]
    if action == "create":
        if not name:
            raise ValueError("A migration name is required when using the 'create' action.")
        command.extend([name, "sql"])
    elif name:
        raise ValueError(f"Migration name is not supported for action '{action}'.")
    return command


def docker_goose_command(action: str) -> list[str]:
    if action not in DOCKER_GOOSE_ACTIONS:
        raise ValueError(
            f"Docker fallback is only supported for: {', '.join(sorted(DOCKER_GOOSE_ACTIONS))}"
        )
    return [
        "docker",
        "compose",
        "run",
        "--rm",
        "--no-deps",
        "migrate-clickhouse",
        action,
    ]


def run_goose(
    action: str,
    *,
    name: str | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
    capture_output: bool = False,
    docker_fallback: bool = False,
) -> subprocess.CompletedProcess:
    merged_env = {**os.environ, **(env or {})}
    executable = resolve_pressly_goose(merged_env)

    if executable:
        return _run_command(
            goose_command(action, name=name, env=merged_env, executable=executable),
            check=check,
            capture_output=capture_output,
            env=merged_env,
        )

    if docker_fallback:
        return _run_command(
            docker_goose_command(action),
            check=check,
            capture_output=capture_output,
            env=merged_env,
        )

    raise FileNotFoundError(
        "Could not find pressly/goose on PATH. Install pressly/goose or use the "
        "Docker-backed migration flow."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ClickHouse goose migrations.")
    parser.add_argument(
        "action",
        choices=["up", "down", "status", "create"],
        help="Migration action to execute.",
    )
    parser.add_argument(
        "name",
        nargs="?",
        help="Migration name when using the 'create' action.",
    )
    args = parser.parse_args()
    if args.action == "create" and not args.name:
        parser.error("the following arguments are required for 'create': name")
    if args.action != "create" and args.name:
        parser.error(f"unexpected migration name for action '{args.action}'")
    return args


def main() -> int:
    args = parse_args()
    result = run_goose(
        args.action,
        name=args.name,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
