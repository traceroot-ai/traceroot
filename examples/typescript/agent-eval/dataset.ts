/**
 * Dataset for the tool-agent eval.
 *
 * A dataset file is a checkable artifact. Each case here is given an EXPLICIT id
 * (`single-stock-lookup`, ...) that is byte-identical to its twin in the Python
 * dataset, so the two SDKs' cases pair one-for-one regardless of any content
 * differences. (Without an explicit id the SDK content-addresses a case as `tc_` +
 * sha256 over the case's INPUT only — not its `expected` — so the camelCase vs
 * snake_case tool names below would NOT have split the ids; pinning explicit ids
 * just makes that pairing guaranteed and obvious rather than incidental.) The
 * dataset's own id is `ds_` + sha256 over its key.
 *
 * This dataset is deliberately kept PARALLEL with the Python one in
 * `examples/python/agent-eval/dataset.py`: the four questions and their expected
 * `facts` are identical; only the `tools` names differ, because each SDK names
 * its tools idiomatically (`getStockPrice` here, `get_stock_price` there).
 * Running both with the same dataset name + key + `evaluationKey` — and the shared
 * explicit case ids — makes the two runs converge into ONE diffable history.
 *
 * (This file is NOT byte-identical to the Python one — different language, and
 * tool names differ — but it is its deliberate mirror, and the case ids match.)
 */

import { Dataset } from '@traceroot-ai/traceroot';

export const DATASET_NAME = 'Agent tool eval';
export const DATASET_KEY = 'agent-tool-eval';

export function dataset(): Dataset {
  const ds = new Dataset(DATASET_NAME, null, { key: DATASET_KEY });

  // 1. Single stock lookup. NVDA is fixed at 495.20.
  ds.add(
    { question: 'What is the current stock price of NVDA?' },
    { expected: { tools: ['getStockPrice'], facts: [495.2] }, id: 'single-stock-lookup' },
  );

  // 2. Lookup + calculation. 495.20 x 1.1 = 544.72.
  ds.add(
    {
      question:
        'NVDA is climbing. If it rises 10% from its current price, what would the new price be?',
    },
    { expected: { tools: ['getStockPrice', 'calculate'], facts: [544.72] }, id: 'stock-rise-percent' },
  );

  // 3. Two lookups, no math. NVDA 495.20 and MSFT 378.90.
  ds.add(
    { question: 'Compare the current prices of NVDA and MSFT. Give both numbers.' },
    { expected: { tools: ['getStockPrice'], facts: [495.2, 378.9] }, id: 'two-stock-compare' },
  );

  // 4. Lookup + calculation. 3 x 378.90 = 1136.70.
  ds.add(
    { question: 'How much would 3 shares of MSFT cost at the current price?' },
    { expected: { tools: ['getStockPrice', 'calculate'], facts: [1136.7] }, id: 'shares-total-cost' },
  );

  return ds;
}

/**
 * True if `text` contains the number `value`.
 *
 * Tolerates formatting: thousands separators are stripped, and trailing-zero
 * differences match (1136.7, 1136.70, "$1,136.70" all match 1136.70).
 */
export function mentions(text: string, value: number): boolean {
  const cleaned = String(text).replace(/,/g, '');
  const tokens = cleaned.match(/-?\d+\.?\d*/g) ?? [];
  return tokens.some((token) => Math.abs(parseFloat(token) - value) < 1e-6);
}
