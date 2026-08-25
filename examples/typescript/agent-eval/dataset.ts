/**
 * Dataset for the tool-agent eval — four tool-use cases with exact expected facts.
 *
 * Kept PARALLEL with the Python dataset in
 * `examples/python/agent-eval/dataset.py`: same questions and `facts`, only the
 * tool names differ per SDK idiom (`getStockPrice` here, `get_stock_price` there).
 * Each case has an EXPLICIT id matching its twin one-for-one, so running both under
 * the same name + key + `evaluationKey` converges into ONE diffable history.
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
