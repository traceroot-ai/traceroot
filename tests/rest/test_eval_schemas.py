"""The offline-evaluation Pydantic mirror keeps parity with the Zod contract.

Covers the properties that the SDK and both validation layers depend on and that
a one-token schema edit silently regresses: `scores` presence, the payload caps,
and forward-compatible degradation of the display-only scorer vocabularies. The
Zod side asserts the same properties in
``frontend/packages/core/src/__tests__/eval-contract.test.ts``.
"""

import pytest
from pydantic import ValidationError

from backend.rest.schemas.eval import (
    EVAL_METADATA_MAX,
    EVAL_PAYLOAD_TEXT_MAX,
    EVAL_SCORER_LIST_MAX,
    SCORER_MESSAGE_CONTENT_MAX,
    SCORER_MESSAGES_MAX,
    SCORER_SOURCE_MAX,
    RegisterRunRequest,
    ScorerRef,
    UpsertResultRequest,
)


def _result(**over):
    return {"test_case_id": "tc1", "input": "in", "status": "passed", **over}


def _run(**over):
    return {
        "evaluation_name": "e",
        "dataset_id": "d",
        "candidate_version": "v1",
        **over,
    }


class TestUpsertResultScores:
    def test_omitted_scores_stays_none(self):
        """Absent must stay distinguishable from `[]` so a re-upsert that only
        attaches a trace_id does not wipe the result's scores."""
        parsed = UpsertResultRequest(**_result(trace_id="t1"))
        assert parsed.scores is None
        assert "scores" not in parsed.model_dump(exclude_unset=True)

    def test_explicit_empty_list_is_preserved(self):
        assert UpsertResultRequest(**_result(scores=[])).scores == []

    def test_rejects_more_scores_than_the_cap(self):
        score = {"scorer_name": "s", "scorer_version": "1"}
        under = [score] * EVAL_SCORER_LIST_MAX
        assert len(UpsertResultRequest(**_result(scores=under)).scores) == EVAL_SCORER_LIST_MAX
        with pytest.raises(ValidationError):
            UpsertResultRequest(**_result(scores=[*under, score]))


@pytest.mark.parametrize(
    "field", ["input", "expected_output", "candidate_output", "baseline_output"]
)
def test_text_payload_fields_are_capped(field):
    at_cap = "a" * EVAL_PAYLOAD_TEXT_MAX
    UpsertResultRequest(**_result(**{field: at_cap}))
    with pytest.raises(ValidationError):
        UpsertResultRequest(**_result(**{field: at_cap + "a"}))


class TestRegisterRunCaps:
    def test_rejects_more_scorers_than_the_cap(self):
        scorer = {"name": "s", "version": "1"}
        under = [scorer] * EVAL_SCORER_LIST_MAX
        assert len(RegisterRunRequest(**_run(scorers=under)).scorers) == EVAL_SCORER_LIST_MAX
        with pytest.raises(ValidationError):
            RegisterRunRequest(**_run(scorers=[*under, scorer]))

    def test_rejects_oversized_metadata(self):
        RegisterRunRequest(**_run(metadata={"blob": "b"}))
        with pytest.raises(ValidationError):
            RegisterRunRequest(**_run(metadata={"blob": "b" * EVAL_METADATA_MAX}))


class TestScorerRefForwardCompatibility:
    @pytest.mark.parametrize("field", ["scorer_type", "output_type", "language"])
    def test_unknown_display_only_value_degrades_to_none(self, field):
        """A newer SDK's variant must not 400 the run registration, which would
        lose every result and score the SDK goes on to report."""
        ref = ScorerRef(name="s", version="1", **{field: "from-a-newer-sdk"})
        assert getattr(ref, field) is None

    def test_known_values_still_round_trip(self):
        ref = ScorerRef(
            name="s",
            version="1",
            scorer_type="llm_judge",
            output_type="score",
            language="python",
        )
        assert (ref.scorer_type, ref.output_type, ref.language) == ("llm_judge", "score", "python")

    @pytest.mark.parametrize(
        ("model", "payload"),
        [
            (ScorerRef, {"name": "s", "version": "1", "value_type": "vector"}),
            (ScorerRef, {"name": "s", "version": "1", "direction": "sideways"}),
            (UpsertResultRequest, _result(status="skipped")),
            (UpsertResultRequest, _result(change="sideways")),
        ],
    )
    def test_persistence_vocabularies_still_reject(self, model, payload):
        with pytest.raises(ValidationError):
            model(**payload)

    def test_source_messages_and_content_are_capped(self):
        with pytest.raises(ValidationError):
            ScorerRef(name="s", version="1", source="s" * (SCORER_SOURCE_MAX + 1))
        with pytest.raises(ValidationError):
            ScorerRef(
                name="s",
                version="1",
                messages=[{"role": "user", "content": "c" * (SCORER_MESSAGE_CONTENT_MAX + 1)}],
            )
        with pytest.raises(ValidationError):
            ScorerRef(
                name="s",
                version="1",
                messages=[{"role": "user", "content": "c"}] * (SCORER_MESSAGES_MAX + 1),
            )
