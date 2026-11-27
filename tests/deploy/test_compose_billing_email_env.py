"""The prod compose billing service can send the usage emails, as the detector can.

The billing worker sends the free-plan usage notices through the same mail code
as the detector (worker/src/notifications/email.ts), so it reads the same SMTP
URL, sender and app URL. docker-compose.prod.yml passes a container only the
variables it lists, so billing lists those three with the values the detector gets.
"""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _environment(service: str) -> dict:
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    return compose["services"][service]["environment"]


@pytest.mark.parametrize(
    "name", ["TRACEROOT_SMTP_URL", "TRACEROOT_SMTP_MAIL_FROM", "NEXT_PUBLIC_APP_URL"]
)
def test_billing_gets_the_mail_settings_the_detector_gets(name):
    assert _environment("billing").get(name) == _environment("detector")[name]
