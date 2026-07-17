"""Cross-layer drift guard (Pydantic side).

The public eval reporting contract is defined twice: the Zod schemas in
``frontend/packages/core/src/eval-contract.ts`` (the Next.js control plane) and
the Pydantic models in ``rest.schemas.eval`` (the FastAPI gateway). If they
disagree on which payloads are valid, the gateway could accept a request the
control plane rejects (or vice-versa) — and because the gateway forwards the raw
request bytes upstream, its own validation is the only place that divergence can
be caught before the SDK sees a confusing 400.

The guard has two halves, and this file and ``eval-contract-parity.drift.test.ts``
run the same two against their own layer:

1. BEHAVIOURAL — replay the shared payload fixtures in
   ``eval-contract-parity-fixtures.json`` and assert identical accept/reject
   verdicts (plus identical normalization of the values that degrade rather than
   reject). Catches semantics no schema shape can express.
2. STRUCTURAL — reduce every model to a language-neutral descriptor and compare it
   against the shared roster in ``eval-contract-shape.json``. Fixtures alone cannot
   catch a one-sided OPTIONAL field or a one-sided bound: no fixture exercises them,
   so every verdict is unchanged and both suites stay green. The roster makes any
   field added, removed or retyped on one layer only fail that layer's comparison,
   and its coverage assertion makes a NEW model fail until it is listed.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from rest.schemas import eval as eval_schemas
from rest.schemas.eval import (
    JSON_SAFE_INT_MAX,
    CompleteRunRequest,
    RegisterRunRequest,
    UpsertResultRequest,
)

_SHARED = (
    Path(__file__).resolve().parents[2] / "frontend" / "packages" / "core" / "src" / "__tests__"
)
FIXTURES = _SHARED / "eval-contract-parity-fixtures.json"
SHAPES = _SHARED / "eval-contract-shape.json"

MODELS: dict[str, type[BaseModel]] = {
    "register": RegisterRunRequest,
    "upsert_result": UpsertResultRequest,
    "complete": CompleteRunRequest,
}


def _fixtures() -> dict:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def _roster() -> dict:
    return json.loads(SHAPES.read_text(encoding="utf-8"))


def _cases(kind: str) -> list[tuple[str, type[BaseModel], dict]]:
    data = _fixtures()
    out: list[tuple[str, type[BaseModel], dict]] = []
    for group, model in MODELS.items():
        for case in data[group].get(kind, []):
            out.append((f"{group}/{case['name']}", model, case))
    return out


_VALID = _cases("valid")
_INVALID = _cases("invalid")
_DEGRADED = _cases("degraded")


def test_fixture_files_are_the_shared_source():
    # The Zod drift test loads these exact files; guard against a rename/move.
    assert FIXTURES.exists(), FIXTURES
    assert SHAPES.exists(), SHAPES
    assert set(_fixtures()) >= set(MODELS)


@pytest.mark.parametrize("label,model,case", _VALID, ids=[c[0] for c in _VALID])
def test_pydantic_accepts_valid(label: str, model: type[BaseModel], case: dict):
    # Must not raise; mirrors Zod safeParse().success === true for the same payload.
    model.model_validate(case["payload"])


@pytest.mark.parametrize("label,model,case", _INVALID, ids=[c[0] for c in _INVALID])
def test_pydantic_rejects_invalid(label: str, model: type[BaseModel], case: dict):
    # Must raise; mirrors Zod safeParse().success === false for the same payload.
    if case["name"].startswith(_UNKNOWN_KEY_PREFIX):
        pytest.skip(
            "Unknown-key rejection is deliberately Zod-only — see the module docstring in "
            "rest/schemas/eval.py. The gateway forwards bodies verbatim and FastAPI validates "
            "before the handler runs, so forbidding here would 422 a field the gateway does not "
            "yet model and it would never reach persistence. Asserted instead by "
            "tests/rest/test_public_eval_gateway_security.py::test_unmodelled_field_still_reaches_the_handler."
        )
    with pytest.raises(ValidationError):
        model.model_validate(case["payload"])


def _at_path(value: Any, path: str) -> Any:
    """Read ``a.0.b`` out of a validated model (list indices are numeric segments)."""
    for segment in path.split("."):
        if isinstance(value, BaseModel):
            value = getattr(value, segment, None)
        elif segment.isdigit():
            value = value[int(segment)]
        else:
            value = value.get(segment) if isinstance(value, dict) else getattr(value, segment, None)
    return value


@pytest.mark.parametrize("label,model,case", _DEGRADED, ids=[c[0] for c in _DEGRADED])
def test_pydantic_degrades_instead_of_rejecting(label: str, model: type[BaseModel], case: dict):
    """Accept/reject parity is not enough where a layer NORMALIZES the value instead.

    A display-only vocabulary degrades an unrecognised member to null rather than
    failing the whole run (``.catch(null)`` / the ``mode="before"`` validator), and a
    non-strict scorer strips unknown keys. Both layers must land on the same value,
    or the gateway publishes something the control plane never stored.
    """
    parsed = model.model_validate(case["payload"])
    for path, expected in case["expect"].items():
        assert _at_path(parsed, path) == expected, path


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


# --- Structural shapes -------------------------------------------------------
#
# Mirrors `contract-shape.ts`: both sides reduce a model to the same descriptor, so
# the roster is directly comparable. Representational differences that carry no
# contract meaning are normalized away — `anyOf: [T, null]` collapses to `nullable`,
# and a None/absent default is dropped (pydantic's `None` default and Zod's absent-key
# `undefined` both just mean "the caller omitted it").


def _unwrap_nullable(node: dict) -> tuple[dict, bool]:
    variants = node.get("anyOf") or node.get("oneOf")
    if isinstance(variants, list) and len(variants) == 2:
        if variants[1] == {"type": "null"}:
            return variants[0], True
        if variants[0] == {"type": "null"}:
            return variants[1], True
    return node, False


def _put(target: dict, key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def _sans_safe_integer_bound(value: Any) -> Any:
    """Drop the ``Number.isSafeInteger`` sentinel that ``z.number().int()`` publishes.

    It describes the JS number type rather than a choice the contract made; the gateway
    mirrors the same ceiling as ``JSON_SAFE_INT_MAX``, so dropping it on both sides
    leaves an integer field comparing on its real bounds (``minimum: 0``, ``max: 5``).
    """
    return None if value in (JSON_SAFE_INT_MAX, -JSON_SAFE_INT_MAX) else value


def _type_shape(node: dict) -> dict:
    """Reduce one JSON Schema node to its language-neutral type descriptor."""
    if "$ref" in node:
        return {"type": node["$ref"].rsplit("/", 1)[-1]}
    if "const" in node:
        return {"type": "literal", "const": node["const"]}
    if "enum" in node:
        return {"type": "enum", "enum": list(node["enum"])}

    kind = node.get("type")
    if kind == "string":
        shape = {"type": "string"}
        _put(shape, "min_length", node.get("minLength"))
        _put(shape, "max_length", node.get("maxLength"))
        return shape
    if kind in ("integer", "number"):
        shape = {"type": kind}
        _put(shape, "minimum", _sans_safe_integer_bound(node.get("minimum")))
        _put(shape, "maximum", _sans_safe_integer_bound(node.get("maximum")))
        return shape
    if kind == "boolean":
        return {"type": "boolean"}
    if kind == "array":
        shape = {"type": "array", "items": _type_shape(node.get("items", {}))}
        _put(shape, "min_items", node.get("minItems"))
        _put(shape, "max_items", node.get("maxItems"))
        return shape
    if kind == "object":
        # A free-form JSON object (`dict[str, Any]` / a Zod record). Named object
        # models are always emitted as a `$ref` and handled above.
        if "properties" not in node:
            return {"type": "json_object"}
        raise AssertionError(f"unnamed inline object: {json.dumps(node)[:120]}")
    if kind is None:
        # `Any` / `z.unknown()` — an unconstrained JSON value.
        return {"type": "any"}
    raise AssertionError(f"unsupported schema node: {json.dumps(node)[:120]}")


def _model_shape(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()
    fields: dict[str, dict] = {}
    for name, prop in schema.get("properties", {}).items():
        inner, nullable = _unwrap_nullable(prop)
        info = model.model_fields[name]
        shape = _type_shape(inner)
        shape["required"] = info.is_required()
        shape["nullable"] = nullable
        # Read the default off the field rather than the JSON Schema: pydantic omits a
        # `default_factory` value from the schema, and the Zod side publishes it.
        default = None if info.is_required() else info.get_default(call_default_factory=True)
        if default is not None:
            shape["default"] = default
        fields[name] = shape
    return {
        "kind": "object",
        "unknown_keys": "forbid" if schema.get("additionalProperties") is False else "strip",
        "fields": fields,
    }


def _contract_models() -> dict[str, type[BaseModel]]:
    """Every model DEFINED in ``rest.schemas.eval``, enumerated from the module.

    Enumerated rather than hand-listed so a newly added model is covered by the
    roster — or fails ``test_shape_roster_covers_every_model`` — automatically.
    """
    return {
        name: obj
        for name, obj in vars(eval_schemas).items()
        if isinstance(obj, type)
        and issubclass(obj, BaseModel)
        and obj.__module__ == eval_schemas.__name__
    }


#: Gateway request bodies. Zod owns unknown-key strictness for these; the Pydantic
#: models stay permissive so the gateway forwards a field it does not model rather
#: than 422-ing it before the authoritative writer ever sees it.
_GATEWAY_PERMISSIVE_MODELS = frozenset(
    {"ScoreInput", "RegisterRunRequest", "UpsertResultRequest", "CompleteRunRequest"}
)
#: Fixture cases that assert unknown-key rejection — Zod-side only, same reason.
#: Matched by prefix so a newly added `unknown_*` case is covered automatically.
_UNKNOWN_KEY_PREFIX = "unknown"

_ROSTER = _roster()
_PYDANTIC_NAMES = sorted(set(_ROSTER["paired"]) | set(_ROSTER["pydantic_only"]))


def test_shape_roster_covers_every_model():
    """An unlisted model must FAIL, not silently pass — that is the whole point.

    A model added to the gateway without a roster entry is a model with zero
    cross-layer coverage; listing it (in ``paired``, or in ``pydantic_only`` with the
    reason it has no Zod counterpart) is the deliberate act this asserts on.
    """
    assert sorted(_contract_models()) == _PYDANTIC_NAMES


@pytest.mark.parametrize("name", _PYDANTIC_NAMES)
def test_model_shape_matches_roster(name: str):
    """A field added/removed/retyped on ONE layer fails here by construction.

    ``unknown_keys`` is compared everywhere EXCEPT the gateway request bodies, where
    the two layers differ on purpose: the Zod schemas are ``.strict()`` while the
    Pydantic models are deliberately not ``extra="forbid"`` (see the module docstring
    in ``rest/schemas/eval.py``). Forbidding at the gateway would 422 a field it does
    not yet model — breaking a rolling deploy where a newer SDK talks to an older
    gateway fronting a handler that would have accepted it. Every other part of the
    shape is still compared field-for-field, so real drift still fails here.
    """
    expected = _ROSTER["paired"].get(name) or _ROSTER["pydantic_only"][name]
    actual = _model_shape(_contract_models()[name])
    if name in _GATEWAY_PERMISSIVE_MODELS:
        expected = {k: v for k, v in expected.items() if k != "unknown_keys"}
        actual = {k: v for k, v in actual.items() if k != "unknown_keys"}
    assert actual == expected


@pytest.mark.parametrize("name", sorted(_ROSTER["zod_only"]))
def test_zod_only_models_have_no_gateway_counterpart(name: str):
    """The asymmetry the roster records must stay real.

    These are contract schemas the gateway forwards without typing (the dataset
    catch-alls). Adding a Pydantic model for one is exactly the moment it must be
    promoted to ``paired`` and start being compared field-for-field.
    """
    assert name not in _contract_models()
