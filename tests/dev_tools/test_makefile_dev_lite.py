import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def make_dev_lite_plan() -> str:
    result = subprocess.run(
        ["make", "-n", "dev-lite"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout


def test_dev_lite_warns_when_host_frontend_deps_are_missing():
    output = make_dev_lite_plan()

    assert "test -d frontend/node_modules" in output
    assert "pnpm --dir frontend install" in output
    assert "VS Code/TypeScript support" in output


def test_dev_lite_still_uses_docker_compose_directly():
    output = make_dev_lite_plan()

    assert "docker compose -f docker-compose.prod.yml up --build" in output
