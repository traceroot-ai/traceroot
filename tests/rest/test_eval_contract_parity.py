"""Cross-layer drift guard (Pydantic side).

The public eval reporting contract is defined twice: the Zod schemas in
``frontend/packages/core/src/eval-contract.ts`` (the Next.js control plane) and
the Pydantic models in ``rest.schemas.eval`` (the FastAPI gateway). If they
disagree on which payloads are valid, the gateway could accept a request the
control plane rejects (or vice-versa).

This test and ``eval-contract-parity.drift.test.ts`` load the SAME fixture file
and assert the SAME accept/reject verdicts on every representative payload — so a
one-sided schema edit turns one language's suite red.
"""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from rest.schemas.eval import CompleteRunRequest, RegisterRunRequest, UpsertResultRequest

FIXTURES = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "packages"
    / "core"
    / "src"
    / "__tests__"
    / "eval-contract-parity-fixtures.json"
)

MODELS: dict[str, type[BaseModel]] = {
    "register": RegisterRunRequest,
    "upsert_result": UpsertResultRequest,
    "complete": CompleteRunRequest,
}


def _fixtures() -> dict:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def _cases(kind: str) -> list[tuple[str, type[BaseModel], dict]]:
    data = _fixtures()
    out: list[tuple[str, type[BaseModel], dict]] = []
    for group, model in MODELS.items():
        for case in data[group][kind]:
            out.append((f"{group}/{case['name']}", model, case["payload"]))
    return out


_VALID = _cases("valid")
_INVALID = _cases("invalid")


def test_fixture_file_is_the_shared_source():
    # The Zod drift test loads this exact file; guard against a rename/move.
    assert FIXTURES.exists(), FIXTURES
    data = _fixtures()
    assert set(data) >= set(MODELS)


@pytest.mark.parametrize("label,model,payload", _VALID, ids=[c[0] for c in _VALID])
def test_pydantic_accepts_valid(label: str, model: type[BaseModel], payload: dict):
    # Must not raise; mirrors Zod safeParse().success === true for the same payload.
    model.model_validate(payload)


@pytest.mark.parametrize("label,model,payload", _INVALID, ids=[c[0] for c in _INVALID])
def test_pydantic_rejects_invalid(label: str, model: type[BaseModel], payload: dict):
    # Must raise; mirrors Zod safeParse().success === false for the same payload.
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_non_strict_scorer_ignores_unknown_keys():
    # Parity detail: ScorerRefSchema is a plain (non-strict) z.object that STRIPS
    # unknown keys, so the gateway must ignore them too (not forbid) — otherwise a
    # future SDK sending richer scorer metadata would 422 at the gateway only.
    run = RegisterRunRequest.model_validate(
        {
            "evaluation_name": "x",
            "dataset_id": "ds1",
            "candidate_version": "v1",
            "scorers": [{"name": "s", "version": "v1", "unknown_scorer_field": "x"}],
        }
    )
    assert not hasattr(run.scorers[0], "unknown_scorer_field")
