"""Parity guard for the detector quiescence delay shared across runtimes."""

import re
from pathlib import Path

from worker.detector_tasks import EVALUATOR_DELAY as PYTHON_EVALUATOR_DELAY

ROOT = Path(__file__).resolve().parents[2]
TS_QUEUE_FILE = ROOT / "frontend/worker/src/queues/detector-run-queue.ts"


def test_python_and_typescript_evaluator_delay_match():
    """Python enqueues with the same delay the TypeScript worker waits for."""
    source = TS_QUEUE_FILE.read_text()
    match = re.search(r"export\s+const\s+EVALUATOR_DELAY\s*=\s*([\d_]+)", source)

    assert match is not None, "Could not find TypeScript EVALUATOR_DELAY export"
    typescript_delay = int(match.group(1).replace("_", ""))

    assert typescript_delay == PYTHON_EVALUATOR_DELAY
