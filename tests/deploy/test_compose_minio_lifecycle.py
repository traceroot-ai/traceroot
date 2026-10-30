"""Guards on the lifecycle rules minio-init applies to the bundled MinIO bucket.

Raw ingest batches are only needed until the worker has processed them, so
without an expiry the bucket grows with every batch ever sent. Nothing in CI
starts MinIO, so these tests check the rules file itself and run minio-init's
entrypoint, as compose spells it, against a stub `mc`.
"""

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_LIFECYCLE = _ROOT / "docker" / "minio" / "lifecycle.json"
_COMPOSE = [_ROOT / "docker-compose.yml"]

# Stands in for `mc`. `ilm rule import` replaces the bucket's whole lifecycle config
# with stdin, as the real command does. Any other `ilm` use fails, so an entrypoint
# change that reaches for a different subcommand cannot pass unnoticed.
_MC_STUB = """#!/bin/sh
printf '%s\\n' "$*" >> "$STATE/calls.log"
case "$1" in
  alias|mb) exit 0 ;;
esac
if [ "$1 $2 $3" = "ilm rule import" ]; then
  if [ -n "$MC_ILM_FAILS" ]; then
    cat > /dev/null
    exit 1
  fi
  cat > "$STATE/lifecycle-$(printf '%s' "$4" | tr / _).json"
  exit 0
fi
echo "unexpected mc call: $*" >&2
exit 2
"""


def _minio_init(compose_path: Path) -> dict:
    return yaml.safe_load(compose_path.read_text())["services"]["minio-init"]


def _run_minio_init(compose_path: Path, tmp_path: Path, **env: str) -> subprocess.CompletedProcess:
    """Run minio-init's entrypoint as compose would, with its mounts under tmp_path.

    Compose unescapes `$$` and splits the entrypoint string into argv; this does the
    same, then points each mounted container path at a copy of its host file.
    """
    spec = _minio_init(compose_path)
    argv = shlex.split(spec["entrypoint"].replace("$$", "$"))
    assert argv[:2] == ["/bin/sh", "-c"], argv[:2]
    script = argv[2]

    mounts, bin_dir, state = (tmp_path / d for d in ("mounts", "bin", "state"))
    for d in (mounts, bin_dir, state):
        d.mkdir(parents=True, exist_ok=True)
    for volume in spec["volumes"]:
        host, container = volume.split(":")[:2]
        copy = mounts / Path(container).name
        shutil.copy(compose_path.parent / host, copy)
        script = script.replace(container, shlex.quote(str(copy)))

    stub = bin_dir / "mc"
    stub.write_text(_MC_STUB)
    stub.chmod(0o755)

    return subprocess.run(
        ["sh", "-c", script],
        env={"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "STATE": str(state), **env},
        capture_output=True,
        text=True,
    )


def test_rules_expire_only_ingest_batches():
    """7 days for raw batches, 30 for failed ones, and nothing else.

    A rule without a prefix would apply to the whole bucket, attachments included.
    """
    rules = json.loads(_LIFECYCLE.read_text())["Rules"]

    assert {r["Filter"]["Prefix"]: r["Expiration"]["Days"] for r in rules} == {
        "events/otel/": 7,
        "events/failed/": 30,
    }
    assert all(r["Status"] == "Enabled" for r in rules)
    assert len({r["ID"] for r in rules}) == len(rules), "rule IDs must be unique"


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_mounts_the_rules_file(compose_path):
    hosts = [
        (compose_path.parent / v.split(":")[0]).resolve()
        for v in _minio_init(compose_path)["volumes"]
    ]
    assert _LIFECYCLE in hosts


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_running_minio_init_twice_leaves_the_same_two_rules(compose_path, tmp_path):
    """Every start re-applies the rules, so a second run must not add to them."""
    for _ in range(2):
        run = _run_minio_init(compose_path, tmp_path)
        assert run.returncode == 0, run.stderr
        assert run.stderr == ""

    applied = json.loads((tmp_path / "state" / "lifecycle-myminio_traceroot.json").read_text())
    assert applied == json.loads(_LIFECYCLE.read_text())
    assert len(applied["Rules"]) == 2

    # The rules go to the bucket minio-init creates, after it is created.
    calls = (tmp_path / "state" / "calls.log").read_text().splitlines()
    assert calls.count("mb myminio/traceroot --ignore-existing") == 2
    assert calls.count("ilm rule import myminio/traceroot") == 2
    assert calls.index("mb myminio/traceroot --ignore-existing") < calls.index(
        "ilm rule import myminio/traceroot"
    )


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_lifecycle_failure_is_logged_without_failing_minio_init(compose_path, tmp_path):
    run = _run_minio_init(compose_path, tmp_path, MC_ILM_FAILS="1")

    assert run.returncode == 0, run.stderr
    assert "could not apply the bucket lifecycle rules" in run.stdout
