from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap_dev_tools.py"


def load_bootstrap_dev_tools():
    spec = importlib.util.spec_from_file_location("bootstrap_dev_tools_test_module", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def set_windows_platform(module, monkeypatch):
    monkeypatch.setattr(module, "IS_WIN", True)
    monkeypatch.setattr(module, "IS_MAC", False)
    monkeypatch.setattr(module, "IS_LIN", False)


def test_msys2_candidates_only_include_standard_locations():
    module = load_bootstrap_dev_tools()

    assert module._msys2_candidates() == [
        Path("C:/msys64"),
        Path("C:/msys32"),
        Path("C:/tools/msys64"),
    ]


def test_install_tmux_prefers_existing_msys2(monkeypatch, tmp_path):
    module = load_bootstrap_dev_tools()
    set_windows_platform(module, monkeypatch)

    existing_root = tmp_path / "msys64"
    calls: list[tuple[str, Path | None]] = []

    monkeypatch.setattr(module, "section", lambda message: None)
    monkeypatch.setattr(module, "_find_msys2_root", lambda: existing_root)
    monkeypatch.setattr(
        module,
        "_tmux_via_existing_msys2",
        lambda root=None: calls.append(("existing", root)),
    )
    monkeypatch.setattr(
        module,
        "_tmux_via_winget_msys2",
        lambda: calls.append(("winget", None)),
    )

    module.install_tmux()

    assert calls == [("existing", existing_root)]


def test_install_tmux_requires_winget_when_msys2_missing(monkeypatch):
    module = load_bootstrap_dev_tools()
    set_windows_platform(module, monkeypatch)

    monkeypatch.setattr(module, "section", lambda message: None)
    monkeypatch.setattr(module, "_find_msys2_root", lambda: None)
    monkeypatch.setattr(
        module,
        "_tmux_via_winget_msys2",
        lambda: (_ for _ in ()).throw(RuntimeError("winget is required")),
    )

    with pytest.raises(RuntimeError, match="winget is required"):
        module.install_tmux()
