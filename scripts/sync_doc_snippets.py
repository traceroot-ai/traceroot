#!/usr/bin/env python3
"""Sync documentation snippets from runnable examples into docs/snippets/ and docs pages.

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
SNIPPETS_DIR = DOCS_DIR / "snippets"

START_MARKER_RE = re.compile(r"(?:#|//|\{/\*)\s*\[start:([\w-]+)\]\s*(?:\*/)?")
END_MARKER_RE = re.compile(r"(?:#|//|\{/\*)\s*\[end:([\w-]+)\]\s*(?:\*/)?")

# Target doc files that embed snippets between markers
DOC_EMBED_MARKER_RE = re.compile(
    r"((?:<!--|\{/\*)\s*\[start:snippet:([\w-]+)\]\s*(?:-->|\*/)\n)(.*?)"
    r"((?:<!--|\{/\*)\s*\[end:snippet:\2\]\s*(?:-->|\*/))",
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


def format_snippet_file_content(lang: str, code: str) -> str:
    """Format the content for a reusable .mdx snippet file."""
    return f"```{lang}\n{code}\n```\n"


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

    # Validate that all expected snippet markers exist on the page
    if expected_snippets:
        found_markers = set(re.findall(r"(?:<!--|\{/\*)\s*\[start:snippet:([\w-]+)\]", content))
        for exp_id in expected_snippets:
            if exp_id not in found_markers:
                mismatches.append(
                    f"{doc_path.relative_to(REPO_ROOT)}: missing expected snippet marker '[start:snippet:{exp_id}]'",
                )

    def replacer(match: re.Match[str]) -> str:
        open_tag = match.group(1)
        snippet_id = match.group(2)
        old_body = match.group(3)
        close_tag = match.group(4)

        if snippet_id not in snippets:
            mismatches.append(
                f"{doc_path.relative_to(REPO_ROOT)}: unknown snippet ID '{snippet_id}'",
            )
            return match.group(0)

        snippet = snippets[snippet_id]
        indent = ""
        for line in old_body.splitlines():
            if line.strip():
                indent = line[: len(line) - len(line.lstrip())]
                break

        lang = snippet["lang"]
        code_lines = snippet["code"].splitlines()
        indented_code = "\n".join(
            (f"{indent}{line}" if line.strip() else "") for line in code_lines
        )
        new_body = f"{indent}```{lang}\n{indented_code}\n{indent}```\n"

        if old_body.strip() != new_body.strip():
            mismatches.append(
                f"{doc_path.relative_to(REPO_ROOT)}: snippet '{snippet_id}' differs from source",
            )

        return f"{open_tag}{new_body}{close_tag}"

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

    # 1. Sync / check docs/snippets/*.mdx files
    SNIPPETS_DIR.mkdir(parents=True, exist_ok=True)
    for snippet_id, info in sorted(snippets.items()):
        snippet_file = SNIPPETS_DIR / f"{snippet_id}.mdx"
        expected_content = format_snippet_file_content(info["lang"], info["code"])

        if args.check:
            if not snippet_file.exists():
                errors.append(f"Missing snippet file: {snippet_file.relative_to(REPO_ROOT)}")
            else:
                actual_content = snippet_file.read_text(encoding="utf-8")
                if actual_content != expected_content:
                    errors.append(
                        f"Snippet file out of date: {snippet_file.relative_to(REPO_ROOT)} "
                        f"(source: {info['source']})",
                    )
        else:
            snippet_file.write_text(expected_content, encoding="utf-8")

    # 2. Sync / check docs target pages
    expected_page_snippets: dict[Path, list[str]] = {
        DOCS_DIR / "tracing" / "get-started.mdx": [
            "tracing-get-started-python",
            "tracing-get-started-typescript",
        ],
        DOCS_DIR / "tracing" / "cost-tracking.mdx": [
            "tracing-cost-tracking-python",
            "tracing-cost-tracking-typescript",
        ],
        DOCS_DIR / "tracing" / "python-sdk.mdx": [
            "python-sdk-init",
            "python-sdk-observe",
        ],
        DOCS_DIR / "tracing" / "typescript-sdk.mdx": [
            "typescript-sdk-init",
            "typescript-sdk-observe",
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
            f"Successfully synced {len(snippets)} snippets to docs/snippets/ and docs pages.",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
