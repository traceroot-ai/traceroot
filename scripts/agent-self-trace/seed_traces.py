"""Seed the local TraceRoot project with agent traces.

Three runs: two that a Failure / Hallucination detector should flag (a tool that
throws and a lookup that comes back empty, with the model answering confidently
anyway) and one clean control run.
"""

import json
import random

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.OPENAI])

from openai import OpenAI  # noqa: E402  (must come after initialize)

client = OpenAI()
MODEL = "gpt-5.4-mini"

ORDERS = {"A-1001": {"status": "delivered", "eta": "2026-08-20"}}


@observe(name="lookup_order", type="tool")
def lookup_order(order_id: str) -> str:
    # The bug we want the RCA agent to find: the index is built from a stale
    # snapshot, so any order not in it raises instead of returning "unknown".
    return json.dumps(ORDERS[order_id])


@observe(name="search_refund_policy", type="tool")
def search_refund_policy(query: str) -> str:
    # Retrieval regression: the index came back empty for every query.
    return json.dumps({"results": []})


@observe(name="get_weather", type="tool")
def get_weather(city: str) -> str:
    return json.dumps({"city": city, "temp_c": 19, "condition": "cloudy"})


SYSTEM = (
    "You are OrderBot, a customer support agent. Answer the customer directly and "
    "confidently in 2-3 sentences. Never say you are unsure, never tell the customer "
    "to contact support, and never mention tools or internal errors."
)


def _call_model(messages):
    return client.chat.completions.create(model=MODEL, messages=messages)


@observe(name="support_agent", type="agent")
def support_agent(question: str, tool_call) -> str:
    try:
        tool_output = tool_call()
    except Exception as exc:
        tool_output = f"ERROR: {type(exc).__name__}: {exc}"

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": question},
        {"role": "assistant", "content": f"[internal tool result] {tool_output}"},
        {"role": "user", "content": "Please give me the final answer now."},
    ]
    resp = _call_model(messages)
    answer = resp.choices[0].message.content
    print(f"  tool -> {tool_output[:90]}")
    print(f"  answer -> {answer[:160]}\n")
    return answer


RUNS = [
    (
        "broken-tool",
        "Where is my order A-9999? I ordered it three weeks ago.",
        lambda: lookup_order("A-9999"),
    ),
    (
        "empty-retrieval",
        "What is your refund policy for opened electronics?",
        lambda: search_refund_policy("refund policy opened electronics"),
    ),
    ("clean", "What is the weather in Berlin today?", lambda: get_weather("Berlin")),
]


def main() -> None:
    for label, question, tool_call in RUNS:
        print(f"== run: {label}")
        with using_attributes(
            user_id=f"cust-{random.randint(1000, 9999)}",
            session_id=f"support-{label}",
            tags=["support", label],
            metadata={"scenario": label},
        ):
            support_agent(question, tool_call)
    print("done; flushing spans...")


if __name__ == "__main__":
    main()
