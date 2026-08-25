"""
Dataset for the tool-agent eval.

A dataset file is a checkable artifact. Each case here is given an EXPLICIT id
(`single-stock-lookup`, ...) that is byte-identical to its twin in the TypeScript
dataset, so the two SDKs' cases pair one-for-one regardless of any content
differences. (Without an explicit id the SDK content-addresses a case as `tc_` +
sha256 over the case's INPUT only — not its `expected` — so the snake_case vs
camelCase tool names below would NOT have split the ids; pinning explicit ids just
makes that pairing guaranteed and obvious rather than incidental.) The dataset's
own id is `ds_` + sha256 over its key.

This dataset is deliberately kept PARALLEL with the TypeScript one in
`examples/typescript/agent-eval/dataset.ts`: the four questions and their expected
`facts` are identical; only the `tools` names differ, because each SDK names its
tools idiomatically (`get_stock_price` here, `getStockPrice` there). Running both
with the same dataset name + key + `evaluation_key` — and the shared explicit case
ids — makes the two runs converge into ONE diffable history on the platform.

(This file is NOT byte-identical to the TypeScript one — different language, and
tool names differ — but it is its deliberate mirror, and the case ids match.)
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
