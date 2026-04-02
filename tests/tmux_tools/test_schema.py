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
