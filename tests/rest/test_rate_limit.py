"""Behavioral spec tests for the REST rate-limiting feature.

These tests are written STRICTLY to the target SPEC (enterprise == pro tiers,
self-host disables the limiter entirely a la Langfuse, etc.). Some are EXPECTED
to fail against the current implementation, which is about to be reworked; that
separation is intentional (anti-reward-hacking): the tests assert the SPEC, not
whatever the current code happens to return.

Groups:
    A. resolve_limit signature guard (param must literally be ``key``).
    B. Bucket key format (rl:{bucket}:{plan}:{workspace}).
    C. Tier values (enterprise EQUALS pro) + normalize_plan.
    D. Self-host disables the limiter; cloud + master switch toggles it.
    E. Enforcement + exemption via a fresh standalone limiter + app.
"""

import inspect
import os
import sys

import pytest
from fastapi import Depends, FastAPI, Request, Response
from fastapi.testclient import TestClient
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

# ``ee`` lives at the repo root, but pyproject only puts ``backend`` on the
# path. Importing rest.rate_limit triggers ``from ee.license import ...``, so
# ensure the repo root is importable before importing the module under test.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import rest.rate_limit as rate_limit  # noqa: E402
from shared.config import normalize_plan, settings  # noqa: E402


@pytest.fixture()
def _restore_billing_env():
    """Snapshot/restore ENABLE_BILLING around tests that mutate it.

    The repo .env sets ENABLE_BILLING=false (self-host), which conftest loads
    into the process env. Tests that depend on the billing context set it
    explicitly and this fixture restores the original afterward.
    """
    sentinel = object()
    original = os.environ.get("ENABLE_BILLING", sentinel)
    yield
    if original is sentinel:
        os.environ.pop("ENABLE_BILLING", None)
    else:
        os.environ["ENABLE_BILLING"] = original  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# A. resolve_limit signature guard
# ---------------------------------------------------------------------------
def test_resolve_limit_signature_is_literal_key():
    """slowapi only forwards the bucket key when the param is named ``key``."""
    # Arrange / Act
    params = list(inspect.signature(rate_limit.resolve_limit).parameters)

    # Assert
    assert params == ["key"]


# ---------------------------------------------------------------------------
# B. Bucket key format
# ---------------------------------------------------------------------------
def _make_stamped_request(workspace_id: str, billing_plan: str) -> Request:
    """Build a bare Request and stamp the rate-limit identity onto it."""
    request = Request({"type": "http", "headers": [], "state": {}})
    rate_limit.set_rate_limit_identity(request, workspace_id, billing_plan)
    return request


def test_key_ingest_format_embeds_bucket_plan_and_workspace():
    """key_ingest returns rl:ingest:{plan}:{workspace} after identity stamp.

    set_rate_limit_identity / key_* do not read billing, so the stamped plan is
    the literal plan regardless of ENABLE_BILLING — no env pin needed.
    """
    # Arrange
    request = _make_stamped_request("ws-abc", "pro")

    # Act
    key = rate_limit.key_ingest(request)

    # Assert
    assert key == f"rl:{rate_limit.BUCKET_INGEST}:pro:ws-abc"


def test_key_read_format_embeds_bucket_plan_and_workspace():
    """key_read returns rl:read:{plan}:{workspace} after identity stamp."""
    # Arrange
    request = _make_stamped_request("ws-xyz", "free")

    # Act
    key = rate_limit.key_read(request)

    # Assert
    assert key == f"rl:{rate_limit.BUCKET_READ}:free:ws-xyz"


# ---------------------------------------------------------------------------
# C. Tier values (enterprise EQUALS pro) + normalize_plan
# ---------------------------------------------------------------------------
def test_ingest_enterprise_equals_pro():
    """Enterprise ingest tier mirrors pro (20000/minute)."""
    assert (
        settings.rate_limit.limit_for("ingest", "enterprise")
        == settings.rate_limit.limit_for("ingest", "pro")
        == "20000/minute"
    )


def test_read_enterprise_equals_pro():
    """Enterprise read tier mirrors pro (1000/minute)."""
    assert (
        settings.rate_limit.limit_for("read", "enterprise")
        == settings.rate_limit.limit_for("read", "pro")
        == "1000/minute"
    )


def test_free_tier_sanity_values():
    """Free tier values are the documented defaults."""
    assert settings.rate_limit.limit_for("read", "free") == "60/minute"
    assert settings.rate_limit.limit_for("ingest", "free") == "1000/minute"


def test_normalize_plan_unknown_and_none_fall_back_to_free():
    """Unknown or missing plans collapse to the most restrictive tier."""
    assert normalize_plan(None) == "free"
    assert normalize_plan("") == "free"
    assert normalize_plan("platinum") == "free"


def test_normalize_plan_is_case_insensitive():
    """Plan resolution is case-insensitive."""
    assert normalize_plan("ENTERPRISE") == "enterprise"
    assert normalize_plan("Pro") == "pro"


# ---------------------------------------------------------------------------
# D. Self-host disables the limiter; cloud + master switch toggles it
# ---------------------------------------------------------------------------
def test_self_host_disables_limiter_even_when_master_switch_on(monkeypatch, _restore_billing_env):
    """ENABLE_BILLING=false (self-host) => limiter disabled regardless of switch."""
    # Arrange: master switch ON, but self-host.
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    os.environ["ENABLE_BILLING"] = "false"

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is False


def test_self_host_disables_limiter_with_whitespace_value(monkeypatch, _restore_billing_env):
    """ENABLE_BILLING with surrounding whitespace (common via YAML/env quoting)
    still counts as self-host and disables the limiter."""
    # Arrange: master switch ON; self-host value with stray whitespace.
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    os.environ["ENABLE_BILLING"] = "  false  "

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is False


def test_self_host_disables_limiter_even_when_master_switch_off(monkeypatch, _restore_billing_env):
    """Self-host with the master switch off is still disabled."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", False)
    os.environ["ENABLE_BILLING"] = "false"

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is False


def test_cloud_unset_billing_with_master_switch_on_enables_limiter(
    monkeypatch, _restore_billing_env
):
    """Cloud (ENABLE_BILLING unset) + master switch on => limiter enabled."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    os.environ.pop("ENABLE_BILLING", None)

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is True


def test_cloud_billing_true_with_master_switch_on_enables_limiter(
    monkeypatch, _restore_billing_env
):
    """Cloud (ENABLE_BILLING=true) + master switch on => limiter enabled."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    os.environ["ENABLE_BILLING"] = "true"

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is True


def test_master_switch_off_disables_limiter_on_cloud(monkeypatch, _restore_billing_env):
    """Master switch off => limiter disabled even on cloud."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", False)
    os.environ.pop("ENABLE_BILLING", None)

    # Act
    built = rate_limit._build_limiter()

    # Assert
    assert built.enabled is False


# ---------------------------------------------------------------------------
# E. Enforcement + exemption (fresh standalone limiter + minimal app)
# ---------------------------------------------------------------------------
def _build_enforcement_app(*, exempt: bool) -> FastAPI:
    """Build a minimal app with its OWN enabled limiter and a 2/min read route.

    A dependency stamps the identity (and optionally marks the request exempt)
    before the route body runs, mirroring the production wiring. The limiter is
    standalone (enabled=True) so these tests do not depend on the module-level
    ``limiter`` being enabled.
    """
    limiter = Limiter(
        key_func=get_remote_address,
        enabled=True,
        storage_uri="memory://",
        headers_enabled=True,
        in_memory_fallback_enabled=True,
        swallow_errors=True,
    )

    async def stamp(request: Request):
        rate_limit.clear_request_rate_limit_exempt()
        if exempt:
            rate_limit.mark_request_rate_limit_exempt()
        rate_limit.set_rate_limit_identity(request, "ws1", "free")

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit.rate_limit_exceeded_handler)

    @app.get("/r")
    @limiter.shared_limit(
        "2/minute",
        scope="read",
        key_func=rate_limit.key_read,
        exempt_when=rate_limit.is_request_rate_limit_exempt,
    )
    async def read(request: Request, response: Response, _=Depends(stamp)):
        return {"ok": True}

    return app


def test_enforcement_third_request_is_throttled_with_429_envelope():
    """A 2/min limit yields [200, 200, 429]; only the 429 carries the error envelope.

    Asserts 429-SPECIFIC evidence (the JSON envelope + Retry-After on the
    throttled response). slowapi emits X-RateLimit-*/Retry-After on 200s too, so
    a bare header-presence check would not distinguish a throttle from success.
    """
    # Arrange
    client = TestClient(_build_enforcement_app(exempt=False))

    # Act
    responses = [client.get("/r") for _ in range(3)]
    codes = [r.status_code for r in responses]

    # Assert: throttle kicks in on the 3rd request.
    assert codes == [200, 200, 429]
    # A successful response returns the route body, not the rate-limit envelope.
    assert responses[0].json() == {"ok": True}
    # The 429 carries the rate-limit JSON envelope (429-specific) + a usable
    # Retry-After on the throttled response itself.
    throttled = responses[2]
    body = throttled.json()
    assert body["error"] == "too_many_requests"
    assert body["retry_after"] >= 1
    assert int(throttled.headers["Retry-After"]) >= 1


def test_exempt_requests_bypass_the_limit():
    """Marked-exempt requests are never throttled despite the same 2/min limit."""
    # Arrange
    client = TestClient(_build_enforcement_app(exempt=True))

    # Act
    codes = [client.get("/r").status_code for _ in range(5)]

    # Assert
    assert codes == [200] * 5


# ---------------------------------------------------------------------------
# F. resolve_limit dynamic-limit path (slowapi forwards the key per request)
# ---------------------------------------------------------------------------
def _build_resolve_limit_app(plan: str, workspace: str) -> FastAPI:
    """App whose read route uses the REAL resolve_limit as the dynamic limit.

    Unlike the hardcoded-"2/minute" enforcement app, this wires resolve_limit as
    the limit_value, exercising the full fragile path: slowapi forwards the
    bucket key (from key_read) into resolve_limit, which maps the embedded plan
    to its configured limit.
    """
    limiter = Limiter(
        key_func=get_remote_address,
        enabled=True,
        storage_uri="memory://",
        headers_enabled=True,
        in_memory_fallback_enabled=True,
        swallow_errors=True,
    )

    async def stamp(request: Request):
        rate_limit.clear_request_rate_limit_exempt()
        rate_limit.set_rate_limit_identity(request, workspace, plan)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit.rate_limit_exceeded_handler)

    @app.get("/r")
    @limiter.shared_limit(
        rate_limit.resolve_limit,
        scope=rate_limit.BUCKET_READ,
        key_func=rate_limit.key_read,
        exempt_when=rate_limit.is_request_rate_limit_exempt,
    )
    async def read(request: Request, response: Response, _=Depends(stamp)):
        return {"ok": True}

    return app


def test_resolve_limit_applies_per_plan_limits(monkeypatch):
    """slowapi forwards the key to resolve_limit, which returns the plan's limit.

    If resolve_limit failed to receive the key (e.g. the ``key`` param were
    renamed → slowapi calls it arg-less → error swallowed → no limit) or returned
    the wrong tier, the per-plan distinction below would collapse. free is
    throttled on the 3rd read; pro (a higher limit) is not.
    """
    # Arrange: distinct per-plan read limits on the live settings singleton
    # (resolve_limit reads these per request).
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_free", "2/minute")
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_pro", "10/minute")

    # Act / Assert: a free workspace hits its 2/min ceiling on the 3rd read.
    free_client = TestClient(_build_resolve_limit_app("free", "ws-free"))
    assert [free_client.get("/r").status_code for _ in range(3)] == [200, 200, 429]

    # A pro workspace (10/min) is NOT throttled at the same 3 reads — proving
    # resolve_limit returned a different, plan-specific limit for the same bucket.
    pro_client = TestClient(_build_resolve_limit_app("pro", "ws-pro"))
    assert [pro_client.get("/r").status_code for _ in range(3)] == [200, 200, 200]


# ---------------------------------------------------------------------------
# G. Hardening: enterprise tracks pro, shadow mode, degraded-storage signal
# ---------------------------------------------------------------------------
def test_enterprise_tier_tracks_pro_override(monkeypatch):
    """Enterprise mirrors pro even when pro is RAISED via env — not a frozen literal.

    Guards against the desync where bumping RATE_LIMIT_*_PRO would leave
    enterprise stuck below pro.
    """
    # Arrange: raise pro, leave enterprise at its (mirroring) default.
    monkeypatch.setattr(rate_limit.settings.rate_limit, "ingest_pro", "30000/minute")
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_pro", "7000/minute")

    # Assert: enterprise follows pro.
    assert rate_limit.settings.rate_limit.limit_for("ingest", "enterprise") == "30000/minute"
    assert rate_limit.settings.rate_limit.limit_for("read", "enterprise") == "7000/minute"


def test_explicit_enterprise_override_beats_the_pro_mirror(monkeypatch):
    """An explicit enterprise value still wins over the pro mirror."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_pro", "1000/minute")
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_enterprise", "9000/minute")

    # Assert
    assert rate_limit.settings.rate_limit.limit_for("read", "enterprise") == "9000/minute"


def _build_app_with_limiter(limiter, *, plan: str, workspace: str) -> FastAPI:
    """Wire a given limiter into a minimal read app using the real resolve_limit."""

    async def stamp(request: Request):
        rate_limit.clear_request_rate_limit_exempt()
        rate_limit.set_rate_limit_identity(request, workspace, plan)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit.rate_limit_exceeded_handler)

    @app.get("/r")
    @limiter.shared_limit(
        rate_limit.resolve_limit,
        scope=rate_limit.BUCKET_READ,
        key_func=rate_limit.key_read,
        exempt_when=rate_limit.is_request_rate_limit_exempt,
    )
    async def read(request: Request, response: Response, _=Depends(stamp)):
        return {"ok": True}

    return app


def test_shadow_mode_records_but_does_not_block(monkeypatch, caplog):
    """Shadow mode evaluates the limit (counts + logs) but never returns 429."""
    # Arrange: shadow on, billing on, tiny limit, deterministic in-memory storage.
    monkeypatch.setattr(rate_limit.settings.rate_limit, "shadow", True)
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    monkeypatch.setattr(rate_limit.settings.rate_limit, "storage_uri", "memory://")
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_free", "2/minute")
    monkeypatch.setenv("ENABLE_BILLING", "true")
    client = TestClient(
        _build_app_with_limiter(rate_limit._build_limiter(), plan="free", workspace="ws-shadow")
    )

    # Act
    with caplog.at_level("WARNING"):
        codes = [client.get("/r").status_code for _ in range(4)]

    # Assert: never blocked past the 2/min limit...
    assert codes == [200, 200, 200, 200]
    # ...but the over-limit events were observed (proves it counted, not just off).
    assert any("shadow" in r.message.lower() for r in caplog.records)


def test_enforce_mode_blocks_when_shadow_is_off(monkeypatch):
    """Sanity contrast: with shadow off, _build_limiter enforces (3rd request 429)."""
    # Arrange
    monkeypatch.setattr(rate_limit.settings.rate_limit, "shadow", False)
    monkeypatch.setattr(rate_limit.settings.rate_limit, "enabled", True)
    monkeypatch.setattr(rate_limit.settings.rate_limit, "storage_uri", "memory://")
    monkeypatch.setattr(rate_limit.settings.rate_limit, "read_free", "2/minute")
    monkeypatch.setenv("ENABLE_BILLING", "true")
    client = TestClient(
        _build_app_with_limiter(rate_limit._build_limiter(), plan="free", workspace="ws-enforce")
    )

    # Act / Assert
    assert [client.get("/r").status_code for _ in range(3)] == [200, 200, 429]


def test_throttle_record_flags_degraded_storage(caplog):
    """A throttle recorded while the limiter is on in-memory fallback is flagged degraded."""
    # Arrange: a fake request whose limiter reports degraded (Redis-down) storage.
    from types import SimpleNamespace

    limiter = SimpleNamespace(_storage_dead=True)
    request = SimpleNamespace(
        state=SimpleNamespace(rl_bucket="read", rl_workspace_id="ws1", rl_billing_plan="free"),
        app=SimpleNamespace(state=SimpleNamespace(limiter=limiter)),
    )

    # Act
    with caplog.at_level("WARNING"):
        rate_limit._record_exceeded(request, 60)

    # Assert
    assert any("degraded" in r.message.lower() for r in caplog.records)
