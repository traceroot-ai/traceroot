"""Deploy-artifact guard: the worker receives every attachment setting.

The worker reads ``AttachmentSettings`` from its environment, and the prod compose
file passes only the variables it lists. A setting left out there keeps its
default whatever ``.env`` says, so each one must be listed, with the same default
as the settings class, and documented in ``.env.example``.
"""

import os

import yaml

from shared.config import AttachmentSettings

_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")


def _compose_default(value: object) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def _attachment_env_vars() -> dict[str, str]:
    """Each ATTACHMENT_* variable name, mapped to its default as compose writes it."""
    return {
        f"ATTACHMENT_{name.upper()}": _compose_default(field.default)
        for name, field in AttachmentSettings.model_fields.items()
    }


def test_prod_worker_receives_every_attachment_setting_with_its_default():
    with open(os.path.join(_ROOT, "docker-compose.prod.yml")) as f:
        environment = yaml.safe_load(f)["services"]["worker"]["environment"]

    for var, default in _attachment_env_vars().items():
        assert environment.get(var) == f"${{{var}:-{default}}}", var


def test_env_example_documents_every_attachment_setting():
    with open(os.path.join(_ROOT, ".env.example")) as f:
        lines = f.read().splitlines()

    for var, default in _attachment_env_vars().items():
        assert f"# {var}={default}" in lines, var
