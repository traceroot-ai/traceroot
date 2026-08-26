"""
Dataset for the tool-agent eval — four tool-use cases with exact expected facts.

Kept PARALLEL with the TypeScript dataset in
`examples/typescript/agent-eval/dataset.ts`: same questions and `facts`, only the
tool names differ per SDK idiom (`get_stock_price` here, `getStockPrice` there).
Each case has an EXPLICIT id matching its twin one-for-one, so running both under
the same name + key + `evaluation_key` converges into ONE diffable history.
"""

import re

from traceroot import Dataset

DATASET_NAME = "Agent tool eval"
DATASET_KEY = "agent-tool-eval"


def dataset() -> Dataset:
    """Build the tool-use dataset with four cases and exact expected facts."""
    ds = Dataset(DATASET_NAME, key=DATASET_KEY)

    # 1. Single stock lookup. NVDA is fixed at 495.20.
    ds.add(
        {"question": "What is the current stock price of NVDA?"},
        expected={"tools": ["get_stock_price"], "facts": [495.20]},
        id="single-stock-lookup",
    )

    # 2. Lookup + calculation. 495.20 x 1.1 = 544.72.
    ds.add(
        {
            "question": "NVDA is climbing. If it rises 10% from its current price, "
            "what would the new price be?"
        },
        expected={"tools": ["get_stock_price", "calculate"], "facts": [544.72]},
        id="stock-rise-percent",
    )

    # 3. Two lookups, no math. NVDA 495.20 and MSFT 378.90.
    ds.add(
        {"question": "Compare the current prices of NVDA and MSFT. Give both numbers."},
        expected={"tools": ["get_stock_price"], "facts": [495.20, 378.90]},
        id="two-stock-compare",
    )

    # 4. Lookup + calculation. 3 x 378.90 = 1136.70.
    ds.add(
        {"question": "How much would 3 shares of MSFT cost at the current price?"},
        expected={"tools": ["get_stock_price", "calculate"], "facts": [1136.70]},
        id="shares-total-cost",
    )

    return ds


def mentions(text, value) -> bool:
    """True if `text` contains the number `value`.

    Tolerates formatting: thousands separators are stripped, and trailing-zero
    differences match (1136.7, 1136.70, "$1,136.70" all match 1136.70).
    """
    cleaned = str(text).replace(",", "")
    for token in re.findall(r"-?\d+\.?\d*", cleaned):
        try:
            if abs(float(token) - float(value)) < 1e-6:
                return True
        except ValueError:
            continue
    return False
