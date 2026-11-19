"""Findings by a key that stays the same between price files, so two reports can be
compared: what one clears and what it adds."""

from .catalogs import FIELD_LABELS
from .text import _join


def finding_keys(report: dict) -> dict[tuple, dict]:
    """Each finding by a key that stays the same from one price file to the next, so
    two reports can be compared."""
    keys: dict[tuple, dict] = {}
    for item in report["flagged"]:
        keys[("rate", item["model"], item["field"])] = item
    for item in report["unpriced_ids"]:
        keys[("id", item["model"])] = item
    for item in report["overlaps"]:
        keys[("overlap", item["model"])] = item
    for item in report["row_problems"]:
        keys[("row", item["row"], item["problem"])] = item
    for item in report["missing"]:
        keys[("missing", item["provider"], item["model"])] = item
    for item in report["long_context"]:
        keys[("long_context", item["model"])] = item
    return keys


def describe(key: tuple) -> str:
    """A finding key in a few words, e.g. "claude-x cache read rate"."""
    match key:
        case ("rate", model, field):
            return f"{model} {FIELD_LABELS[field]} rate"
        case ("id", model):
            return f"{model} not priced by its row"
        case ("overlap", model):
            return f"{model} matched by two rows"
        case ("row", row, problem):
            return f"{row}: {problem}"
        case ("missing", _, model):
            return f"{model} not priced"
        case ("long_context", model):
            return f"{model} long-context rate"
    raise ValueError(f"unknown finding {key}")


def describe_all(keys: list[tuple]) -> list[str]:
    """Finding keys in a few words each, with one model's rates merged, e.g.
    "claude-x input and cache read rates"."""
    rates: dict[str, list[str]] = {}
    others = []
    for key in keys:
        if key[0] == "rate":
            rates.setdefault(key[1], []).append(FIELD_LABELS[key[2]])
        else:
            others.append(describe(key))
    merged = [
        f"{model} {_join(fields)} rate" + "s" * (len(fields) > 1) for model, fields in rates.items()
    ]
    return merged + others


def _found_through(key: tuple, item: dict) -> str | None:
    """The row a finding was found through: the row whose rates a flag or long-context
    rate is about, or the row an unpriced ID belongs to. None for the other findings."""
    match key[0]:
        case "rate":
            name = item["priced_as"] or item["model"]
        case "long_context":
            name = item["model"]
        case "id":
            name = item["row"]
        case _:
            return None
    return str(name)


def changes(report: dict, after: dict) -> tuple[list[tuple], list[str]]:
    """The findings in report that the after report clears, and what it adds, in a few
    words each. A finding found through a row is not cleared when the after report stops
    comparing that row with any catalog, as when its provider changes to one no catalog
    covers: that can hide the finding, so the row is an add instead."""
    before, after_keys = finding_keys(report), finding_keys(after)
    stopped = set(after["no_match"]) - set(report["no_match"])
    rows = {key: _found_through(key, item) for key, item in before.items()}
    hidden = [key for key in before if rows[key] in stopped]
    fixes = [key for key in before if key not in after_keys and key not in hidden]
    adds = describe_all([key for key in after_keys if key not in before])
    for row in dict.fromkeys(rows[key] for key in hidden):
        adds.append(f"{row} no longer compared with the catalogs")
    return fixes, adds
