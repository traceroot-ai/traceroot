#!/usr/bin/env python3
"""Sync documentation snippets from runnable examples into docs pages.

Usage:
    python scripts/sync_doc_snippets.py          # Regenerate snippets and update docs
    python scripts/sync_doc_snippets.py --check  # Verify snippets are up to date (for CI)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_DIR = REPO_ROOT / "examples"
DOCS_DIR = REPO_ROOT / "docs"

START_MARKER_RE = re.compile(r"(?:#|//|\{/\*)\s*\[start:([\w-]+)\]\s*(?:\*/)?")
END_MARKER_RE = re.compile(r"(?:#|//|\{/\*)\s*\[end:([\w-]+)\]\s*(?:\*/)?")

# Target doc files that embed snippets between markers
DOC_EMBED_MARKER_RE = re.compile(
    r"(([ \t]*)\{/\*\s*\[start:snippet:([\w-]+)\]\s*\*/\}\n)(.*?)"
    r"([ \t]*\{/\*\s*\[end:snippet:\3\]\s*\*/\})",
    re.DOTALL,
)


def extract_snippets_from_examples() -> dict[str, dict[str, str]]:
    """Scan examples/ directory for marked snippets."""
    snippets: dict[str, dict[str, str]] = {}

    for file_path in EXAMPLES_DIR.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix not in (".py", ".ts", ".js"):
            continue
        # Skip node_modules and hidden files
        if "node_modules" in file_path.parts or any(p.startswith(".") for p in file_path.parts):
            continue

        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        lines = content.splitlines()
        current_id: str | None = None
        current_lines: list[str] = []

        for line in lines:
            start_match = START_MARKER_RE.search(line)
            if start_match:
                current_id = start_match.group(1)
                current_lines = []
                continue

            end_match = END_MARKER_RE.search(line)
            if end_match:
                snippet_id = end_match.group(1)
                if current_id == snippet_id:
                    lang = "python" if file_path.suffix == ".py" else "typescript"
                    code = "\n".join(current_lines).strip("\n")
                    snippets[snippet_id] = {
                        "lang": lang,
                        "code": code,
                        "source": str(file_path.relative_to(REPO_ROOT)),
                    }
                    current_id = None
                    current_lines = []
                continue

            if current_id is not None:
                current_lines.append(line)

    return snippets


def sync_doc_file(
    doc_path: Path,
    snippets: dict[str, dict[str, str]],
    check_mode: bool,
    expected_snippets: list[str] | None = None,
) -> tuple[bool, list[str]]:
    """Sync snippet blocks inside a documentation file."""
    if not doc_path.exists():
        return False, [f"Document does not exist: {doc_path.relative_to(REPO_ROOT)}"]

    content = doc_path.read_text(encoding="utf-8")
    mismatches: list[str] = []

    # Validate that the document contains exactly the expected snippet blocks
    matches = list(DOC_EMBED_MARKER_RE.finditer(content))
    found_snippet_ids = [m.group(3) for m in matches]

    if expected_snippets is not None and (
        len(matches) != len(expected_snippets) or found_snippet_ids != expected_snippets
    ):
        mismatches.append(
            f"{doc_path.relative_to(REPO_ROOT)}: expected {len(expected_snippets)} snippet blocks "
            f"{expected_snippets}, but found {len(matches)} matching blocks {found_snippet_ids}"
        )

    def replacer(match: re.Match[str]) -> str:
        open_tag = match.group(1)
        tag_indent = match.group(2)
        snippet_id = match.group(3)
        old_body = match.group(4)
        old_close_tag = match.group(5)

        if snippet_id not in snippets:
            mismatches.append(
                f"{doc_path.relative_to(REPO_ROOT)}: unknown snippet ID '{snippet_id}'",
            )
            return match.group(0)

        snippet = snippets[snippet_id]
        indent = tag_indent
        lang = snippet["lang"]
        code_lines = snippet["code"].splitlines()
        indented_code = "\n".join(
            (f"{indent}{line}" if line.strip() else "") for line in code_lines
        )
        new_body = f"{indent}```{lang}\n{indented_code}\n{indent}```\n"
        new_close_tag = f"{tag_indent}{{/* [end:snippet:{snippet_id}] */}}"

        if old_body.strip() != new_body.strip() or old_close_tag != new_close_tag:
            mismatches.append(
                f"{doc_path.relative_to(REPO_ROOT)}: snippet '{snippet_id}' differs from source",
            )

        return f"{open_tag}{new_body}{new_close_tag}"

    new_content = DOC_EMBED_MARKER_RE.sub(replacer, content)

    if not check_mode and new_content != content:
        doc_path.write_text(new_content, encoding="utf-8")

    return len(mismatches) == 0, mismatches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if snippets are stale")
    args = parser.parse_args()

    snippets = extract_snippets_from_examples()
    if not snippets:
        print("Error: No snippets found in examples/", file=sys.stderr)
        return 1

    errors: list[str] = []

    # Sync / check docs target pages
    expected_page_snippets: dict[Path, list[str]] = {
        DOCS_DIR / "tracing" / "get-started.mdx": [
            "tracing-get-started-python",
            "tracing-get-started-typescript",
        ],
    }

    for doc_target, expected_ids in expected_page_snippets.items():
        ok, mismatches = sync_doc_file(
            doc_target, snippets, check_mode=args.check, expected_snippets=expected_ids
        )
        if args.check and not ok:
            errors.extend(mismatches)

    if errors:
        print("Documentation snippets drift check failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(
            "\nRun 'python scripts/sync_doc_snippets.py' to regenerate doc snippets.",
            file=sys.stderr,
        )
        return 1

    if args.check:
        print(f"All {len(snippets)} doc snippets are in sync with examples/.")
    else:
        print(
            f"Successfully synced {len(snippets)} snippets to docs pages.",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
