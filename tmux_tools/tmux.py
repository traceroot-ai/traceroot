"""Tmux session management: create, attach, and control tmux sessions."""

import shlex
import subprocess
import time
from dataclasses import dataclass
from shlex import quote

# ---------------------------------------------------------------------------
# Shell helpers (private)
# ---------------------------------------------------------------------------


def _format_error(cmd: str, cmd_output: subprocess.CompletedProcess) -> str:
    result: list[str] = []
    result.append(f"Executed command `{cmd}` and got error code {cmd_output.returncode}.")
    if cmd_output.stdout:
        result.append("Standard Out:")
        result.append(_indent(cmd_output.stdout))
    if cmd_output.stderr:
        result.append("Standard Error:")
        result.append(_indent(cmd_output.stderr))
    return "\n".join(result)


def _shell(cmd: str) -> subprocess.CompletedProcess:
    parts = shlex.split(cmd)
    return subprocess.run(
        parts,
        capture_output=True,
        text=True,
    )


def _parse_cmd_name(cmd: str) -> str:
    parts = shlex.split(cmd)
    return parts[0]


def _shell_checked(cmd: str):
    output = _shell(cmd)
    if output.returncode != 0:
        print(_format_error(cmd, output))
        exit(1)


def _indent(text: str) -> str:
    parts = []
    for line in text.split("\n"):
        if line:
            parts.append(f"    {line}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Window:
    name: str
    command: str


@dataclass
class SessionConfig:
    server_name: str
    session_name: str
    config_file: str


@dataclass
class SessionLayout:
    welcome: Window
    windows: list[Window]
    on_exit: str | None


# ---------------------------------------------------------------------------
# TmuxSession — manages a single tmux server+session
# ---------------------------------------------------------------------------


class TmuxSession:
    def __init__(self, config: SessionConfig) -> None:
        self.config = config

    def reattach_existing(self) -> bool:
        if not self.is_running():
            return False
        result = input(
            "\nA development environment is already running. Would you like to re-attach to"
            " the existing development environment? Note, the existing development"
            " environment may be running with a different configuration than"
            " requested. (y/N) "
        )
        if result in ["y", "Y", "yes"]:
            self.attach()
            return True
        self.tmux_cmd("kill-session")
        # Wait for the previous tmux session to be killed
        time.sleep(2)
        return False

    def set_exit_hook(self, cmd: str) -> None:
        run_cmd = f"run {quote(cmd)}"
        self.exec(f'set-hook -g "session-closed" {quote(run_cmd)}')

    def launch(self, layout: SessionLayout) -> None:
        welcome_command = f"{layout.welcome.command};bash"
        command = f"bash -c {quote(welcome_command)}"
        self.exec(
            f"-f {quote(self.config.config_file)} "
            f"new-session -d -s {quote(self.config.session_name)} "
            f"-n {quote(layout.welcome.name)} {quote(command)}"
        )
        for window in layout.windows:
            self.tmux_cmd("new-window", f"-n {quote(window.name)} bash")
            self.send_keys(window.name, window.command)
        if layout.on_exit:
            self.set_exit_hook(layout.on_exit)
        self.tmux_cmd("select-window", "-n")

    def attach(self) -> None:
        self.tmux_cmd("attach")

    def tmux_cmd(self, command: str, args: str = "") -> None:
        self.exec(f"{command} -t {quote(self.config.session_name)} {args}")

    def exec(self, command: str) -> None:
        _shell_checked(f"tmux -L {quote(self.config.server_name)} {command}")

    def is_running(self) -> bool:
        output = _shell(f'tmux -L {quote(self.config.server_name)} list-sessions -F "#S"')
        if output.returncode != 0:
            return False
        sessions = output.stdout.split("\n")
        return self.config.session_name in sessions

    def send_keys(self, window: str, command: str) -> None:
        self.exec(
            f"send-keys -t {quote(self.config.session_name)}:{quote(window)} {quote(command)} C-m"
        )

    def verify_installation(self) -> bool:
        from tmux_tools.schema import Prerequisite

        dep = Prerequisite(
            name="tmux is installed",
            command="tmux -V",
            expected_output="tmux 3.",
            instructions="""
Please install tmux version 3 or above.

    Mac:   brew install tmux
    Linux: sudo apt install tmux
""",
        )
        print("Checking prerequisite:", dep.name)
        result = dep.check()
        if not result.succeeded:
            print(result.message)
        return result.succeeded
