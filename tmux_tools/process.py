"""Cross-platform subprocess helpers for developer tooling."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path

IS_WINDOWS = os.name == "nt"


def _find_powershell() -> str:
    for candidate in ("pwsh", "powershell"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    fallback = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    if fallback.exists():
        return str(fallback)

    raise FileNotFoundError("PowerShell was not found on this system.")


def prepare_command(command: Sequence[str]) -> list[str]:
    """Adapt commands so Windows shell shims work from Python subprocesses."""
    prepared = list(command)
    if not prepared or not IS_WINDOWS:
        return prepared

    executable = shutil.which(prepared[0])
    if not executable:
        return prepared

    suffix = Path(executable).suffix.lower()
    if suffix in {".cmd", ".bat"}:
        return ["cmd", "/c", *prepared]
    if suffix == ".ps1":
        return [
            _find_powershell(),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "ByPass",
            "-File",
            executable,
            *prepared[1:],
        ]
    return prepared


def run_command(
    command: Sequence[str],
    *,
    check: bool = True,
    capture_output: bool = False,
    text: bool = True,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        prepare_command(command),
        check=check,
        capture_output=capture_output,
        text=text,
        cwd=cwd,
        env=env,
        timeout=timeout,
    )
