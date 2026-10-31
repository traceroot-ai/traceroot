"""Tests for the settings that turn image extraction on, for every project or listed ones."""

import copy
import hashlib
from unittest.mock import MagicMock, call

import pytest
from pydantic import ValidationError

from shared.attachments import attachment_key, find_attachment_refs
from shared.config import AttachmentSettings, settings
from tests.fixtures.images import data_url, make_png
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.attachment_extraction import TRUNCATION_MARKER
from worker.ingest_tasks import process_s3_traces
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_HEX = "aa" * 16
SPAN_HEX = "bb" * 8
S3_KEY = "events/otel/key.json"
IMAGE = make_png(2, 2)
SPAN_LIMIT = 200

ATTACHMENT_ENV = (
    "ATTACHMENT_ENABLED",
    "ATTACHMENT_PROJECT_IDS",
    "ATTACHMENT_MAX_IMAGE_BYTES",
    "ATTACHMENT_MAX_IMAGE_DIMENSION",
    "ATTACHMENT_MAX_SPAN_BYTES",
)


@pytest.fixture()
def attachment_env(monkeypatch):
    """Load the given ATTACHMENT_* env vars, and only those, into the settings the worker reads."""

    def configure(**env: str) -> AttachmentSettings:
        for name in ATTACHMENT_ENV:
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        config = AttachmentSettings()
        monkeypatch.setattr(settings, "attachments", config)
        return config

    return configure


class TestAppliesTo:
    def test_off_by_default(self, attachment_env):
        config = attachment_env()

        assert config.enabled is False
        assert config.project_ids == ""
        assert not config.applies_to("proj-1")

    def test_a_project_list_alone_does_not_turn_it_on(self, attachment_env):
        config = attachment_env(ATTACHMENT_PROJECT_IDS="proj-1")

        assert not config.applies_to("proj-1")

    def test_false_keeps_it_off(self, attachment_env):
        config = attachment_env(ATTACHMENT_ENABLED="false")

        assert not config.applies_to("proj-1")

    @pytest.mark.parametrize("value", ["true", "1"])
    def test_enabled_without_a_list_applies_to_every_project(self, attachment_env, value):
        config = attachment_env(ATTACHMENT_ENABLED=value)

        assert config.enabled is True
        assert all(config.applies_to(p) for p in ("proj-1", "proj-2", "another-project"))

    @pytest.mark.parametrize("ids", ["", " ", ",", " , ,"])
    def test_an_empty_list_applies_to_every_project(self, attachment_env, ids):
        config = attachment_env(ATTACHMENT_ENABLED="true", ATTACHMENT_PROJECT_IDS=ids)

        assert config.applies_to("proj-1")
        assert config.applies_to("proj-2")

    def test_enabled_with_a_list_applies_only_to_listed_projects(self, attachment_env):
        config = attachment_env(ATTACHMENT_ENABLED="true", ATTACHMENT_PROJECT_IDS="proj-1,proj-3")

        assert config.applies_to("proj-1")
        assert config.applies_to("proj-3")
        assert not config.applies_to("proj-2")
        assert not config.applies_to("proj")
        assert not config.applies_to("PROJ-1")

    @pytest.mark.parametrize(
        "ids", [" proj-1 , proj-3 ", "proj-1,,proj-3,", ",proj-1, ,\tproj-3\n", "proj-1, proj-3,,"]
    )
    def test_whitespace_and_empty_entries_are_ignored(self, attachment_env, ids):
        config = attachment_env(ATTACHMENT_ENABLED="true", ATTACHMENT_PROJECT_IDS=ids)

        assert config.applies_to("proj-1")
        assert config.applies_to("proj-3")
        assert not config.applies_to("proj-2")
        assert not config.applies_to("")

    def test_rejects_a_value_that_is_not_a_bool(self, monkeypatch):
        monkeypatch.setenv("ATTACHMENT_ENABLED", "sometimes")

        with pytest.raises(ValidationError):
            AttachmentSettings()


@pytest.fixture()
def mock_s3(monkeypatch):
    """Mock S3 service: serves the batch, and has no attachment stored yet."""
    mock = MagicMock()
    mock.object_exists.return_value = False
    mock.put_object_if_absent.return_value = True
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    return mock


@pytest.fixture()
def mock_ch(monkeypatch):
    """Mock ClickHouse client."""
    mock = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture(autouse=True)
def mock_detector_enqueue(monkeypatch):
    """Mock the detector enqueue so tests never touch Postgres/Redis/BullMQ."""
    mock = MagicMock()
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", mock)
    return mock


@pytest.fixture()
def published(monkeypatch):
    """Spans the task published to the live view, one list per call."""
    sent: list[list[dict]] = []
    monkeypatch.setattr(
        "worker.ingest_tasks._publish_live_spans",
        lambda spans, project_id: sent.append(copy.deepcopy(spans)),
    )
    return sent


@pytest.fixture()
def extract_spy(monkeypatch):
    """Wraps extract_attachments, so a test can see whether the task called it."""
    import worker.attachment_extraction as extraction

    spy = MagicMock(wraps=extraction.extract_attachments)
    monkeypatch.setattr(extraction, "extract_attachments", spy)
    return spy


def make_payload() -> dict:
    """One span with an image in its input and an output that is over ``SPAN_LIMIT``."""
    return make_otel_payload(
        [
            make_span(
                TRACE_HEX,
                SPAN_HEX,
                name="screenshot",
                attributes=[
                    make_attr(
                        "traceroot.span.input", f'{{"shot": "{data_url(IMAGE, "image/png")}"}}'
                    ),
                    make_attr("traceroot.span.output", "o" * 1000),
                ],
            )
        ]
    )


def run_task(mock_s3: MagicMock, project_id: str) -> dict:
    mock_s3.download_json.return_value = make_payload()
    return process_s3_traces(s3_key=S3_KEY, project_id=project_id)


class TestProcessS3TracesSwitch:
    def assert_stored_as_transformed(self, project_id, mock_s3, mock_ch, published, extract_spy):
        """The batch went through exactly as it does with no extraction step at all."""
        expected_traces, expected_spans = transform_otel_to_clickhouse(make_payload(), project_id)

        extract_spy.assert_not_called()
        assert mock_s3.method_calls == [call.download_json(S3_KEY)]
        assert mock_ch.insert_spans_batch.call_args.args[0] == expected_spans
        assert mock_ch.insert_traces_batch.call_args.args[0] == expected_traces
        assert published == [expected_spans]
        assert data_url(IMAGE, "image/png") in expected_spans[0]["input"]

    def assert_extracted(self, project_id, mock_s3, mock_ch, published, extract_spy):
        digest = hashlib.sha256(IMAGE).hexdigest()

        extract_spy.assert_called_once()
        assert extract_spy.call_args.args[:2] == (mock_s3, project_id)
        mock_s3.put_object_if_absent.assert_called_once_with(
            attachment_key(project_id, digest), IMAGE, "image/png"
        )
        (span_row,) = mock_ch.insert_spans_batch.call_args.args[0]
        assert find_attachment_refs(span_row["input"]) == {digest}
        assert span_row["output"].endswith(TRUNCATION_MARKER.format(limit=SPAN_LIMIT))
        assert published == [[span_row]]

    def test_disabled_by_default_the_batch_is_stored_as_sent(
        self, attachment_env, mock_s3, mock_ch, published, extract_spy
    ):
        attachment_env(ATTACHMENT_MAX_SPAN_BYTES=str(SPAN_LIMIT))

        result = run_task(mock_s3, "proj-1")

        assert result["spans"] == 1
        self.assert_stored_as_transformed("proj-1", mock_s3, mock_ch, published, extract_spy)

    def test_a_project_list_alone_does_not_enable_extraction(
        self, attachment_env, mock_s3, mock_ch, published, extract_spy
    ):
        attachment_env(ATTACHMENT_PROJECT_IDS="proj-1", ATTACHMENT_MAX_SPAN_BYTES=str(SPAN_LIMIT))

        run_task(mock_s3, "proj-1")

        self.assert_stored_as_transformed("proj-1", mock_s3, mock_ch, published, extract_spy)

    @pytest.mark.parametrize(
        ("project_ids", "project_id", "extracted"),
        [
            pytest.param(None, "proj-1", True, id="no-list-proj-1"),
            pytest.param(None, "proj-2", True, id="no-list-proj-2"),
            pytest.param("", "proj-2", True, id="empty-list"),
            pytest.param("proj-1,proj-3", "proj-1", True, id="listed-first"),
            pytest.param("proj-1,proj-3", "proj-3", True, id="listed-last"),
            pytest.param("proj-1,proj-3", "proj-2", False, id="not-listed"),
            pytest.param(" proj-1 ,, ", "proj-1", True, id="padded-listed"),
            pytest.param(" proj-1 ,, ", "proj-2", False, id="padded-not-listed"),
        ],
    )
    def test_enabled_extraction_follows_the_project_list(
        self,
        attachment_env,
        mock_s3,
        mock_ch,
        published,
        extract_spy,
        project_ids,
        project_id,
        extracted,
    ):
        env = {"ATTACHMENT_ENABLED": "true", "ATTACHMENT_MAX_SPAN_BYTES": str(SPAN_LIMIT)}
        if project_ids is not None:
            env["ATTACHMENT_PROJECT_IDS"] = project_ids
        attachment_env(**env)

        run_task(mock_s3, project_id)

        check = self.assert_extracted if extracted else self.assert_stored_as_transformed
        check(project_id, mock_s3, mock_ch, published, extract_spy)
