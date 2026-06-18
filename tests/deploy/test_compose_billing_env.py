"""Deploy-artifact guard: billing-aware services must receive ENABLE_BILLING.

``rest`` is the only process that builds the REST rate limiter, and
``is_billing_enabled()`` treats an absent ``ENABLE_BILLING`` as enabled. If the
var is dropped from the ``rest`` service in prod compose (it has been added and
removed before), a self-host deployment that sets ``ENABLE_BILLING=false``
silently keeps the limiter on and gets throttled at the free tier. The unit
suite never inspects deploy artifacts, so this guard fails fast if that plumbing
regresses again.
"""

import os

import yaml

_COMPOSE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "docker-compose.prod.yml"
)


def _service_environment(service: str) -> dict:
    """Return a service's environment as a dict (compose allows map or list form)."""
    with open(_COMPOSE_PATH) as f:
        compose = yaml.safe_load(f)
    env = compose["services"][service]["environment"]
    if isinstance(env, list):
        return dict(item.split("=", 1) for item in env)
    return env


def test_rest_service_receives_enable_billing():
    """rest must pass ENABLE_BILLING into its container (it builds the limiter)."""
    assert "ENABLE_BILLING" in _service_environment("rest")


def test_all_billing_aware_services_receive_enable_billing():
    """Every service that reads billing state gets the var, so none drifts out."""
    for service in ("rest", "web", "billing"):
        assert "ENABLE_BILLING" in _service_environment(service), (
            f"{service} is missing ENABLE_BILLING in docker-compose.prod.yml"
        )
