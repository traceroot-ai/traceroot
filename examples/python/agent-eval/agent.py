"""
Tool-using research agent (pydantic-ai) — the system under evaluation.

Exposes `run_agent`, which answers a question by calling tools over FIXED data, so
every question has an exact ground-truth answer (NVDA is 495.20, a 10% rise 544.72).
"""

from pydantic_ai import Agent

# ---------------------------------------------------------------------------
# Agent & tools
# ---------------------------------------------------------------------------
# Deterministic settings (temperature=0) so the same question yields the same
# tool calls and answer from run to run.

agent = Agent(
    "openai-chat:gpt-4o-mini",
    model_settings={"temperature": 0.0},
    system_prompt=(
        "You are a financial research assistant. Use the available tools to look "
        "up stock prices and to perform any arithmetic. Never compute prices or do "
        "math from memory — always call the calculate tool. Report concrete numbers "
        "and keep your answer concise."
    ),
)

# Fixed prices — the ground truth the dataset is written against.
_STOCKS = {
    "AAPL": {"price": 178.50, "change": +2.30, "percent": "+1.3%"},
    "GOOGL": {"price": 141.20, "change": -0.80, "percent": "-0.6%"},
    "MSFT": {"price": 378.90, "change": +4.50, "percent": "+1.2%"},
    "NVDA": {"price": 495.20, "change": +12.30, "percent": "+2.5%"},
    "META": {"price": 512.40, "change": +8.10, "percent": "+1.6%"},
}


@agent.tool_plain
def get_stock_price(symbol: str) -> dict:
    """Get the current stock price for a ticker symbol."""
    data = _STOCKS.get(symbol.upper(), {"price": 0.0, "change": 0.0, "percent": "N/A"})
    return {"symbol": symbol.upper(), **data}


@agent.tool_plain
def calculate(expression: str) -> dict:
    """Evaluate a mathematical expression safely."""
    import ast
    import operator

    ops = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
    }

    def _eval(node):
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            return ops[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -_eval(node.operand)
        raise ValueError(f"Unsupported expression: {ast.dump(node)}")

    try:
        result = _eval(ast.parse(expression, mode="eval"))
        return {"expression": expression, "result": result}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Clean callable for callers (and for the eval task)
# ---------------------------------------------------------------------------


def _inspect_run(result) -> tuple[list[str], int]:
    """Pull the tools called and the number of model steps from a run result.

    Duck-typed against pydantic-ai's message parts so it survives minor version
    changes: a tool call is any part whose ``part_kind`` is ``"tool-call"``; a
    model step is any message that carried a text or tool-call part.
    """
    tools_used: list[str] = []
    steps = 0
    for message in result.all_messages():
        produced_output = False
        for part in getattr(message, "parts", []):
            kind = getattr(part, "part_kind", "")
            if kind == "tool-call":
                name = getattr(part, "tool_name", None)
                if name and name not in tools_used:
                    tools_used.append(name)
                produced_output = True
            elif kind == "text":
                produced_output = True
        if produced_output:
            steps += 1
    return tools_used, steps


def run_agent(input: dict) -> dict:
    """Answer a question with the tool agent.

    input:  {"question": "<a question whose answer is an exact value>"}
    output: {"answer": <str>, "tools_used": <list[str]>, "steps": <int>}
    """
    question = input["question"]
    result = agent.run_sync(question)
    tools_used, steps = _inspect_run(result)
    return {
        "answer": str(result.output),
        "tools_used": tools_used,
        "steps": steps,
    }
