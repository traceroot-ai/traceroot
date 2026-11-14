"""Findings by key, so two reports can be compared: what one clears and what it adds.
Also reads the report --baseline compares a run with."""

import json
from datetime import datetime
from pathlib import Path

from .catalogs import FIELD_LABELS, CheckError
from .text import _amount, _catalog_amount, _join


def finding_keys(report: dict) -> dict[tuple, dict]:
    """Each finding by a key: what it is about and, for a flagged rate or an unpriced
    ID, the value it has, our rate or the row that prices the ID. An edit that changes
    that value gives the finding a new key."""
    keys: dict[tuple, dict] = {}
    for item in report["flagged"]:
        keys[("rate", item["model"], item["field"], item["ours"])] = item
    for item in report["unpriced_ids"]:
        keys[("id", item["model"], item["priced_as"])] = item
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
    """A finding key in a few words, e.g. "claude-x cache read rate (ours 0.10)"."""
    match key:
        case ("rate", model, field, ours):
            return f"{model} {FIELD_LABELS[field]} rate (ours {_amount(ours)})"
        case ("id", model, None):
            return f"{model} not priced by its row"
        case ("id", model, priced_as):
            return f"{model} priced as {priced_as}"
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
    "claude-x input and cache read rates (ours 1.00 and 0.10)"."""
    rates: dict[str, list[tuple]] = {}
    others = []
    for key in keys:
        if key[0] == "rate":
            rates.setdefault(key[1], []).append(key)
        else:
            others.append(describe(key))
    merged = [
        f"{model} {_join([FIELD_LABELS[key[2]] for key in found])} rate"
        + "s" * (len(found) > 1)
        + f" (ours {_join([_amount(key[3]) for key in found])})"
        for model, found in rates.items()
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


def _identity(key: tuple) -> tuple:
    """A finding key without the value it has: a flagged rate by model and field, an
    unpriced ID by the ID."""
    match key[0]:
        case "rate":
            return key[:3]
        case "id":
            return key[:2]
    return key


def _host_rates_added(before: dict | None, after: dict) -> bool:
    """Whether a host ID's entry in host_rates after an edit is new, given its entry
    before, or None: no row priced the ID at rates its host disagrees with, or another
    row did at other rates. A change to the same row's rates is judged by that row's own
    flags, and a row that takes the ID over at the same rates leaves its price as it was."""
    if before is None:
        return True
    rates = {(rate["field"], rate["ours"]) for rate in before["rates"]}
    moved = before["row"] != after["row"]
    return moved and any((rate["field"], rate["ours"]) not in rates for rate in after["rates"])


def _row_names(report: dict) -> set[str]:
    """Every row in the price file a report is on, compared with a catalog or not."""
    return {*report["compared_rows"], *report["no_match"]}


def changes(report: dict, after: dict) -> tuple[list[tuple], list[str]]:
    """The findings in report that the after report clears, and what it adds, each add
    in a few words on a line of its own, so adds can be checked one by one against the
    kinds allowed. A finding is cleared only when the after report has nothing about the
    same rate or ID, and added when its key is new, so a flagged rate changed to another
    wrong one, or an ID moved from no row to the wrong row, is an add and not a fix. A
    finding found through a row is not cleared when the after report stops comparing
    that row with any catalog, as when its provider changes to one no catalog covers, or
    no longer has the row: that hides the finding, so the row is an add instead. Two
    changes no finding shows are adds too: a host ID newly priced at rates its host
    disagrees with (see _host_rates_added), and a dash spelling a row priced before and
    none prices after."""
    before, after_keys = finding_keys(report), finding_keys(after)
    removed = _row_names(report) - _row_names(after)
    stopped = (set(after["no_match"]) - set(report["no_match"])) | removed
    rows = {key: _found_through(key, item) for key, item in before.items()}
    hidden = [key for key in before if rows[key] in stopped]
    left = {_identity(key) for key in after_keys}
    fixes = [key for key in before if _identity(key) not in left and key not in hidden]
    adds = [describe(key) for key in after_keys if key not in before]
    for row in dict.fromkeys(rows[key] for key in hidden):
        gone = "row removed" if row in removed else "no longer compared with the catalogs"
        adds.append(f"{row} {gone}")
    for model_id, found in after["host_rates"].items():
        if not _host_rates_added(report["host_rates"].get(model_id), found):
            continue
        listed = [
            f"{FIELD_LABELS[r['field']]} {_catalog_amount(r)} (ours {_amount(r['ours'])})"
            for r in found["rates"]
        ]
        adds.append(
            f"{model_id} priced at {found['row']}'s rates, but the host lists {_join(listed)}"
        )
    for dashed, was in report["dash_spellings"].items():
        if dashed not in after["dash_spellings"]:
            adds.append(f"{dashed} no longer priced (was {was})")
    return fixes, adds


def load_baseline(path: Path) -> dict:
    """A report saved by --json from a completed run. Anything else fails the run."""
    try:
        baseline = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise CheckError(f"could not read the baseline report ({type(exc).__name__})") from exc
    if not isinstance(baseline, dict) or baseline.get("status") != "ok":
        raise CheckError("the baseline report is not from a completed run")
    try:
        finding_keys(baseline)
        datetime.fromisoformat(baseline["date"])
        # Without these, an edit that stops pricing a dash spelling, prices a host ID at
        # the wrong rate, or deletes a flagged row, would pass unseen.
        for key, kind in (("dash_spellings", dict), ("host_rates", dict), ("compared_rows", list)):
            if not isinstance(baseline[key], kind):
                raise TypeError(f"{key} is not a {kind.__name__}")
    except (KeyError, TypeError, ValueError) as exc:
        raise CheckError("the baseline report was written by a different version") from exc
    return baseline
