"""Per-caller internal secrets: which secret authenticated decides the caller id."""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from rest.routers.internal.auth import InternalCaller, verify_internal_secret
from shared.config import settings


@pytest.fixture()
def secrets(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "platform-secret")
    monkeypatch.setattr(settings, "internal_api_secret_agent", "agent-secret")


@pytest.fixture()
def probe(secrets):
    app = FastAPI()

    @app.get("/whoami")
    def whoami(caller: InternalCaller = Depends(verify_internal_secret)):
        return {"caller": caller}

    return TestClient(app)


def test_platform_secret_resolves_to_platform(probe):
    r = probe.get("/whoami", headers={"X-Internal-Secret": "platform-secret"})
    assert r.status_code == 200 and r.json() == {"caller": "platform"}


def test_agent_secret_resolves_to_agent(probe):
    r = probe.get("/whoami", headers={"X-Internal-Secret": "agent-secret"})
    assert r.status_code == 200 and r.json() == {"caller": "agent"}


def test_unknown_secret_is_rejected(probe):
    assert probe.get("/whoami", headers={"X-Internal-Secret": "nope"}).status_code == 403


def test_missing_header_is_rejected(probe):
    assert probe.get("/whoami").status_code == 403


def test_agent_secret_optional_when_unset(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "platform-secret")
    monkeypatch.setattr(settings, "internal_api_secret_agent", "")
    app = FastAPI()

    @app.get("/whoami")
    def whoami(caller: InternalCaller = Depends(verify_internal_secret)):
        return {"caller": caller}

    c = TestClient(app)
    assert c.get("/whoami", headers={"X-Internal-Secret": "platform-secret"}).json() == {
        "caller": "platform"
    }
    # An empty agent secret must never match an empty header.
    assert c.get("/whoami", headers={"X-Internal-Secret": ""}).status_code == 403


def test_no_platform_secret_configured_is_503(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "")
    monkeypatch.setattr(settings, "internal_api_secret_agent", "agent-secret")
    app = FastAPI()

    @app.get("/whoami")
    def whoami(caller: InternalCaller = Depends(verify_internal_secret)):
        return {"caller": caller}

    assert (
        TestClient(app).get("/whoami", headers={"X-Internal-Secret": "agent-secret"}).status_code
        == 503
    )


# ── Settings refuses one credential for two callers ──────────────────────


def _settings(**overrides):
    from shared.config import Settings

    return Settings(**overrides)


def test_equal_secrets_are_refused_at_startup():
    """Same value twice would identify every agent request as the platform and
    store agent traces as 'detector' with nothing reporting it."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="must differ"):
        _settings(internal_api_secret="x" * 64, internal_api_secret_agent="x" * 64)


def test_agent_secret_may_be_unset():
    s = _settings(internal_api_secret="x" * 64, internal_api_secret_agent="")
    assert s.internal_api_secret == "x" * 64 and s.internal_api_secret_agent == ""


def test_platform_secret_unset_with_agent_set_is_accepted():
    """Not equal, so Settings loads; verify_internal_secret then answers 503 for
    every request (see test_no_platform_secret_configured_is_503)."""
    s = _settings(internal_api_secret="", internal_api_secret_agent="y" * 64)
    assert s.internal_api_secret == "" and s.internal_api_secret_agent == "y" * 64
