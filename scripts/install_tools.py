#!/usr/bin/env python3
"""
install_tools.py - Production-grade cross-platform dev-tools installer.

Installs:
  * Docker - Docker Desktop (Mac/Win) or Docker Engine (Linux)
  * uv - Python package manager by Astral
  * pnpm - Node.js package manager
  * tmux - Terminal multiplexer
  * goose - pressly/goose DB migration tool (ClickHouse-compatible)

Platforms:
  macOS - Homebrew (auto-installed if absent)
  Linux - apt-get / dnf / yum / pacman / zypper (auto-detected)
  Windows - winget / PowerShell / direct binary download
            Works from: PowerShell, cmd.exe, Git Bash (MINGW64), WSL

Requires Python 3.7+ with zero external dependencies (stdlib only).

Usage:
  python install_tools.py              # check & install all tools
  python install_tools.py --check      # status report, no changes
  python install_tools.py docker tmux  # install specific tools only
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
#  Platform constants
# ──────────────────────────────────────────────────────────────────────────────

for stream_name in ("stdout", "stderr"):
    stream = getattr(sys, stream_name, None)
    if stream and hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

_SYS = platform.system()  # "Windows" | "Darwin" | "Linux"
_ARCH = platform.machine().lower()  # "x86_64" | "amd64" | "arm64" | "aarch64"

IS_WIN = _SYS == "Windows"
IS_MAC = _SYS == "Darwin"
IS_LIN = _SYS == "Linux"
IS_ARM = _ARCH in ("arm64", "aarch64")

# Detect Git Bash / MINGW / Cygwin running on top of Windows
IS_MINGW = IS_WIN or ("MSYSTEM" in os.environ)  # covers MINGW64, MSYS2, Cygwin shells

# ──────────────────────────────────────────────────────────────────────────────
#  Colour output (gracefully disabled when not a TTY or NO_COLOR is set)
# ──────────────────────────────────────────────────────────────────────────────
_COLOUR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, t: str) -> str:
    return f"\033[{code}m{t}\033[0m" if _COLOUR else t


def green(t: str) -> str:
    return _c("32", t)


def yellow(t: str) -> str:
    return _c("33", t)


def red(t: str) -> str:
    return _c("31", t)


def bold(t: str) -> str:
    return _c("1", t)


def cyan(t: str) -> str:
    return _c("36", t)


def dim(t: str) -> str:
    return _c("2", t)


def _log(icon: str, msg: str) -> None:
    # Indent every continuation line so multi-line messages stay readable
    lines = str(msg).splitlines()
    print(f"  {icon}  {lines[0]}")
    for line in lines[1:]:
        print(f"       {line}")


def info(msg: str) -> None:
    _log(cyan("i"), msg)


def ok(msg: str) -> None:
    _log(green("✔"), msg)


def warn(msg: str) -> None:
    _log(yellow("⚠"), msg)


def err(msg: str) -> None:
    _log(red("✖"), msg)


def step(msg: str) -> None:
    _log(dim("·"), msg)


def section(t: str) -> None:
    print(f"\n{bold('──')} {bold(t)}")


# ──────────────────────────────────────────────────────────────────────────────
#  Subprocess helpers
# ──────────────────────────────────────────────────────────────────────────────


def _build_env(extra: dict | None = None) -> dict:
    env = os.environ.copy()
    if extra:
        env.update(extra)
    return env


def run(
    *args: str,
    check: bool = True,
    capture: bool = False,
    shell: bool = False,
    env: dict | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess:
    """
    Portable subprocess wrapper.

    On Windows, if the first token resolves to a .cmd / .bat file (common for
    package-manager shims like scoop.cmd, npm.cmd, pnpm.cmd …), the call is
    automatically routed through 'cmd /c' so it works from any host shell.
    """
    merged = _build_env(env)
    kw: dict = dict(check=check, env=merged, timeout=timeout)
    if capture:
        kw.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    if shell:
        # Caller explicitly requested a shell — honour it
        cmd = args[0] if len(args) == 1 else subprocess.list2cmdline(list(args))
        return subprocess.run(cmd, shell=True, **kw)

    cmd_list = list(args)

    # ── Windows: transparently handle .cmd / .bat shims ──────────────────────
    if IS_WIN:
        exe = shutil.which(cmd_list[0])
        if exe and Path(exe).suffix.lower() in (".cmd", ".bat"):
            cmd_list = ["cmd", "/c"] + cmd_list

    return subprocess.run(cmd_list, **kw)


def run_ps(
    script: str, *, check: bool = True, capture: bool = False
) -> subprocess.CompletedProcess:
    """Execute a PowerShell one-liner / script block on Windows."""
    ps = _find_powershell()
    return run(
        ps,
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "ByPass",
        "-Command",
        script,
        check=check,
        capture=capture,
    )


def _find_powershell() -> str:
    """Return 'pwsh' (PS 7+) if available, else 'powershell' (built-in PS 5)."""
    for candidate in ("pwsh", "powershell"):
        if shutil.which(candidate):
            return candidate
    # Hard-coded fallback for Windows system PowerShell
    fallback = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    if Path(fallback).exists():
        return fallback
    raise RuntimeError("PowerShell not found. Install PowerShell 7: https://aka.ms/powershell")


def probe(*args: str) -> bool:
    """Return True if a command exits 0 (used for lightweight presence checks)."""
    try:
        run(*args, check=True, capture=True, timeout=10)
        return True
    except Exception:
        return False


def which(cmd: str) -> str | None:
    """Locate an executable on the current shell's PATH only."""
    return shutil.which(cmd)


def try_strategies(name: str, strategies: list[tuple[str, Callable[[], None]]]) -> bool:
    """
    Attempt each (label, fn) in order.  Returns True on first success.
    Prints a clear message for each attempt and swallows per-strategy errors.
    """
    for label, fn in strategies:
        step(f"Trying: {label} …")
        try:
            fn()
            return True
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            warn(f"  Strategy '{label}' failed: {exc}")
    return False


# ──────────────────────────────────────────────────────────────────────────────
#  Network helpers
# ──────────────────────────────────────────────────────────────────────────────


def download(url: str, dest: str, *, retries: int = 3) -> None:
    headers = {
        "User-Agent": "Mozilla/5.0 install-tools-script/2.0",
        "Accept": "*/*",
    }
    step(f"Downloading {url}")
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
                f.write(resp.read())
            return
        except Exception as exc:
            last_exc = exc
            if attempt < retries:
                wait = attempt * 3
                warn(f"Download attempt {attempt} failed ({exc}). Retrying in {wait}s…")
                time.sleep(wait)
    raise RuntimeError(f"Download failed after {retries} attempts: {last_exc}") from last_exc


def github_latest_tag(repo: str, fallback: str) -> str:
    """Return the latest release tag from GitHub, with a fallback."""
    try:
        url = f"https://api.github.com/repos/{repo}/releases/latest"
        req = urllib.request.Request(
            url, headers={"User-Agent": "install-tools-script/2.0", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            tag = json.loads(r.read().decode())["tag_name"]
            step(f"Latest {repo} release: {tag}")
            return tag
    except Exception as exc:
        warn(f"Could not fetch latest tag for {repo} ({exc}) — using {fallback}")
        return fallback


def make_executable(path: str) -> None:
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


# ──────────────────────────────────────────────────────────────────────────────
#  Windows PATH helpers
# ──────────────────────────────────────────────────────────────────────────────


def win_add_to_user_path(directory: str) -> None:
    """
    Permanently add *directory* to the current user's PATH in the Windows registry.

    Why not setx?  setx reads %PATH% from the *process* environment (which
    includes the Machine PATH), and writes the combined string back to the
    *User* PATH key.  On most systems this exceeds 1024 chars and setx
    silently truncates it, breaking the PATH.

    We use PowerShell to read the User PATH key directly from the registry,
    append only if not already present, and write it back — safe regardless
    of length.
    """
    d = str(directory).replace("'", "\\'")
    ps_script = (
        "$p = [Environment]::GetEnvironmentVariable('PATH','User'); "
        f"$d = '{d}'; "
        "if ($p -split ';' -notcontains $d) { "
        "  [Environment]::SetEnvironmentVariable('PATH', \"$p;$d\", 'User'); "
        f"  Write-Host \"Added '$d' to user PATH (effective in new terminals).\" "
        "} else { "
        f"  Write-Host \"'$d' is already in user PATH.\" "
        "}"
    )
    try:
        run_ps(ps_script, check=True)
        ok(f"PATH updated — '{d}' will be available in new terminals.")
    except Exception as exc:
        warn(f"Could not auto-update PATH: {exc}\nAdd this directory to your PATH manually:\n  {d}")


# ──────────────────────────────────────────────────────────────────────────────
#  Linux package-manager helpers
# ──────────────────────────────────────────────────────────────────────────────


def linux_pm() -> str | None:
    for pm in ("apt-get", "dnf", "yum", "pacman", "zypper", "apk"):
        if shutil.which(pm):
            return pm
    return None


def linux_install(*packages: str) -> None:
    pm = linux_pm()
    if pm is None:
        raise RuntimeError(
            "No supported package manager found.\nSupported: apt-get, dnf, yum, pacman, zypper, apk"
        )
    step(f"Using package manager: {pm}")
    if pm == "apt-get":
        run("sudo", "apt-get", "update", "-qq", check=False)
        run("sudo", "apt-get", "install", "-y", "--no-install-recommends", *packages)
    elif pm in ("dnf", "yum"):
        run("sudo", pm, "install", "-y", *packages)
    elif pm == "pacman":
        run("sudo", "pacman", "-Sy", "--noconfirm", *packages)
    elif pm == "zypper":
        run("sudo", "zypper", "--non-interactive", "install", *packages)
    elif pm == "apk":
        run("sudo", "apk", "add", "--no-cache", *packages)


# ──────────────────────────────────────────────────────────────────────────────
#  macOS Homebrew helpers
# ──────────────────────────────────────────────────────────────────────────────


def ensure_brew() -> None:
    if shutil.which("brew"):
        return
    section("Homebrew not found - installing...")
    install_sh = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
    with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as f:
        tmp = f.name
    try:
        download(install_sh, tmp)
        make_executable(tmp)
        run("/bin/bash", tmp, env={"NONINTERACTIVE": "1"})
        ok("Homebrew installed.")
        # Apple Silicon: add brew shellenv so it's usable in this process too
        brew_paths = [
            "/opt/homebrew/bin/brew",
            "/usr/local/bin/brew",
        ]
        for p in brew_paths:
            if Path(p).exists():
                os.environ["PATH"] = f"{Path(p).parent}:{os.environ['PATH']}"
                break
    finally:
        os.unlink(tmp)


def brew(*args: str) -> None:
    ensure_brew()
    run("brew", *args)


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL: Docker
# ══════════════════════════════════════════════════════════════════════════════


def check_docker() -> bool:
    # probe() actually executes the binary — shutil.which() only checks PATH existence
    return probe("docker", "--version")


def _docker_mac() -> None:
    brew("install", "--cask", "docker")
    ok("Docker Desktop installed.")
    info("Launch Docker Desktop from Applications to start the daemon.")


def _docker_linux() -> None:
    with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as f:
        tmp = f.name
    try:
        download("https://get.docker.com", tmp)
        make_executable(tmp)
        run("sh", tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    for var in ("SUDO_USER", "USER", "LOGNAME"):
        user = os.environ.get(var)
        if user and user != "root":
            run("sudo", "usermod", "-aG", "docker", user, check=False)
            warn(f"Added '{user}' to docker group — log out/in for it to take effect.")
            break
    ok("Docker Engine installed.")


def _docker_win_winget() -> None:
    run_ps(
        "winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements --silent"
    )
    ok("Docker Desktop installed via winget.")
    warn("A system restart may be required before Docker works.")


def _docker_win_direct() -> None:
    warn("winget not found — downloading Docker Desktop installer directly…")
    url = (
        "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
        if IS_ARM
        else "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    )
    tmp = os.path.join(tempfile.gettempdir(), "DockerDesktopInstaller.exe")
    download(url, tmp)
    run(tmp, "install", "--quiet", "--accept-license")
    ok("Docker Desktop installed.")
    warn("A system restart may be required before Docker works.")


def install_docker() -> None:
    section("Installing Docker…")
    if IS_MAC:
        _docker_mac()
    elif IS_LIN:
        _docker_linux()
    elif IS_WIN:
        success = try_strategies(
            "Docker",
            [
                ("winget", _docker_win_winget),
                ("direct download", _docker_win_direct),
            ],
        )
        if not success:
            raise RuntimeError(
                "All Docker installation strategies failed.\n"
                "Download manually: https://docs.docker.com/desktop/install/windows-install/"
            )


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL: uv
# ══════════════════════════════════════════════════════════════════════════════


def check_uv() -> bool:
    return probe("uv", "--version")


def _uv_unix() -> None:
    with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as f:
        tmp = f.name
    try:
        download("https://astral.sh/uv/install.sh", tmp)
        make_executable(tmp)
        run("sh", tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _uv_win_ps() -> None:
    run_ps("irm https://astral.sh/uv/install.ps1 | iex")


def _uv_win_winget() -> None:
    run_ps(
        "winget install --id astral-sh.uv -e --accept-package-agreements --accept-source-agreements"
    )


def install_uv() -> None:
    section("Installing uv (Astral)…")
    if IS_WIN:
        success = try_strategies(
            "uv",
            [
                ("PowerShell install script", _uv_win_ps),
                ("winget", _uv_win_winget),
            ],
        )
        if not success:
            raise RuntimeError(
                "uv installation failed.\n"
                "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
            )
    else:
        _uv_unix()
    ok("uv installed.")
    info("Run 'source $HOME/.cargo/env' or open a new shell to use uv.")


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL: pnpm
# ══════════════════════════════════════════════════════════════════════════════


def check_pnpm() -> bool:
    return probe("pnpm", "--version")


def _pnpm_unix() -> None:
    with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as f:
        tmp = f.name
    try:
        download("https://get.pnpm.io/install.sh", tmp)
        make_executable(tmp)
        run("sh", tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _pnpm_win_ps() -> None:
    run_ps("iwr https://get.pnpm.io/install.ps1 -useb | iex")


def _pnpm_win_npm() -> None:
    """Fallback: install pnpm via npm (if Node.js is already available)."""
    run("npm", "install", "-g", "pnpm")


def _pnpm_win_winget() -> None:
    run_ps(
        "winget install --id pnpm.pnpm -e --accept-package-agreements --accept-source-agreements"
    )


def install_pnpm() -> None:
    section("Installing pnpm…")
    if IS_WIN:
        success = try_strategies(
            "pnpm",
            [
                ("PowerShell install script", _pnpm_win_ps),
                ("winget", _pnpm_win_winget),
                ("npm global install", _pnpm_win_npm),
            ],
        )
        if not success:
            raise RuntimeError(
                "pnpm installation failed.\nInstall manually: https://pnpm.io/installation"
            )
    else:
        _pnpm_unix()
    ok("pnpm installed.")
    info("Open a new shell (or source your profile) for pnpm to be in PATH.")


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL: tmux
# ══════════════════════════════════════════════════════════════════════════════


def check_tmux() -> bool:
    # IMPORTANT: we must probe() — not just look for a file on disk.
    # On Windows, tmux.exe may exist inside C:\msys64\usr\bin but not be
    # on the current shell's PATH, so shutil.which() and file-existence
    # checks both give false-positives.  probe() actually executes the
    # binary the same way the shell would, so it can only return True when
    # tmux is genuinely usable from the current terminal.
    return probe("tmux", "-V")


def _msys2_candidates() -> list[Path]:
    """Common MSYS2 installation directories on Windows."""
    candidates = [
        Path("C:/msys64"),
        Path("C:/msys32"),
        Path("C:/tools/msys64"),
    ]
    # Also check Scoop's MSYS2 location
    scoop_root = Path(os.environ["SCOOP"]) if os.environ.get("SCOOP") else Path.home() / "scoop"
    candidates.append(scoop_root / "apps" / "msys2" / "current")
    candidates.append(scoop_root / "apps" / "msys2" / "2024")
    return candidates


def _tmux_via_existing_msys2() -> None:
    """Install tmux via pacman if MSYS2 is already present."""
    for root in _msys2_candidates():
        pacman = root / "usr" / "bin" / "pacman.exe"
        if pacman.exists():
            step(f"Found MSYS2 at {root} — installing tmux via pacman")
            run(str(pacman), "-Sy", "--noconfirm", "tmux")
            tmux_bin = root / "usr" / "bin"
            ok(f"tmux installed to {tmux_bin}")
            win_add_to_user_path(str(tmux_bin))
            return
    raise RuntimeError("MSYS2 not found in any standard location.")


def _tmux_via_winget_msys2() -> None:
    """Install MSYS2 via winget, then install tmux via pacman."""
    step("Installing MSYS2 via winget…")
    run_ps(
        "winget install --id MSYS2.MSYS2 -e "
        "--accept-package-agreements --accept-source-agreements --silent"
    )
    # Give the installer a moment to finish
    time.sleep(5)
    _tmux_via_existing_msys2()


def _tmux_via_scoop() -> None:
    """Install MSYS2 via Scoop, then tmux via pacman."""
    # Scoop shim is a .cmd file — must use PowerShell or cmd /c
    step("Installing MSYS2 via Scoop…")
    run_ps("scoop install msys2")
    time.sleep(3)
    _tmux_via_existing_msys2()


def _tmux_via_scoop_direct() -> None:
    """Some Scoop repos have a direct tmux package."""
    step("Trying 'scoop install tmux' directly…")
    run_ps("scoop bucket add extras; scoop install tmux")


def _tmux_via_choco() -> None:
    """Install tmux via Chocolatey."""
    step("Installing tmux via Chocolatey…")
    choco = shutil.which("choco")
    if not choco:
        raise RuntimeError("choco not found.")
    # choco.exe is a real .exe, not a .cmd shim
    run(choco, "install", "msys2", "-y")
    time.sleep(3)
    _tmux_via_existing_msys2()


def _tmux_via_wsl() -> None:
    """Install tmux inside WSL2 (uses the wsl.exe bridge)."""
    wsl = shutil.which("wsl")
    if not wsl:
        raise RuntimeError("WSL (wsl.exe) not found.")
    # Check if a default distro is set up
    result = run(wsl, "--list", "--quiet", capture=True, check=False)
    if result.returncode != 0:
        raise RuntimeError("No WSL2 distro installed. Run 'wsl --install' first.")
    step("Installing tmux inside WSL2…")
    run(wsl, "sudo", "apt-get", "update", "-qq")
    run(wsl, "sudo", "apt-get", "install", "-y", "tmux")
    ok("tmux installed inside WSL2.")
    info(
        "Access tmux via WSL: open a WSL shell and run 'tmux'.\n"
        "To launch from Windows Terminal, select your WSL distro profile."
    )


def _install_scoop_then_tmux() -> None:
    """Bootstrap Scoop if absent, then install MSYS2+tmux."""
    if not shutil.which("scoop") and run_ps("scoop --version", check=False).returncode != 0:
        step("Scoop not found — installing Scoop first…")
        run_ps(
            "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; "
            "iwr -useb https://get.scoop.sh | iex"
        )
        time.sleep(3)
    _tmux_via_scoop()


def install_tmux() -> None:
    section("Installing tmux…")

    if IS_MAC:
        brew("install", "tmux")
        ok("tmux installed.")
        return

    if IS_LIN:
        linux_install("tmux")
        ok("tmux installed.")
        return

    # ── Windows: try a chain of strategies ───────────────────────────────────
    # tmux has no native Win32 binary — it must run inside a POSIX layer
    # (MSYS2/Cygwin) or WSL2.  We try the most likely paths first.

    success = try_strategies(
        "tmux (Windows)",
        [
            ("MSYS2 already installed → pacman", _tmux_via_existing_msys2),
            ("winget install MSYS2 → pacman", _tmux_via_winget_msys2),
            ("Scoop install msys2 → pacman", _tmux_via_scoop),
            ("Bootstrap Scoop → msys2 → pacman", _install_scoop_then_tmux),
            ("Scoop extras → tmux direct", _tmux_via_scoop_direct),
            ("Chocolatey install msys2 → pacman", _tmux_via_choco),
            ("WSL2 apt install tmux", _tmux_via_wsl),
        ],
    )

    if not success:
        # None of the automated strategies worked — give clear manual guidance
        warn(
            "Automated tmux installation was not possible on this system.\n"
            "\n"
            "Manual options (choose one):\n"
            "\n"
            "  Option A - MSYS2 (recommended for Git Bash users):\n"
            "    1. Download MSYS2: https://www.msys2.org/\n"
            "    2. Run the installer → default path C:\\msys64\n"
            "    3. Open 'MSYS2 UCRT64' shell and run:\n"
            "         pacman -Sy --noconfirm tmux\n"
            "    4. Add C:\\msys64\\usr\\bin to your system PATH.\n"
            "\n"
            "  Option B - WSL2 (Linux environment on Windows):\n"
            "    1. In PowerShell (Admin): wsl --install\n"
            "    2. Restart, then open Ubuntu from the Start menu.\n"
            "    3. Inside Ubuntu:  sudo apt install tmux\n"
            "\n"
            "  Option C - Scoop:\n"
            "    1. Open PowerShell and run:\n"
            "         Set-ExecutionPolicy RemoteSigned -Scope CurrentUser\n"
            "         iwr -useb https://get.scoop.sh | iex\n"
            "    2. scoop install msys2\n"
            "    3. Open MSYS2 shell → pacman -S tmux\n"
        )
        raise RuntimeError(
            "tmux could not be installed automatically. See the manual instructions printed above."
        )


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL: goose (pressly/goose)
# ══════════════════════════════════════════════════════════════════════════════


def check_goose() -> bool:
    candidates: list[Path] = []
    exe_name = "goose.exe" if IS_WIN else "goose"
    candidates.append(Path.home() / "bin" / exe_name)
    candidates.append(Path.home() / "go" / "bin" / exe_name)
    resolved = which("goose")
    if resolved:
        candidates.append(Path(resolved))

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen or not candidate.exists():
            continue
        seen.add(key)
        try:
            result = run(str(candidate), "--help", check=False, capture=True)
        except Exception:
            continue
        output = "\n".join(part for part in (result.stdout, result.stderr) if part)
        if result.returncode == 0 and (
            "-dir string" in output
            or "GOOSE_DRIVER" in output
            or "Usage: goose DRIVER DBSTRING [OPTIONS] COMMAND" in output
        ):
            return True
    return False


def _goose_asset_name() -> str:
    """Return the GitHub release asset filename for the current platform."""
    arch = "arm64" if IS_ARM else "x86_64"
    if IS_WIN:
        return f"goose_windows_{arch}.exe"
    if IS_MAC:
        return f"goose_darwin_{arch}"
    return f"goose_linux_{arch}"


def _goose_direct_download(tag: str) -> None:
    fname = _goose_asset_name()
    url = f"https://github.com/pressly/goose/releases/download/{tag}/{fname}"
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, fname)
        download(url, dest)
        if IS_WIN:
            install_dir = Path(os.environ.get("USERPROFILE", "C:\\")) / "bin"
            install_dir.mkdir(parents=True, exist_ok=True)
            out = install_dir / "goose.exe"
            shutil.copy(dest, out)
            win_add_to_user_path(str(install_dir))
            ok(f"goose {tag} installed → {out}")
        else:
            install_path = "/usr/local/bin/goose"
            make_executable(dest)
            shutil.copy(dest, install_path)
            make_executable(install_path)
            ok(f"goose {tag} installed → {install_path}")


def _goose_via_go() -> None:
    """Install goose via 'go install' if Go is on the system."""
    if not shutil.which("go"):
        raise RuntimeError("Go not found.")
    run("go", "install", "github.com/pressly/goose/v3/cmd/goose@latest")
    ok("goose installed via 'go install'.")


def _goose_via_brew() -> None:
    brew("install", "goose")
    ok("goose installed via Homebrew.")


def install_goose() -> None:
    section("Installing goose (pressly/goose)…")
    tag = github_latest_tag("pressly/goose", fallback="v3.24.1")

    strategies: list[tuple[str, Callable]] = [
        (f"Direct download ({tag})", lambda: _goose_direct_download(tag)),
        ("go install latest", _goose_via_go),
    ]
    if IS_MAC:
        strategies.insert(1, ("Homebrew", _goose_via_brew))

    success = try_strategies("goose", strategies)
    if not success:
        raise RuntimeError(
            "goose installation failed.\nInstall manually: https://github.com/pressly/goose#install"
        )
    if check_goose():
        ok("A valid pressly/goose binary is available.")
    else:
        warn(
            "Installed pressly/goose, but another 'goose' executable may still be taking precedence on PATH.\n"
            f"Preferred install locations checked by TraceRoot:\n  {Path.home() / 'bin' / ('goose.exe' if IS_WIN else 'goose')}\n"
            f"  {Path.home() / 'go' / 'bin' / ('goose.exe' if IS_WIN else 'goose')}"
        )


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL REGISTRY
# ══════════════════════════════════════════════════════════════════════════════

TOOLS: list[tuple[str, str, Callable, Callable]] = [
    #  key       display name   check_fn       install_fn
    ("docker", "Docker", check_docker, install_docker),
    ("uv", "uv", check_uv, install_uv),
    ("pnpm", "pnpm", check_pnpm, install_pnpm),
    ("tmux", "tmux", check_tmux, install_tmux),
    ("goose", "goose", check_goose, install_goose),
]

TOOL_KEYS = [t[0] for t in TOOLS]

# ──────────────────────────────────────────────────────────────────────────────
#  CLI
# ──────────────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "tools",
        nargs="*",
        metavar="TOOL",
        help=f"Tools to target (default: all). Options: {', '.join(TOOL_KEYS)}",
    )
    p.add_argument(
        "--check",
        action="store_true",
        help="Report status only; do not install anything.",
    )
    args = p.parse_args()
    # Validate tool names
    unknown = set(args.tools) - set(TOOL_KEYS)
    if unknown:
        p.error(f"Unknown tool(s): {', '.join(sorted(unknown))}. Valid: {', '.join(TOOL_KEYS)}")
    return args


def main() -> None:
    args = parse_args()
    selected = set(args.tools) if args.tools else set(TOOL_KEYS)

    width = 56
    bar = "═" * width
    print(bold(f"\n{bar}"))
    print(bold("  Dev-Tools Installer  v2.0"))
    print(dim(f"  OS: {_SYS}  |  Arch: {_ARCH}"))
    if IS_MINGW and "MSYSTEM" in os.environ:
        print(dim(f"  Shell environment: {os.environ['MSYSTEM']}"))
    print(bold(f"{bar}"))
    if args.check:
        print(yellow("  (check-only mode — nothing will be installed)"))

    results: list[tuple[str, str]] = []
    failed = False

    for key, name, check_fn, install_fn in TOOLS:
        if key not in selected:
            continue
        try:
            installed = check_fn()
        except Exception:
            installed = False

        if installed:
            ok(f"{name:<10} already installed — skipping")
            results.append((name, green("already installed")))
            continue

        if args.check:
            warn(f"{name:<10} NOT installed")
            results.append((name, yellow("not installed")))
            continue

        warn(f"{name} not found — starting installation…")
        try:
            install_fn()
            results.append((name, green("installed ✔")))
        except KeyboardInterrupt:
            err("Cancelled by user.")
            results.append((name, red("cancelled")))
            break
        except Exception as exc:
            err(f"Could not install {name}:\n  {exc}")
            results.append((name, red("FAILED")))
            failed = True

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{bold(bar)}")
    print(bold("  Summary"))
    print(bold(bar))
    for name, status in results:
        print(f"  {name:<14} {status}")
    print(bold(bar))

    if failed:
        print(red("\n  One or more tools failed to install."))
        print(red("  See the error messages above for manual steps.\n"))
    elif not args.check:
        print(yellow("\n  ⚡  Restart your terminal/IDE so PATH changes take effect.\n"))

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
