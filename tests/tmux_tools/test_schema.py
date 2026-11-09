import socket

from tmux_tools import launcher, schema


def test_prerequisite_uses_check_fn():
    dep = schema.Prerequisite(
        name="custom check",
        check_fn=lambda: schema.CheckResult(True, ""),
    )

    result = dep.check()

    assert result.succeeded is True
    assert result.message == ""


def test_port_check_reports_in_use():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        result = launcher._check_port_available(sock.getsockname()[1])

    assert result.succeeded is False
    assert "in use" in result.message


def test_banner_fits_the_terminal_it_is_rendered_for():
    import re

    from tmux_tools.banner import FULL_MIN_COLUMNS, render_banner

    def widest(text: str) -> int:
        return max(len(re.sub(r"\033\[[0-9;]*m", "", line)) for line in text.split("\n"))

    assert widest(render_banner(columns=80)) <= 80
    assert widest(render_banner(columns=FULL_MIN_COLUMNS)) <= FULL_MIN_COLUMNS


def test_banner_has_no_escape_codes_when_no_color_is_set(monkeypatch):
    from tmux_tools.banner import render_banner

    monkeypatch.setenv("NO_COLOR", "1")

    assert "\033" not in render_banner(columns=80)


def test_welcome_screen_leads_with_the_banner():
    screen = schema.WelcomeScreen(
        title="development environment", web_urls=[], additional_instructions=""
    )

    text = screen.render_text()

    assert "continuously improves your ai agents" in text
    assert "Welcome to the TraceRoot development environment." in text
