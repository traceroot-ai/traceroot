"""
DSPy chain-of-thought QA agent, instrumented with TraceRoot.

Usage:
    cp .env.example .env
    pip install -r requirements.txt
    python main.py
"""

import logging

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

import dspy

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.DSPY])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# DSPy configuration
# ---------------------------------------------------------------------------

# DSPy resolves the API key from OPENAI_API_KEY in the environment.
# `cache=False` disables DSPy's local response cache so every run produces
# real LLM latency in the trace — useful for the demo, drop the flag in
# production to take advantage of caching.
LM = dspy.LM("openai/gpt-4o-mini", max_tokens=1024, cache=False)
dspy.configure(lm=LM)


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------


class CoTQA(dspy.Module):
    """A minimal chain-of-thought question-answering module.

    The signature `question -> answer` tells DSPy to produce both an
    intermediate reasoning chain and a final answer field; with
    `ChainOfThought`, the reasoning is added to the prompt automatically.
    """

    def __init__(self):
        super().__init__()
        self.cot = dspy.ChainOfThought("question -> answer")

    def forward(self, question: str):
        return self.cot(question=question)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

DEMO_QUESTIONS = [
    "If a train leaves city A at 9am traveling 60 mph and another leaves "
    "city B at 10am traveling 80 mph toward A, and the cities are 280 miles "
    "apart, at what time do they meet?",
    "Why does ice float on water?",
    "A farmer has 17 sheep, all but 9 die. How many are left?",
]


@observe(name="dspy_cot_demo", type="agent")
def run_demo():
    qa = CoTQA()
    for i, question in enumerate(DEMO_QUESTIONS, 1):
        print(f"\n{'=' * 60}")
        print(f"Q{i}: {question}")
        print("=" * 60)
        result = qa(question=question)
        print(f"\nReasoning: {result.reasoning}")
        print(f"Answer: {result.answer}\n")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="dspy-cot-session"):
        run_demo()
    traceroot.flush()
