"""Tests for the synthetic topic corpus generator."""

from collections import Counter

import pytest

from scripts.topic_corpus.generate import CorpusParams, build_corpus
from scripts.topic_corpus.otlp import build_request


def test_the_same_seed_gives_an_identical_manifest():
    assert (
        build_corpus(CorpusParams(seed=3)).manifest_json()
        == build_corpus(CorpusParams(seed=3)).manifest_json()
    )


def test_different_seeds_give_different_corpora():
    a = build_corpus(CorpusParams(seed=3)).manifest()
    b = build_corpus(CorpusParams(seed=4)).manifest()
    assert [t["trace_id"] for t in a["traces"]] != [t["trace_id"] for t in b["traces"]]


def test_planted_topics_have_counts_inside_the_requested_range():
    corpus = build_corpus(CorpusParams(seed=5, min_per_topic=40, max_per_topic=80))
    counts = Counter(t.label for t in corpus.traces)
    for topic in corpus.topics:
        assert 40 <= counts[topic.id] <= 80
    assert corpus.manifest()["noise_count"] == counts["noise"] > 0


def test_trace_ids_are_unique_and_valid_otlp_ids():
    corpus = build_corpus(CorpusParams(seed=5))
    ids = [t.trace_id for t in corpus.traces]
    assert len(set(ids)) == len(ids)
    assert all(len(i) == 32 and int(i, 16) >= 0 for i in ids)
    span_ids = [s.span_id for t in corpus.traces for s in t.spans]
    assert len(set(span_ids)) == len(span_ids)


def test_every_trace_has_a_root_agent_span_and_children_point_at_it():
    corpus = build_corpus(CorpusParams(seed=5))
    for t in corpus.traces:
        root = t.spans[0]
        assert root.parent_id is None and root.kind == "AGENT"
        assert all(s.parent_id == root.span_id for s in t.spans[1:])


def test_traces_start_before_the_send_time():
    corpus = build_corpus(CorpusParams(seed=5, days=3))
    assert all(15 * 60 <= t.offset_seconds <= 3 * 86_400 for t in corpus.traces)


def test_injections_are_marked_and_carry_the_canary():
    corpus = build_corpus(CorpusParams(seed=5, injections=4))
    marked = [t for t in corpus.traces if t.injection]
    assert len(marked) == 4
    for t in marked:
        text = " ".join(s.input + s.output for s in t.spans)
        assert "CANARY-0005" in text
    assert all(
        "CANARY" not in " ".join(s.input for s in t.spans) for t in corpus.traces if not t.injection
    )


def test_the_project_marker_is_in_every_system_prompt():
    corpus = build_corpus(CorpusParams(seed=5, marker="Quillmark"))
    assert all("Quillmark" in t.spans[1].input for t in corpus.traces)


def test_parameters_are_validated():
    with pytest.raises(ValueError):
        build_corpus(CorpusParams(topics=99))
    with pytest.raises(ValueError):
        build_corpus(CorpusParams(min_per_topic=90, max_per_topic=10))


def test_the_otlp_request_has_one_span_per_spec_and_the_traces_ids():
    corpus = build_corpus(CorpusParams(seed=5, topics=1, min_per_topic=3, max_per_topic=3))
    request = build_request(corpus.traces[:2], now_ns=2_000_000_000_000_000_000)
    spans = request.resource_spans[0].scope_spans[0].spans
    assert len(spans) == sum(len(t.spans) for t in corpus.traces[:2])
    assert {s.trace_id.hex() for s in spans} == {t.trace_id for t in corpus.traces[:2]}


def test_a_request_injection_is_labelled_noise_because_it_shows_no_task():
    corpus = build_corpus(CorpusParams(seed=5, injections=4))
    for t in corpus.traces:
        if t.injection == "request":
            assert t.label == "noise"
