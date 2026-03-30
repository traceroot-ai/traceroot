import socket

from tmux_tools import launcher, process, tmux
from tmux_tools.tmux import SessionConfig, SessionLayout, TmuxSession, Window


def test_prepare_command_wraps_windows_cmd_shims(monkeypatch):
    monkeypatch.setattr(process, "IS_WINDOWS", True)
    monkeypatch.setattr(process.shutil, "which", lambda cmd: r"C:\Program Files\nodejs\pnpm.cmd")

    command = process.prepare_command(["pnpm", "install"])

    assert command == ["cmd", "/c", "pnpm", "install"]


def test_prepare_command_wraps_windows_powershell_scripts(monkeypatch):
    monkeypatch.setattr(process, "IS_WINDOWS", True)
    monkeypatch.setattr(process.shutil, "which", lambda cmd: r"C:\Users\dev\bin\custom.ps1")
    monkeypatch.setattr(process, "_find_powershell", lambda: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")

    command = process.prepare_command(["custom-tool", "--check"])

    assert command == [
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "ByPass",
        "-File",
        r"C:\Users\dev\bin\custom.ps1",
        "--check",
    ]


def test_port_check_reports_in_use():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        result = launcher._check_port_available(sock.getsockname()[1])

    assert result.succeeded is False
    assert "in use" in result.message


def test_shell_command_path_converts_windows_paths(monkeypatch):
    monkeypatch.setattr(tmux.os, "name", "nt")

    assert tmux._shell_command_path(r"C:\msys64\usr\bin\bash.exe") == "/c/msys64/usr/bin/bash.exe"


def test_launch_keeps_welcome_window_non_interactive(monkeypatch):
    commands: list[str] = []

    monkeypatch.setattr(tmux, "_resolve_tmux_shell", lambda: "/usr/bin/bash")

    session = TmuxSession(
        SessionConfig(
            server_name="development",
            session_name="traceroot",
            config_file="/tmp/tmux.conf",
        )
    )
    monkeypatch.setattr(session, "exec", commands.append)
    monkeypatch.setattr(session, "tmux_cmd", lambda *args, **kwargs: None)
    monkeypatch.setattr(session, "send_keys", lambda *args, **kwargs: None)

    session.launch(
        SessionLayout(
            welcome=Window(name="Instructions", command="printf '%s\\n' 'hello'; tail -f /dev/null"),
            windows=[],
            on_exit=None,
        )
    )

    assert len(commands) == 1
    assert "exec /usr/bin/bash" not in commands[0]
    assert "tail -f /dev/null" in commands[0]
