"""Pin the internal-secret checks to constant-time comparison.

The X-Internal-Secret header authenticates trusted server-to-server calls that
can act on behalf of any user, so the comparison must not short-circuit on the
first differing byte — response timing would otherwise let an attacker without
the secret recover it byte-by-byte. Both verification sites already compare via
``hmac.compare_digest``; these tests pin the accept/reject matrix and assert
the comparison actually routes through it, so a refactor back to ``==`` fails.
"""

import hmac

import pytest
from fastapi import HTTPException

from rest.routers.deps import get_project_access
from rest.routers.internal import verify_internal_secret
from shared.config import settings


@pytest.fixture()
def compare_digest_spy(monkeypatch):
    """Record calls to hmac.compare_digest while preserving its behavior.

    Args:
        monkeypatch: pytest fixture used to swap in the recording wrapper.

    Returns:
        list[tuple]: One entry per comparison performed.
    """
    calls: list[tuple] = []
    real = hmac.compare_digest

    def recording(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(hmac, "compare_digest", recording)
    return calls


@pytest.fixture()
def secret(monkeypatch):
    """Configure a known internal secret for the duration of a test."""
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


class TestVerifyInternalSecret:
    """The internal router's header dependency."""

    def test_correct_secret_accepted(self, secret):
        verify_internal_secret(x_internal_secret=secret)  # does not raise

    def test_wrong_secret_rejected(self, secret):
        with pytest.raises(HTTPException) as exc:
            verify_internal_secret(x_internal_secret="wrong-secret")
        assert exc.value.status_code == 403

    def test_missing_header_rejected(self, secret):
        with pytest.raises(HTTPException) as exc:
            verify_internal_secret(x_internal_secret=None)
        assert exc.value.status_code == 403

    def test_unset_server_secret_fails_closed(self, monkeypatch):
        monkeypatch.setattr(settings, "internal_api_secret", "")
        with pytest.raises(HTTPException) as exc:
            verify_internal_secret(x_internal_secret="anything")
        assert exc.value.status_code == 503

    def test_comparison_is_constant_time(self, secret, compare_digest_spy):
        verify_internal_secret(x_internal_secret=secret)
        with pytest.raises(HTTPException):
            verify_internal_secret(x_internal_secret="wrong-secret")
        assert len(compare_digest_spy) == 2


class TestProjectAccessInternalBypass:
    """The system-bypass branch of the project-access dependency."""

    async def test_correct_secret_grants_system_access(self, secret, compare_digest_spy):
        info = await get_project_access(project_id="p1", x_user_id=None, x_internal_secret=secret)
        assert info.user_id == "system"
        assert len(compare_digest_spy) == 1

    async def test_wrong_secret_falls_through_to_401(self, secret):
        with pytest.raises(HTTPException) as exc:
            await get_project_access(
                project_id="p1", x_user_id=None, x_internal_secret="wrong-secret"
            )
        assert exc.value.status_code == 401

    async def test_unset_server_secret_never_matches(self, monkeypatch):
        monkeypatch.setattr(settings, "internal_api_secret", "")
        with pytest.raises(HTTPException) as exc:
            await get_project_access(project_id="p1", x_user_id=None, x_internal_secret="")
        assert exc.value.status_code == 401
