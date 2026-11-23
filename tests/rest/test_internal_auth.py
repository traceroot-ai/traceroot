"""The internal secret: one credential, and what it does and does not decide.

A trace's `source` comes from the ingest path the caller reached, never from
who authenticated — see `tests/rest/test_detector_endpoints.py` for that. This
module pins the guard itself.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from rest.routers.internal.auth import verify_internal_secret
from shared.config import settings


@pytest.fixture()
def probe(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "platform-secret")
    app = FastAPI()

    @app.get("/guarded", dependencies=[Depends(verify_internal_secret)])
    def guarded():
        return {"ok": True}

    return TestClient(app)


def test_the_secret_is_accepted(probe):
    r = probe.get("/guarded", headers={"X-Internal-Secret": "platform-secret"})
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_another_value_is_rejected(probe):
    assert probe.get("/guarded", headers={"X-Internal-Secret": "nope"}).status_code == 403


def test_missing_header_is_rejected(probe):
    assert probe.get("/guarded").status_code == 403


def test_empty_header_is_rejected(probe):
    assert probe.get("/guarded", headers={"X-Internal-Secret": ""}).status_code == 403


def test_no_secret_configured_is_503(monkeypatch):
    """Fails closed and loudly: a deployment that never configured the secret
    rejects internal traffic rather than accepting an empty header."""
    monkeypatch.setattr(settings, "internal_api_secret", "")
    app = FastAPI()

    @app.get("/guarded", dependencies=[Depends(verify_internal_secret)])
    def guarded():
        return {"ok": True}

    c = TestClient(app)
    assert c.get("/guarded", headers={"X-Internal-Secret": "anything"}).status_code == 503
    assert c.get("/guarded", headers={"X-Internal-Secret": ""}).status_code == 503


def test_a_published_placeholder_counts_as_unset():
    """This repository shipped working defaults for the secret once; a
    deployment that never overrode them must read as misconfigured, not as
    sharing a secret with every other install."""
    from shared.config import Settings

    assert Settings(internal_api_secret="dev-internal-secret").internal_api_secret == ""
    assert Settings(internal_api_secret="x" * 64).internal_api_secret == "x" * 64
