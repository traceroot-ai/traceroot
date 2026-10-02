"""Parity and drift tests between documentation and codebase contracts.

Guards against documentation drift for:
1. docs/docs.json navigation tree vs .mdx files on disk.
2. docs/integrations/overview.mdx vs the in-app picker (integrations.tsx) and fixtures.
3. docs/ai-agent/byok.mdx vs ADAPTER_MODELS in frontend/packages/core/src/llm-providers.ts.
4. CLI command reference in docs/cli/get-started.mdx vs public.json + placements.
5. docs/snippets/ and embedded doc code blocks vs runnable examples.
6. API reference configured with public.json in docs/docs.json.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"
FRONTEND_DIR = REPO_ROOT / "frontend"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def _extract_pages_from_docs_json(nav_node: Any) -> list[str]:
    """Recursively collect page paths from docs.json navigation."""
    pages: list[str] = []
    if isinstance(nav_node, dict):
        if "pages" in nav_node and isinstance(nav_node["pages"], list):
            for item in nav_node["pages"]:
                if isinstance(item, str):
                    pages.append(item)
                elif isinstance(item, dict):
                    pages.extend(_extract_pages_from_docs_json(item))
        for key, value in nav_node.items():
            if key != "pages" and isinstance(value, (dict, list)):
                pages.extend(_extract_pages_from_docs_json(value))
    elif isinstance(nav_node, list):
        for item in nav_node:
            pages.extend(_extract_pages_from_docs_json(item))
    return pages


def test_docs_json_mdx_parity() -> None:
    """Every page in docs.json exists as an .mdx file, and every non-hidden .mdx is in docs.json."""
    docs_json_path = DOCS_DIR / "docs.json"
    assert docs_json_path.exists(), f"Missing {docs_json_path.relative_to(REPO_ROOT)}"

    docs_json = json.loads(docs_json_path.read_text(encoding="utf-8"))
    navigation = docs_json.get("navigation", {})
    declared_pages = set(_extract_pages_from_docs_json(navigation))

    # Intentionally hidden / non-navigation pages:
    # docs/snippets/*.mdx are reusable components imported into other docs, not sidebar pages.
    allowed_hidden_dirs = {DOCS_DIR / "snippets"}

    disk_pages: set[str] = set()
    for mdx_path in DOCS_DIR.rglob("*.mdx"):
        if any(mdx_path.is_relative_to(hidden_dir) for hidden_dir in allowed_hidden_dirs):
            continue
        rel_str = str(mdx_path.relative_to(DOCS_DIR).with_suffix(""))
        disk_pages.add(rel_str)

    missing_on_disk = declared_pages - disk_pages
    extra_on_disk = disk_pages - declared_pages

    assert not missing_on_disk, (
        f"Pages declared in docs.json but missing from disk: {sorted(missing_on_disk)}"
    )
    assert not extra_on_disk, (
        f"MDX files on disk not declared in docs.json navigation: {sorted(extra_on_disk)}"
    )


def test_integrations_overview_parity() -> None:
    """The integrations in docs/integrations/overview.mdx match the in-app picker."""
    overview_path = DOCS_DIR / "integrations" / "overview.mdx"
    assert overview_path.exists(), f"Missing {overview_path.relative_to(REPO_ROOT)}"

    overview_content = overview_path.read_text(encoding="utf-8")
    # Match href="/integrations/<id>"
    docs_integrations = set(re.findall(r'href="/integrations/([a-zA-Z0-9-]+)"', overview_content))
    # Exclude internal-models link which is a general page, not a provider card
    docs_integrations.discard("internal-models")

    # In-app picker source
    picker_path = (
        FRONTEND_DIR
        / "ui"
        / "src"
        / "features"
        / "traces"
        / "components"
        / "GettingStarted"
        / "integrations.tsx"
    )
    assert picker_path.exists(), f"Missing {picker_path.relative_to(REPO_ROOT)}"

    picker_content = picker_path.read_text(encoding="utf-8")
    picker_integrations = set(re.findall(r'id:\s*"([a-zA-Z0-9-]+)"', picker_content))

    missing_in_docs = picker_integrations - docs_integrations
    extra_in_docs = docs_integrations - picker_integrations

    assert not missing_in_docs, (
        f"Integrations in in-app picker missing from docs/integrations/overview.mdx: {sorted(missing_in_docs)}"
    )
    assert not extra_in_docs, (
        f"Integrations in docs/integrations/overview.mdx missing from in-app picker: {sorted(extra_in_docs)}"
    )

    # Check vendored Python integration enum fixture
    py_fixture = FIXTURES_DIR / "python-integrations.json"
    if py_fixture.exists():
        py_data = json.loads(py_fixture.read_text(encoding="utf-8"))
        py_integrations = {i.replace("_", "-") for i in py_data.get("integrations", [])}
        # Python enum names to doc page slug mappings
        py_slug_aliases = {
            "agent-framework": "microsoft-agent-framework",
            "google-genai": "gemini",
            "llama-index": "llamaindex",
            "openai-agents": "openai-agents-sdk",
        }
        py_mapped = {py_slug_aliases.get(s, s) for s in py_integrations}
        known_docs_or_native = docs_integrations | {
            "python-sdk",
            "typescript-sdk",
            "groq",
            "bedrock",
        }
        unexpected_py = py_mapped - known_docs_or_native
        assert not unexpected_py, (
            f"Python Integration enum entries not documented in docs or known aliases: {sorted(unexpected_py)}"
        )


def test_byok_models_parity() -> None:
    """The models listed in docs/ai-agent/byok.mdx match ADAPTER_MODELS in llm-providers.ts."""
    llm_providers_path = FRONTEND_DIR / "packages" / "core" / "src" / "llm-providers.ts"
    assert llm_providers_path.exists(), f"Missing {llm_providers_path.relative_to(REPO_ROOT)}"

    source = llm_providers_path.read_text(encoding="utf-8")
    start_idx = source.find("export const ADAPTER_MODELS")
    assert start_idx != -1, "Could not find ADAPTER_MODELS declaration in llm-providers.ts"
    end_idx = source.find("\n};", start_idx)
    adapter_models_str = source[start_idx:end_idx]

    code_model_ids = set(re.findall(r'id:\s*"([^"]+)"', adapter_models_str))
    assert len(code_model_ids) > 0, "No model IDs parsed from ADAPTER_MODELS"

    byok_path = DOCS_DIR / "ai-agent" / "byok.mdx"
    assert byok_path.exists(), f"Missing {byok_path.relative_to(REPO_ROOT)}"

    byok_content = byok_path.read_text(encoding="utf-8")
    # Models table is under ## Default Models
    models_table_match = re.search(r"## Default Models.*?(?=##|\Z)", byok_content, re.DOTALL)
    assert models_table_match, (
        "Could not find '## Default Models' section in docs/ai-agent/byok.mdx"
    )

    models_section = models_table_match.group(0)
    docs_model_ids = set(re.findall(r"`([a-zA-Z0-9.-]+)`", models_section))

    missing_models = code_model_ids - docs_model_ids
    extra_models = docs_model_ids - code_model_ids

    assert not missing_models, (
        f"Missing models in docs/ai-agent/byok.mdx from ADAPTER_MODELS: {sorted(missing_models)}"
    )
    assert not extra_models, (
        f"Extra models in docs/ai-agent/byok.mdx not in ADAPTER_MODELS: {sorted(extra_models)}"
    )


def test_cli_reference_parity() -> None:
    """CLI reference in docs/cli/get-started.mdx must match generated output."""
    script_path = REPO_ROOT / "scripts" / "sync_cli_reference.py"
    assert script_path.exists(), f"Missing {script_path.relative_to(REPO_ROOT)}"

    result = subprocess.run(
        [sys.executable, str(script_path), "--check"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"CLI reference is out of sync:\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_snippets_drift_parity() -> None:
    """Doc snippets in docs/snippets/ and docs pages must match examples/."""
    script_path = REPO_ROOT / "scripts" / "sync_doc_snippets.py"
    assert script_path.exists(), f"Missing {script_path.relative_to(REPO_ROOT)}"

    result = subprocess.run(
        [sys.executable, str(script_path), "--check"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"Doc snippets are out of sync with examples/:\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_public_openapi_reference() -> None:
    """docs/docs.json references backend/rest/openapi/public.json for API reference."""
    docs_json_path = DOCS_DIR / "docs.json"
    docs_json = json.loads(docs_json_path.read_text(encoding="utf-8"))

    api_config = docs_json.get("api")
    assert api_config is not None, "Missing 'api' key in docs/docs.json"
    assert "openapi" in api_config, "Missing 'openapi' path in docs/docs.json 'api' config"

    openapi_rel_path = api_config["openapi"]
    target_openapi = (DOCS_DIR / openapi_rel_path).resolve()
    assert target_openapi.exists(), (
        f"Referenced OpenAPI spec does not exist: {target_openapi.relative_to(REPO_ROOT)}"
    )
