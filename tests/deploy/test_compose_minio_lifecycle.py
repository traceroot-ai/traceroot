"""Guards on minio-init: the credentials it signs in with, the bucket it sets up,
and the lifecycle rules it applies to that bucket on the bundled MinIO.

Raw ingest batches are only needed until the worker has processed them, so
without an expiry the bucket grows with every batch ever sent. Nothing in CI
starts MinIO, so these tests check the rules file itself and run minio-init's
entrypoint, as compose spells it, against a stub `mc`.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from shared.config import S3Settings

_ROOT = Path(__file__).resolve().parents[2]
_LIFECYCLE = _ROOT / "docker" / "minio" / "lifecycle.json"
_COMPOSE = [_ROOT / "docker-compose.yml", _ROOT / "docker-compose.prod.yml"]

# Stands in for `mc`. `alias set` writes its arguments one per line, so a test can tell
# how the shell split them, and fails when MC_ALIAS_FAILS is set, as the real one
# does when MinIO rejects the credentials. `ilm rule import` replaces the bucket's
# whole lifecycle config with stdin, as the real command does. Any other `ilm` use
# fails, so an entrypoint change that reaches for a different subcommand cannot pass
# unnoticed.
_MC_STUB = """#!/bin/sh
printf '%s\\n' "$*" >> "$STATE/calls.log"
case "$1" in
  alias)
    printf '%s\\n' "$@" > "$STATE/alias-args"
    [ -z "$MC_ALIAS_FAILS" ] || exit 1
    exit 0 ;;
  mb) exit 0 ;;
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


_INTERPOLATION = re.compile(r"\$\$|\$\{(\w+):([-?])([^}]*)\}")

# How a service gets the bucket name: S3_BUCKET_NAME from the host, else the API's default.
_BUCKET_NAME = "${S3_BUCKET_NAME:-" + S3Settings.model_fields["bucket_name"].default + "}"


def _services(compose_path: Path) -> dict:
    return yaml.safe_load(compose_path.read_text())["services"]


def _minio_init(compose_path: Path) -> dict:
    return _services(compose_path)["minio-init"]


def _interpolate(value: str, host_env: dict[str, str]) -> str:
    """Resolve `value` as compose does.

    `$$` is a literal `$` left for the container's shell, `${NAME:-default}` is NAME
    from the host, or the default when NAME is unset or empty, and `${NAME:?message}`
    is NAME from the host, which must be set.
    """
    assert "$" not in _INTERPOLATION.sub("", value), f"unsupported interpolation: {value}"

    def resolve(m: re.Match) -> str:
        if m[0] == "$$":
            return "$"
        if m[2] == "?":
            assert host_env.get(m[1]), f"{m[1]} is required: {m[3]}"
            return host_env[m[1]]
        return host_env.get(m[1]) or m[3]

    return _INTERPOLATION.sub(resolve, value)


def _run_minio_init(
    compose_path: Path, tmp_path: Path, host_env: dict[str, str] | None = None, **stub_env: str
) -> subprocess.CompletedProcess:
    """Run minio-init's entrypoint as compose would, with its mounts under tmp_path.

    Compose interpolates the entrypoint string and splits it into argv; this does
    the same, then points each mounted container path at a copy of its host file.
    The container gets only the service's `environment:` block, interpolated against
    `host_env`, the variables compose reads from the shell or `.env`. The script
    runs in tmp_path, so a glob it leaves unquoted matches only files a test made.
    """
    spec = _minio_init(compose_path)
    # The production file requires the root password; the dev file defaults it.
    host_env = {"MINIO_ROOT_PASSWORD": "operator-chosen", **(host_env or {})}
    container_env = {
        name: _interpolate(value, host_env) for name, value in spec.get("environment", {}).items()
    }
    argv = shlex.split(_interpolate(spec["entrypoint"], host_env))
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
        env={
            **container_env,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "STATE": str(state),
            **stub_env,
        },
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )


def test_rules_expire_only_ingest_batches():
    """7 days for raw batches, 30 for failed ones, and nothing else.

    A rule without a prefix would apply to the whole bucket, attachments included.
    """
    rules = json.loads(_LIFECYCLE.read_text())["Rules"]

    assert {r["Filter"]["Prefix"]: r["Expiration"]["Days"] for r in rules} == {
        "events/ingest/": 7,
        "events/failed/": 30,
    }
    assert all(r["Status"] == "Enabled" for r in rules)
    assert len({r["ID"] for r in rules}) == len(rules), "rule IDs must be unique"


def test_no_rule_reaches_batches_under_events_otel():
    """No rule expires a batch under events/otel/.

    A rule applies to every key that starts with its prefix, and a rule with no
    prefix applies to the whole bucket.
    """
    for rule in json.loads(_LIFECYCLE.read_text())["Rules"]:
        prefix = rule.get("Filter", {}).get("Prefix", "")
        assert not "events/otel/x".startswith(prefix), rule["ID"]


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_mounts_the_rules_file(compose_path):
    hosts = [
        (compose_path.parent / v.split(":")[0]).resolve()
        for v in _minio_init(compose_path)["volumes"]
    ]
    assert _LIFECYCLE in hosts


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_lifecycle_failure_is_logged_without_failing_minio_init(compose_path, tmp_path):
    run = _run_minio_init(compose_path, tmp_path, MC_ILM_FAILS="1")

    assert run.returncode == 0, run.stderr
    assert "could not apply the bucket lifecycle rules" in run.stdout


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_gets_the_root_credentials_minio_starts_with(compose_path):
    """The entrypoint reads the credentials from minio-init's own environment.

    Without them it signs in with empty values, and the bucket never gets its rules.
    """
    services = _services(compose_path)
    init_env = services["minio-init"].get("environment", {})
    for name in ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"):
        assert init_env.get(name) == services["minio"]["environment"][name], name


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_reads_the_bucket_name_the_services_use(compose_path):
    """minio-init reads S3_BUCKET_NAME the same way, and with the same default, as
    every service in the file that uses the bucket.

    docker-compose.yml runs no API or worker. Those run on the host, read the same
    `.env` that compose interpolates from, and fall back to the API's default.
    """
    readers = {
        name: service["environment"]["S3_BUCKET_NAME"]
        for name, service in _services(compose_path).items()
        if "S3_BUCKET_NAME" in (service.get("environment") or {})
    }

    assert readers.pop("minio-init", None) == _BUCKET_NAME
    assert set(readers.values()) <= {_BUCKET_NAME}, readers


@pytest.mark.parametrize(
    ("host_env", "bucket"),
    [({}, "traceroot"), ({"S3_BUCKET_NAME": "team-traces"}, "team-traces")],
    ids=["default", "custom"],
)
@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_sets_up_the_bucket_named_by_s3_bucket_name(
    compose_path, host_env, bucket, tmp_path
):
    """Both the bucket and its rules follow S3_BUCKET_NAME, so the rules land on the
    bucket the services use."""
    run = _run_minio_init(compose_path, tmp_path, host_env=host_env)

    assert run.returncode == 0, run.stderr
    assert run.stderr == ""
    calls = (tmp_path / "state" / "calls.log").read_text().splitlines()
    assert calls[1:] == [
        f"mb myminio/{bucket} --ignore-existing",
        f"ilm rule import myminio/{bucket}",
    ]
    applied = json.loads((tmp_path / "state" / f"lifecycle-myminio_{bucket}.json").read_text())
    assert applied == json.loads(_LIFECYCLE.read_text())


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_signs_in_with_changed_credentials(compose_path, tmp_path):
    run = _run_minio_init(
        compose_path,
        tmp_path,
        host_env={"MINIO_ROOT_USER": "operator", "MINIO_ROOT_PASSWORD": "not-the-default"},
    )

    assert run.returncode == 0, run.stderr
    calls = (tmp_path / "state" / "calls.log").read_text().splitlines()
    assert calls[0] == "alias set myminio http://minio:9000 operator not-the-default"
    assert "ilm rule import myminio/traceroot" in calls


@pytest.mark.parametrize("password", ["two words", "start*"], ids=["space", "glob"])
@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_minio_init_passes_each_credential_as_one_argument(compose_path, password, tmp_path):
    """Unquoted, `sh` splits a password at whitespace and expands a glob in it."""
    (tmp_path / "start-here").touch()  # what `start*` would expand to

    run = _run_minio_init(
        compose_path,
        tmp_path,
        host_env={"MINIO_ROOT_USER": "operator", "MINIO_ROOT_PASSWORD": password},
    )

    assert run.returncode == 0, run.stderr
    args = (tmp_path / "state" / "alias-args").read_text().splitlines()
    assert args == ["alias", "set", "myminio", "http://minio:9000", "operator", password]


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_failed_sign_in_is_logged_and_skips_the_bucket(compose_path, tmp_path):
    """A failed sign-in stops minio-init before the bucket steps.

    Without the alias, `mc mb myminio/traceroot` would create a local directory and
    report success, and the rules would never reach the bucket.
    """
    run = _run_minio_init(compose_path, tmp_path, MC_ALIAS_FAILS="1")

    assert run.returncode == 0, run.stderr
    assert "could not sign in to MinIO" in run.stdout
    calls = (tmp_path / "state" / "calls.log").read_text().splitlines()
    assert [call.split()[0] for call in calls] == ["alias"]
