"""Findings by key, so two reports can be compared: what one clears and what it adds.
Also reads the report --baseline compares a run with."""

import json
from datetime import datetime
from pathlib import Path

from .catalogs import FIELD_LABELS, FIELDS, CheckError
from .checks import _matches
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


def _host_rates_added(before: dict | None, after: dict, compared: set[str]) -> bool:
    """Whether a host ID's entry in host_rates after an edit is new, given its entry
    before, or None: no row priced the ID at rates its host disagrees with, or another
    row did at other rates, or the same row did at other rates and no catalog compares
    it. A change to a compared row's rates is judged by that row's own flags, and a row
    that takes the ID over at the same rates leaves its price as it was."""
    if before is None:
        return True
    rates = {(rate["field"], rate["ours"]) for rate in before["rates"]}
    changed = any((rate["field"], rate["ours"]) not in rates for rate in after["rates"])
    return changed and (before["row"] != after["row"] or after["row"] not in compared)


def _row_names(report: dict) -> set[str]:
    """Every row in the price file a report is on, compared with a catalog or not."""
    return {*report["compared_rows"], *report["no_match"]}


def changes(report: dict, after: dict) -> tuple[list[tuple], list[str]]:
    """The findings in report that the after report clears, and what it adds, each add
    in a few words on a line of its own, so each can be checked on its own. A finding is
    cleared only when the after report has nothing about the same rate or ID, and added
    when its key is new, so a flagged rate changed to another wrong one, or an ID moved
    from no row to the wrong row, is an add and not a fix. A finding found through a row
    is not cleared when the after report stops comparing that row with any catalog, as
    when its provider changes to one no catalog covers, or no longer has the row: that
    hides the finding, so the row is an add instead. Two changes no finding shows are
    adds too: a host ID newly priced at rates its host disagrees with (see
    _host_rates_added), and a dash spelling a row priced before and none prices
    after."""
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
    compared = set(after["compared_rows"])
    for model_id, found in after["host_rates"].items():
        if not _host_rates_added(report["host_rates"].get(model_id), found, compared):
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


def _unexplained(report: dict, after: dict) -> list[str]:
    """Each change to a row of report that no finding the after report fixes or adds
    explains, in a few words. A row removed or moved to another provider is never
    explained. A rate change is explained by a flag on that rate found through the row,
    for its own model or a dated snapshot or -latest alias it prices, fixed or added. A
    flag on another model its pattern prices asks for a narrower pattern, not a new rate:
    giving the row that model's rate clears the flag but bills the row's own model at
    it. A row named after a [1m] or host ID that no catalog lists under it is checked
    only through that ID, so a change to it is explained when that ID's own finding, or a
    host rate on that field, is fixed or added. A matchPattern change is explained when
    the old or new pattern matches an ID that moved: one a finding fixed or added is
    about, a dash spelling or host ID priced another way, or a row the edit adds. A row
    problem fixed or added explains its row's rates and pattern. Rows the edit adds are
    judged by their findings alone. No catalog compares about a quarter of the rows, and
    a rate changed inside the tolerance shows no flag, so without this an edit to either
    would pass unseen."""
    old_keys, new_keys = finding_keys(report), finding_keys(after)
    changed = {
        key: item
        for key, item in {**old_keys, **new_keys}.items()
        if (key in old_keys) != (key in new_keys)
    }
    flags = {
        (_found_through(key, item), key[2])
        for key, item in changed.items()
        if key[0] == "rate" and item["fix"] == "rate"
    }
    flags |= {
        (key[1], field)
        for key in changed
        if key[0] == "id" and key[1] == key[2]
        for field in FIELDS
    }
    # By ID and field, without our rate: a host rate still wrong, or right both times,
    # explains nothing.
    old_named, new_named = (
        {
            (model_id, rate["field"])
            for model_id, entry in found["host_rates"].items()
            if entry["row"] == model_id
            for rate in entry["rates"]
        }
        for found in (report, after)
    )
    flags |= old_named ^ new_named
    whole = {key[1] for key in changed if key[0] == "row"}
    moved = {item["model"] for key, item in changed.items() if key[0] != "row"}
    for name in ("dash_spellings", "host_rates"):
        was, now = report[name], after[name]
        moved |= {
            model_id
            for model_id in was.keys() | now.keys()
            if was.get(model_id) != now.get(model_id)
        }
    moved |= after["rows"].keys() - report["rows"].keys()
    # The worker prices a row's own name with that row, whatever the patterns, so a name
    # both files list cannot have moved.
    moved -= report["rows"].keys() & after["rows"].keys()
    lines = []
    for name, old in report["rows"].items():
        new = after["rows"].get(name)
        if new is None:
            lines.append(f"{name} row removed")
            continue
        if new["provider"] != old["provider"]:
            lines.append(f"{name} provider changed")
        if name in whole:
            continue
        for field in FIELDS:
            was, now = old["prices"][field], new["prices"][field]
            if was != now and (name, field) not in flags:
                lines.append(
                    f"{name} {FIELD_LABELS[field]} rate changed with no finding to fix "
                    f"(ours {_amount(was)} → {_amount(now)})"
                )
        if old["matchPattern"] != new["matchPattern"] and not any(
            _matches(row, model_id) for row in (old, new) for model_id in moved
        ):
            lines.append(f"{name} matchPattern changed with no finding to fix")
    return lines


def baseline_changes(report: dict, after: dict) -> tuple[list[tuple], list[str]]:
    """What --baseline lists for an edit from report to after: what changes finds, and
    each row change no finding explains (see _unexplained). A removed row with a finding
    is listed once. --track lists only what changes finds, as an open PR is judged by its
    findings."""
    fixes, adds = changes(report, after)
    return fixes, adds + [line for line in _unexplained(report, after) if line not in adds]


def load_baseline(path: Path) -> dict:
    """A report saved by --json from a completed run. Anything else fails the run."""
    try:
        baseline = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CheckError(f"could not read the baseline report ({type(exc).__name__})") from exc
    if not isinstance(baseline, dict) or baseline.get("status") != "ok":
        raise CheckError("the baseline report is not from a completed run")
    try:
        finding_keys(baseline)
        datetime.fromisoformat(baseline["date"])
        # Without these, an edit that stops pricing a dash spelling, prices a host ID at
        # the wrong rate, deletes a flagged row, or changes a row no finding shows, would
        # pass unseen. Without the catalog hashes, a catalog that moved between the two
        # runs would read as a fix.
        for key, kind in (
            ("dash_spellings", dict),
            ("host_rates", dict),
            ("compared_rows", list),
            ("rows", dict),
            ("catalogs", dict),
        ):
            if not isinstance(baseline[key], kind):
                raise TypeError(f"{key} is not a {kind.__name__}")
    except (KeyError, TypeError, ValueError) as exc:
        raise CheckError("the baseline report was written by a different version") from exc
    return baseline
