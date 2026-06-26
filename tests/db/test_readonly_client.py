"""Tests for the read-only ClickHouse client + settings forwarding (Issue 4)."""

import logging
from unittest.mock import MagicMock

import pytest

import db.clickhouse.client as ch_client_mod
from db.clickhouse.client import ClickHouseClient


class TestQueryForwarding:
    def test_query_forwards_parameters_and_settings(self):
        internal = MagicMock()
        client = ClickHouseClient(internal)
        client.query("SELECT 1", parameters={"p": "x"}, settings={"max_execution_time": 5})
        internal.query.assert_called_once_with(
            "SELECT 1", parameters={"p": "x"}, settings={"max_execution_time": 5}
        )

    def test_query_defaults_pass_none(self):
        internal = MagicMock()
        client = ClickHouseClient(internal)
        client.query("SELECT 1")
        internal.query.assert_called_once_with("SELECT 1", parameters=None, settings=None)


@pytest.fixture(autouse=True)
def _reset_singletons(monkeypatch):
    monkeypatch.setattr(ch_client_mod, "_client", None)
    monkeypatch.setattr(ch_client_mod, "_ro_client", None)


class TestReadonlyClient:
    def test_uses_ro_credentials_when_configured(self, monkeypatch):
        ch = ch_client_mod.settings.clickhouse
        monkeypatch.setattr(ch, "ro_user", "sql_gateway_ro", raising=False)
        monkeypatch.setattr(ch, "ro_password", "ro_pass", raising=False)

        captured: dict = {}

        def fake_get_client(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        monkeypatch.setattr(ch_client_mod.clickhouse_connect, "get_client", fake_get_client)

        client = ch_client_mod.get_readonly_clickhouse_client()
        assert isinstance(client, ClickHouseClient)
        assert captured["username"] == "sql_gateway_ro"
        assert captured["password"] == "ro_pass"
        # the RO client must not auto-generate a sticky session (shared pooled reads)
        assert captured["autogenerate_session_id"] is False

    def test_fatal_in_cloud_when_ro_user_missing(self, monkeypatch):
        ch = ch_client_mod.settings.clickhouse
        monkeypatch.setattr(ch, "ro_user", None, raising=False)
        # cloud mode = billing enabled (ENABLE_BILLING not "false")
        monkeypatch.delenv("ENABLE_BILLING", raising=False)
        with pytest.raises(RuntimeError, match="CLICKHOUSE_RO_USER"):
            ch_client_mod.get_readonly_clickhouse_client()

    def test_fallback_to_default_with_warning_in_self_host(self, monkeypatch, caplog):
        ch = ch_client_mod.settings.clickhouse
        monkeypatch.setattr(ch, "ro_user", None, raising=False)
        monkeypatch.setenv("ENABLE_BILLING", "false")  # self-host

        sentinel = MagicMock(name="default-client")
        monkeypatch.setattr(ch_client_mod, "get_clickhouse_client", lambda: sentinel)

        with caplog.at_level(logging.WARNING):
            client = ch_client_mod.get_readonly_clickhouse_client()

        assert client is sentinel
        assert any(
            "CLICKHOUSE_RO_USER" in r.message and r.levelno == logging.WARNING
            for r in caplog.records
        ), "self-host fallback must log a loud warning mentioning CLICKHOUSE_RO_USER"
