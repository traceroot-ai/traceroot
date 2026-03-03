"""Tests for ee/license.py gate functions."""

from ee.license import is_billing_enabled, is_ee_enabled


class TestIsEeEnabled:
    def test_returns_false_when_no_env_var(self, monkeypatch):
        monkeypatch.delenv("TRACEROOT_EE_LICENSE_KEY", raising=False)
        assert is_ee_enabled() is False

    def test_returns_false_when_empty_string(self, monkeypatch):
        monkeypatch.setenv("TRACEROOT_EE_LICENSE_KEY", "")
        assert is_ee_enabled() is False

    def test_returns_true_when_key_set(self, monkeypatch):
        monkeypatch.setenv("TRACEROOT_EE_LICENSE_KEY", "traceroot_ee_test123")
        assert is_ee_enabled() is True


class TestIsBillingEnabled:
    def test_returns_true_when_no_env_var(self, monkeypatch):
        monkeypatch.delenv("ENABLE_BILLING", raising=False)
        assert is_billing_enabled() is True

    def test_returns_true_when_set_to_true(self, monkeypatch):
        monkeypatch.setenv("ENABLE_BILLING", "true")
        assert is_billing_enabled() is True

    def test_returns_false_when_set_to_false(self, monkeypatch):
        monkeypatch.setenv("ENABLE_BILLING", "false")
        assert is_billing_enabled() is False

    def test_returns_false_when_set_to_title_case(self, monkeypatch):
        monkeypatch.setenv("ENABLE_BILLING", "False")
        assert is_billing_enabled() is False

    def test_returns_false_when_set_to_upper_case(self, monkeypatch):
        monkeypatch.setenv("ENABLE_BILLING", "FALSE")
        assert is_billing_enabled() is False
