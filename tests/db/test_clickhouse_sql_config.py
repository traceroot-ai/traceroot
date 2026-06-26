"""Tests for the SQL gateway additions to ClickHouseSettings (Issue 4)."""

from shared.config import ClickHouseSettings


class TestSqlGatewaySettings:
    def test_ro_user_password_optional_default_none(self, monkeypatch):
        monkeypatch.delenv("CLICKHOUSE_RO_USER", raising=False)
        monkeypatch.delenv("CLICKHOUSE_RO_PASSWORD", raising=False)
        s = ClickHouseSettings()
        assert s.ro_user is None
        assert s.ro_password is None

    def test_sql_cap_defaults_mirror_operational_profile(self, monkeypatch):
        for var in (
            "CLICKHOUSE_SQL_MAX_EXECUTION_TIME",
            "CLICKHOUSE_SQL_MAX_RESULT_ROWS",
            "CLICKHOUSE_SQL_MAX_RESULT_BYTES",
            "CLICKHOUSE_SQL_MAX_MEMORY_USAGE",
        ):
            monkeypatch.delenv(var, raising=False)
        s = ClickHouseSettings()
        assert s.sql_max_execution_time == 30
        assert s.sql_max_result_rows == 100_000
        assert s.sql_max_result_bytes == 536_870_912
        assert s.sql_max_memory_usage == 4_294_967_296

    def test_ro_user_read_from_env(self, monkeypatch):
        monkeypatch.setenv("CLICKHOUSE_RO_USER", "sql_gateway_ro")
        monkeypatch.setenv("CLICKHOUSE_RO_PASSWORD", "secret")
        s = ClickHouseSettings()
        assert s.ro_user == "sql_gateway_ro"
        assert s.ro_password == "secret"
