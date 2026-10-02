#!/usr/bin/env python3
"""Sync and verify the CLI command reference in docs/cli/get-started.mdx.

Usage:
    uv run python scripts/sync_cli_reference.py          # write to docs
    uv run python scripts/sync_cli_reference.py --check  # exit 1 if stale
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPENAPI_PATH = ROOT / "backend" / "rest" / "openapi" / "public.json"
PLACEMENTS_PATH = ROOT / "tests" / "docs" / "fixtures" / "cli-placements.json"
CLI_DOC_PATH = ROOT / "docs" / "cli" / "get-started.mdx"

START_MARKER = "<!-- [start:cli-commands] -->"
END_MARKER = "<!-- [end:cli-commands] -->"


def _clean_description(desc: str) -> str:
    """Take the first sentence or first line of a tool description."""
    if not desc:
        return ""
    # Strip any newlines or leading/trailing whitespace
    lines = [line.strip() for line in desc.splitlines() if line.strip()]
    if not lines:
        return ""
    first = lines[0]
    # Keep up to the first sentence
    match = re.match(r"^(.*?[.!?])(?:\s|$)", first)
    if match:
        return match.group(1).strip()
    return first.rstrip(".") + "."


def _format_param_placeholder(param_name: str) -> str:
    """Format path param name as CLI argument placeholder."""
    # E.g. trace_id -> <id> or <trace-id>, dataset_id -> <dataset-id>
    name = param_name.replace("_", "-")
    if name.endswith("-id"):
        # e.g. trace-id -> <id> for simple nouns, or keep noun for nested
        return f"<{name}>"
    return f"<{name}>"


def build_command_reference() -> list[tuple[str, str]]:
    """Build a list of (command_syntax, description) tuples in deterministic order."""
    with open(OPENAPI_PATH, encoding="utf-8") as f:
        openapi = json.load(f)

    with open(PLACEMENTS_PATH, encoding="utf-8") as f:
        placements_data = json.load(f)

    placements = placements_data["placements"]
    handwritten = placements_data.get("handwritten", [])

    # Map tool name -> OpenAPI operation object & path
    tool_map: dict[str, tuple[str, dict]] = {}
    for path_str, path_item in openapi.get("paths", {}).items():
        for method in ("get", "post", "patch", "delete", "put"):
            op = path_item.get(method)
            if isinstance(op, dict):
                x_tool = op.get("x-tool", {})
                tool_name = x_tool.get("name") if isinstance(x_tool, dict) else None
                if not tool_name:
                    tool_name = op.get("operationId")
                if tool_name:
                    tool_map[tool_name] = (path_str, op)

    commands: list[tuple[str, str]] = []

    # 1. Add hand-written commands first (auth & diagnostic tools)
    for hw in handwritten:
        commands.append((f"`{hw['command']}`", hw["description"]))

    # 2. Add generated commands from PLACEMENTS
    for tool_name, placement in placements.items():
        if placement.get("kind") != "command":
            continue

        cmd_path = " ".join(placement["path"])
        entry = tool_map.get(tool_name)

        if not entry:
            # Fallback if tool isn't in openapi
            commands.append((f"`{cmd_path}`", f"Manage {placement['path'][0]}."))
            continue

        path_str, op = entry
        desc = _clean_description(op.get("description") or op.get("summary", ""))

        # Derive path placeholders from path_str, e.g. /traces/{trace_id} -> <id>
        path_placeholders = re.findall(r"\{([^}]+)\}", path_str)
        args_str = ""
        if path_placeholders:
            # Format placeholders
            placeholders = []
            for p in path_placeholders:
                if p in (
                    "trace_id",
                    "detector_id",
                    "dashboard_id",
                    "alert_id",
                    "widget_id",
                    "run_id",
                ):
                    placeholders.append("<id>")
                else:
                    placeholders.append(f"<{p.replace('_', '-')}>")
            args_str = " " + " ".join(placeholders)

        # Key query flags
        flags: list[str] = []
        for param in op.get("parameters", []):
            if param.get("in") == "query":
                p_name = param.get("name")
                if p_name in ("limit", "page", "search", "since", "status", "range"):
                    flags.append(f"`--{p_name.replace('_', '-')}`")

        flag_suffix = ""
        if flags:
            flag_suffix = f" (Flags: {', '.join(flags)})"

        cmd_syntax = f"`{cmd_path}{args_str}`"
        full_desc = f"{desc}{flag_suffix}" if flag_suffix else desc
        commands.append((cmd_syntax, full_desc))

    return commands


def render_markdown_table(commands: list[tuple[str, str]]) -> str:
    """Render the commands list into a GitHub Flavored Markdown table."""
    lines = [
        "| Command | Description |",
        "| :--- | :--- |",
    ]
    for cmd, desc in commands:
        # Escape any pipe chars in description
        escaped_desc = desc.replace("|", "\\|")
        lines.append(f"| {cmd} | {escaped_desc} |")
    return "\n".join(lines)


def sync(check: bool = False) -> int:
    commands = build_command_reference()
    rendered_table = render_markdown_table(commands)
    content = CLI_DOC_PATH.read_text(encoding="utf-8")

    if START_MARKER in content and END_MARKER in content:
        # Replace between markers
        before = content.split(START_MARKER)[0] + START_MARKER + "\n\n"
        after = "\n\n" + END_MARKER + content.split(END_MARKER)[1]
        new_content = before + rendered_table + after
    else:
        # Wrap existing table under ## Command reference
        pattern = re.compile(r"(## Command reference\s*\n\n[^\n]*\n\n)(?:\|[^\n]+\n)+")
        match = pattern.search(content)
        if match:
            new_content = (
                content[: match.start(1)]
                + match.group(1)
                + f"{START_MARKER}\n\n"
                + rendered_table
                + f"\n\n{END_MARKER}\n"
                + content[match.end() :]
            )
        else:
            print("Could not find ## Command reference section in doc", file=sys.stderr)
            return 1

    if check:
        if content != new_content:
            print(
                f"{CLI_DOC_PATH} command reference is stale. "
                "Regenerate with `uv run python scripts/sync_cli_reference.py`.",
                file=sys.stderr,
            )
            return 1
        print("CLI command reference is up to date.")
        return 0

    CLI_DOC_PATH.write_text(new_content, encoding="utf-8")
    print(f"Updated CLI command reference ({len(commands)} commands) in {CLI_DOC_PATH}")
    return 0


def main() -> int:
    check = "--check" in sys.argv
    return sync(check=check)


if __name__ == "__main__":
    sys.exit(main())
