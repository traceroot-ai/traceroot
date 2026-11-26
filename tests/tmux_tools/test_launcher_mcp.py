"""The launcher checks and advertises the port the dev MCP server listens on, and installs its deps."""

from tmux_tools import launcher


def test_mcp_port_follows_mcp_service_url_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_SERVICE_URL", "http://localhost:9300")
    assert launcher.mcp_port(tmp_path / ".env") == 9300
    monkeypatch.setenv("MCP_SERVICE_URL", "http://localhost:80")
    assert launcher.mcp_port(tmp_path / ".env") == 80


def test_mcp_port_reads_env_when_the_environment_has_none(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_SERVICE_URL", raising=False)
    env_path = tmp_path / ".env"
    env_path.write_text("MCP_SERVICE_URL=http://localhost:9400\n")
    monkeypatch.setattr(launcher, "_env_value", lambda *args: "http://localhost:9400")
    assert launcher.mcp_port(env_path) == 9400


def test_mcp_port_falls_back_to_8200(tmp_path, monkeypatch):
    monkeypatch.delenv("MCP_SERVICE_URL", raising=False)
    assert launcher.mcp_port(tmp_path / ".env") == 8200  # no .env yet
    monkeypatch.setenv("MCP_SERVICE_URL", "http://mcp")
    assert launcher.mcp_port(tmp_path / ".env") == 8200
    monkeypatch.setenv("MCP_SERVICE_URL", "http://mcp:notaport")
    assert launcher.mcp_port(tmp_path / ".env") == 8200


def test_frontend_deps_install_when_only_mcp_lacks_node_modules(tmp_path, monkeypatch):
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    (tmp_path / "frontend" / "mcp").mkdir()
    monkeypatch.chdir(tmp_path)
    calls = []
    monkeypatch.setattr(launcher, "_run", lambda command, **kwargs: calls.append(command))

    launcher.ensure_frontend_deps()

    assert ["pnpm", "install"] in calls
