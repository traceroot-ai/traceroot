"""Unit tests for scripts/import_langsmith."""

import gzip
import json
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from scripts.import_langsmith.__main__ import main
from scripts.import_langsmith.convert import (
    STATUS_ERROR,
    STATUS_OK,
    run_to_span,
    span_id_for,
    trace_id_for,
)
from scripts.import_langsmith.readers import normalize_run, read_jsonl, read_parquet
from scripts.import_langsmith.redact import basic, load_redactor
from scripts.import_langsmith.report import Summary
from scripts.import_langsmith.sender import Sender, batches, build_request

TRACE = "01a1b01a-d5e8-7034-981d-240edf0aec6c"
AGENT = "01a1b01a-d5ee-71fb-9258-8c4e20748ebd"
LLM = "01a1b01a-d608-737d-a28e-0d5dbbd26d4b"
TOOL = "01a1b01a-db78-7130-9a25-a0c6e1947628"


def _run(run_id, run_type, name, parent=None, **fields):
    run = {
        "id": run_id,
        "trace_id": TRACE,
        "parent_run_id": parent,
        "session_id": "00000000-0000-4000-8000-000000000001",
        "name": name,
        "run_type": run_type,
        "start_time": "2026-11-06T09:05:11.145426Z",
        "end_time": "2026-11-06T09:05:12.596620Z",
        "inputs": {"messages": [{"role": "user", "content": "Look up case ABC-123"}]},
        "outputs": {},
        "extra": {"metadata": {"thread_id": "thread-1", "user_id": "user-1"}},
        "error": None,
        "tags": [],
        "feedback_stats": None,
        "prompt_tokens": 0,
        "completion_tokens": 0,
    }
    run.update(fields)
    return run


def sample_runs():
    """A root chain with rolled-up usage, a sub-agent, an LLM call, and a failing tool."""
    return [
        _run(
            TRACE,
            "chain",
            "LangGraph",
            prompt_tokens=3979,
            completion_tokens=55,
            error="ValueError('case ABC-123 not found')Traceback (most recent call last):\n  ...",
            feedback_stats={"user_rating": {"n": 1, "avg": 0.0}},
        ),
        _run(
            AGENT,
            "chain",
            "research-agent",
            parent=TRACE,
            extra={"metadata": {"thread_id": "thread-1", "lc_agent_name": "research-agent"}},
            prompt_tokens=3979,
            completion_tokens=55,
        ),
        _run(
            LLM,
            "llm",
            "ChatAnthropic",
            parent=AGENT,
            outputs={"generations": [[{"text": "Looking it up"}]]},
            extra={
                "invocation_params": {"model": "claude-sonnet-5-5"},
                "metadata": {"thread_id": "thread-1", "ls_provider": "anthropic"},
            },
            prompt_tokens=3979,
            completion_tokens=55,
            total_cost=0.0104955,
            prompt_token_details={
                "cache_read": 10,
                "cache_creation": 0,
                "ephemeral_5m_input_tokens": 3975,
                "ephemeral_1h_input_tokens": 0,
            },
        ),
        _run(
            TOOL,
            "tool",
            "lookup_case",
            parent=AGENT,
            inputs={"case_id": "ABC-123"},
            outputs={"output": "not found"},
        ),
    ]


def spans_by_name(**kwargs):
    return {s.name: s for s in (run_to_span(normalize_run(r), **kwargs) for r in sample_runs())}


class TestConvert:
    def test_tokens_only_on_llm_spans(self):
        spans = spans_by_name()
        assert spans["ChatAnthropic"].attributes["llm.token_count.prompt"] == 3979
        assert spans["ChatAnthropic"].attributes["llm.token_count.completion"] == 55
        for name in ("LangGraph", "research-agent", "lookup_case"):
            assert not any(k.startswith("llm.token_count") for k in spans[name].attributes)

    def test_ids_are_deterministic_and_linked(self):
        spans = spans_by_name()
        assert spans["LangGraph"].trace_id.hex() == uuid.UUID(TRACE).hex
        assert spans["LangGraph"].parent_span_id is None
        assert spans["ChatAnthropic"].span_id == span_id_for(LLM)
        assert spans["ChatAnthropic"].parent_span_id == spans["research-agent"].span_id
        assert spans_by_name()["ChatAnthropic"].span_id == spans["ChatAnthropic"].span_id
        assert len(span_id_for(LLM)) == 8 and len(trace_id_for(TRACE)) == 16

    def test_span_kinds(self):
        spans = spans_by_name()
        kinds = {n: s.attributes["openinference.span.kind"] for n, s in spans.items()}
        assert kinds == {
            "LangGraph": "CHAIN",
            "research-agent": "AGENT",
            "ChatAnthropic": "LLM",
            "lookup_case": "TOOL",
        }

    def test_llm_model_provider_and_cache_tokens(self):
        attrs = spans_by_name()["ChatAnthropic"].attributes
        assert attrs["llm.model_name"] == "claude-sonnet-5-5"
        assert attrs["llm.provider"] == "anthropic"
        assert attrs["llm.token_count.prompt_details.cache_read"] == 10
        assert attrs["llm.token_count.prompt_details.cache_write"] == 3975
        assert "llm.token_count.prompt_details.cache_write_1h" not in attrs
        assert "llm.cost.total" not in attrs

    def test_langsmith_cost_is_opt_in(self):
        attrs = spans_by_name(use_langsmith_cost=True)["ChatAnthropic"].attributes
        assert attrs["llm.cost.total"] == pytest.approx(0.0104955)

    def test_tool_output_is_unwrapped(self):
        attrs = spans_by_name()["lookup_case"].attributes
        assert attrs["input.value"] == '{"case_id": "ABC-123"}'
        assert attrs["output.value"] == "not found"

    def test_error_status_and_metadata(self):
        root = spans_by_name()["LangGraph"]
        assert root.status_code == STATUS_ERROR
        assert root.status_message == "ValueError('case ABC-123 not found')"
        assert "Traceback" in json.loads(root.attributes["traceroot.span.metadata"])["error"]
        assert spans_by_name()["ChatAnthropic"].status_code == STATUS_OK

    def test_session_user_and_trace_metadata(self):
        spans = spans_by_name()
        root = spans["LangGraph"].attributes
        assert root["session.id"] == "thread-1"
        assert root["user.id"] == "user-1"
        trace_metadata = json.loads(root["traceroot.trace.metadata"])
        assert trace_metadata["import.source"] == "langsmith"
        assert trace_metadata["langsmith.feedback"]["user_rating"]["n"] == 1
        assert "traceroot.trace.metadata" not in spans["ChatAnthropic"].attributes
        span_metadata = json.loads(spans["ChatAnthropic"].attributes["traceroot.span.metadata"])
        assert span_metadata["langsmith.run_id"] == LLM

    def test_missing_end_time_is_unset_and_zero_length(self):
        run = normalize_run(_run(LLM, "llm", "pending", parent=TRACE, end_time=None))
        span = run_to_span(run)
        assert span.end_ns == span.start_ns
        assert span.status_code == 0


class TestReaders:
    def test_normalize_decodes_parquet_style_strings(self):
        raw = _run(TRACE, "chain", "root")
        raw["inputs"] = json.dumps(raw["inputs"])
        raw["extra"] = json.dumps(raw["extra"])
        raw["id"] = uuid.UUID(TRACE).bytes
        raw["start_time"] = datetime(2026, 11, 6, 9, 5, 11)
        run = normalize_run(raw)
        assert run["id"] == TRACE
        assert run["inputs"]["messages"][0]["role"] == "user"
        assert run["extra"]["metadata"]["thread_id"] == "thread-1"
        assert run["start_time"].tzinfo is UTC

    def test_jsonl_round_trip(self, tmp_path):
        path = tmp_path / "runs.jsonl"
        path.write_text("\n".join(json.dumps(r) for r in sample_runs()) + "\n")
        assert [r["name"] for r in read_jsonl(path)] == [
            "LangGraph",
            "research-agent",
            "ChatAnthropic",
            "lookup_case",
        ]

    def test_parquet_directory_with_hive_layout(self, tmp_path):
        pa = pytest.importorskip("pyarrow")
        pq = pytest.importorskip("pyarrow.parquet")
        rows = []
        for run in sample_runs():
            row = dict(run)
            for key in ("inputs", "outputs", "extra", "feedback_stats", "prompt_token_details"):
                row[key] = json.dumps(row.get(key))
            row["tags"] = json.dumps(row["tags"])
            row.pop("total_cost", None)
            rows.append(row)
        folder = tmp_path / "export_id=x" / "runs" / "year=2026" / "month=11" / "day=06"
        folder.mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist(rows), folder / "part-0.parquet")
        runs = list(read_parquet(tmp_path))
        assert len(runs) == 4
        llm = next(r for r in runs if r["run_type"] == "llm")
        assert llm["prompt_token_details"]["ephemeral_5m_input_tokens"] == 3975


class TestRedact:
    def test_basic_blanks_pii(self):
        cleaned = basic(
            {"input.value": "mail jane@example.com, call 415-555-0100, ssn 123-45-6789", "n": 3}
        )
        assert cleaned["input.value"] == "mail [REDACTED], call [REDACTED], ssn [REDACTED]"
        assert cleaned["n"] == 3

    def test_load_from_file(self, tmp_path):
        hook = tmp_path / "hook.py"
        hook.write_text("def scrub(a):\n    return {k: 'x' for k in a}\n")
        assert load_redactor(f"{hook}:scrub")({"a": "secret"}) == {"a": "x"}
        assert load_redactor("basic") is basic
        with pytest.raises(SystemExit):
            load_redactor("nocolon")


class TestSender:
    def test_build_request_carries_spans(self):
        spans = list(spans_by_name().values())
        request = build_request(spans, {"service.name": "langsmith-import"})
        out = request.resource_spans[0].scope_spans[0].spans
        assert len(out) == 4
        root = next(s for s in out if s.name == "LangGraph")
        assert root.trace_id == trace_id_for(TRACE)
        assert root.parent_span_id == b""
        assert root.status.code == 2

    def test_batches_split_by_count(self):
        spans = list(spans_by_name().values())
        assert [len(b) for b in batches(spans, max_spans=3, max_bytes=10**9)] == [3, 1]

    def test_send_retries_then_succeeds(self, monkeypatch):
        monkeypatch.setattr("time.sleep", lambda _: None)
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(429, headers={"retry-after": "1"})
            return httpx.Response(200, json={"status": "ok", "file_key": "k"})

        client = httpx.Client(transport=httpx.MockTransport(handler))
        sender = Sender("https://tr.example/", "key", min_interval=0, client=client)
        sender.send(build_request(list(spans_by_name().values()), {}))
        assert len(calls) == 2
        assert str(calls[1].url) == "https://tr.example/api/v1/public/traces"
        assert calls[1].headers["authorization"] == "Bearer key"
        decoded = ExportTraceServiceRequest()
        decoded.ParseFromString(gzip.decompress(calls[1].content))
        assert len(decoded.resource_spans[0].scope_spans[0].spans) == 4

    def test_send_raises_on_client_error(self):
        client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401)))
        sender = Sender("https://tr.example", "bad", min_interval=0, client=client)
        with pytest.raises(RuntimeError, match="401"):
            sender.send(build_request([], {}))


def test_summary_counts_llm_tokens_once():
    summary = Summary(show_trees=1)
    for span in spans_by_name().values():
        summary.add(span)
    totals = summary.per_trace[uuid.UUID(TRACE).hex]
    assert (totals.spans, totals.input_tokens, totals.output_tokens) == (4, 3979, 55)
    assert "ChatAnthropic [LLM]  3979 in / 55 out" in summary.render()


def test_cli_dry_run(tmp_path, capsys):
    path = tmp_path / "runs.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in sample_runs()))
    assert main(["--jsonl", str(path), "--dry-run", "--redact", "basic"]) == 0
    out = capsys.readouterr().out
    assert "Runs read: 4   Traces: 1   Errored runs: 1" in out
    assert "Dry run: nothing was sent." in out
