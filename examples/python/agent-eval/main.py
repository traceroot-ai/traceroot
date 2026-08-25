"""
Offline eval for the tool agent.

Points three scorers at the agent from `agent.py` over the dataset in
`dataset.py`, runs every case, and reports the run to TraceRoot.

Run:
    cp .env.example .env   # fill in your keys
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
    # or:  pip install -r requirements.txt && python main.py

No creds? This runs locally on its own: with no TRACEROOT_API_KEY set, `main()`
passes local=True to evaluate() so the eval runs in full and reports nowhere.
"""

import os

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

# Initialize TraceRoot BEFORE importing the agent so pydantic-ai is instrumented.
import traceroot
from traceroot import Integration, Scorer, evaluate

traceroot.initialize(integrations=[Integration.PYDANTIC_AI])

from agent import run_agent
from dataset import dataset, mentions

# ── Scorers ─────────────────────────────────────────────────────────────────


@Scorer.code(
    key="calls_expected_tools",
    value_type="numeric",
    direction="higher_is_better",
    threshold=1.0,
)
def calls_expected_tools(ctx):
    """Fraction of the expected tools the agent actually called."""
    expected = ctx.expected["tools"]
    used = set(ctx.output.get("tools_used", []))
    if not expected:
        return 1.0
    return sum(tool in used for tool in expected) / len(expected)


@Scorer.code(
    key="reports_expected_facts",
    value_type="numeric",
    direction="higher_is_better",
    threshold=1.0,
)
def reports_expected_facts(ctx):
    """Fraction of the expected facts the answer states (number-matched)."""
    facts = ctx.expected["facts"]
    answer = ctx.output.get("answer", "")
    if not facts:
        return 1.0
    return sum(mentions(answer, fact) for fact in facts) / len(facts)


answer_is_grounded = Scorer.llm_judge(
    name="answer_is_grounded",
    model="claude-haiku-4-5",
    messages=[
        {
            "role": "system",
            "content": (
                "You grade whether an ANSWER gives concrete, specific values for "
                "the TASK. Reply with exactly 1.0 if the answer states concrete "
                "numbers that address the task, or 0.0 if it is empty, hedged, or "
                "refuses. Reply with only the number."
            ),
        },
        {"role": "user", "content": "TASK:\n{{input}}\n\nANSWER:\n{{output}}"},
    ],
    value_type="numeric",
    threshold=1.0,
)


# ── Run ─────────────────────────────────────────────────────────────────────


def main() -> None:
    # No TraceRoot key? Run locally — execute every case in full but report
    # nowhere — so a fresh clone works without a TraceRoot credential.
    local = not os.getenv("TRACEROOT_API_KEY")
    result = evaluate(
        name="Agent tool eval",
        dataset=dataset(),
        task=run_agent,
        scorers=[calls_expected_tools, reports_expected_facts, answer_is_grounded],
        candidate_version="gpt-4o-mini",
        evaluation_key="agent-tool-eval",
        local=local,
    )
    print(result.summary())

    upload = getattr(result, "upload_state", None)
    url = getattr(upload, "dashboard_url", None)
    if url:
        print(f"\nView the run: {url}")


if __name__ == "__main__":
    main()
