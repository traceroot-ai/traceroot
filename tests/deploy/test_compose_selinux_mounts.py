"""Files mounted from the checkout are readable on hosts with SELinux enforcing.

Fedora and RHEL run SELinux in enforcing mode, where a container may only read
a host file that carries a container label. A bind mount gets that label when
its options include ``z``. Without it ClickHouse cannot read its mounted
``users.d`` file and restarts forever, so the stack never comes up.
"""

from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_COMPOSE = [_ROOT / "docker-compose.yml", _ROOT / "docker-compose.prod.yml"]


def _checkout_mounts(compose_path: Path) -> list[tuple[str, str]]:
    """Every (service, volume) whose source is a path inside the checkout.

    Named volumes (``postgres_data:/...``) are labelled by Docker itself, and
    absolute host paths such as the Docker socket must not be relabelled, so
    only sources starting with ``./`` are returned.
    """
    services = yaml.safe_load(compose_path.read_text())["services"]
    return [
        (service, volume)
        for service, spec in services.items()
        for volume in spec.get("volumes", [])
        if volume.startswith("./")
    ]


def _options(volume: str) -> list[str]:
    """The mount options of a ``source:target[:options]`` volume."""
    parts = volume.split(":")
    return parts[2].split(",") if len(parts) > 2 else []


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_checkout_mounts_carry_the_selinux_label_option(compose_path):
    mounts = _checkout_mounts(compose_path)
    assert mounts, f"expected {compose_path.name} to mount files from the checkout"

    unlabelled = [
        f"{service}: {volume}" for service, volume in mounts if "z" not in _options(volume)
    ]
    assert not unlabelled, f"{compose_path.name} mounts without the z option: {unlabelled}"
