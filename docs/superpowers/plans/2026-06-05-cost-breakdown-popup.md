# Cost breakdown popup (#1069) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a display-only hover popup on the cost (`$`) chips in `SpanInfoPanel` that shows the per-category dollar breakdown (uncached input · cache read · cache write · output) behind a span's and a trace's single cost value.

**Architecture:** The backend derives a per-category `cost_details` map at read time by re-pricing the disjoint token buckets reconstructed from stored tokens (one new pricing function reused as the single source of truth for the total). The frontend renders `cost_details` in a popup that mirrors the existing #958 token "Usage breakdown", aggregating across spans for the trace-level chip. No schema migration; no change to how `cost` is computed or stored.

**Tech Stack:** Python (FastAPI, Pydantic, `Decimal` pricing), pytest; TypeScript/React (Next.js), vitest (node env, pure-logic tests only).

**Design spec:** `docs/superpowers/specs/2026-06-05-cost-breakdown-popup-design.md`

---

## File structure

**Backend**
- `backend/worker/tokens/pricing.py` — add `cost_breakdown_from_buckets`; refactor `cost_from_buckets` to share one term-computation helper so total and breakdown can't diverge.
- `backend/rest/services/trace_reader.py` — add `span_cost_details` helper; attach `cost_details` to each span in `get_trace`.
- `backend/rest/schemas/traces.py` — add `cost_details` field to `SpanResponse`.
- `tests/worker/tokens/test_pricing.py` — tests for the new pricing function.
- `tests/rest/test_trace_reader.py` (new) — tests for `span_cost_details`.

**Frontend** (`frontend/ui/src/`)
- `types/api.ts` — add `cost_details` to `Span`.
- `features/traces/utils/index.ts` — add `summarizeCostDetails` + `getTraceCostBreakdown`.
- `features/traces/utils/index.test.ts` — tests for both helpers.
- `features/traces/components/CostBreakdown.tsx` (new) — popup body (cost analogue of `TokenUsageBreakdown`).
- `features/traces/components/CostChip.tsx` (new) — `$` chip + hover popup (cost analogue of `TokenChip`).
- `features/traces/components/SpanInfoPanel.tsx` — replace the two inline cost chips with `CostChip`.

> **Note on frontend tests:** vitest runs in the `node` environment (no jsdom/testing-library) and the repo has zero component (`.test.tsx`) tests — `TokenUsageBreakdown`/`TokenChip` shipped untested. This plan follows that convention: pure helpers (`summarizeCostDetails`, `getTraceCostBreakdown`) are unit-tested; the presentational `CostBreakdown`/`CostChip` are verified by type-check + manual inspection of the seeded trace (Task 8). Do **not** add jsdom/testing-library.

---

### Task 1: Backend — per-category cost function in `pricing.py`

**Files:**
- Modify: `backend/worker/tokens/pricing.py:108-128` (the `cost_from_buckets` function)
- Test: `tests/worker/tokens/test_pricing.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/worker/tokens/test_pricing.py`:

```python
def test_cost_breakdown_from_buckets_sums_to_cost_from_buckets():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets, cost_from_buckets

    prices = {
        "input": 0.000003,
        "output": 0.000015,
        "cacheRead": 0.0000003,
        "cacheWrite": 0.00000375,
    }
    buckets = TokenBuckets(input_uncached=2000, output=1500, cache_read=6000, cache_write=2000)
    breakdown = cost_breakdown_from_buckets(prices, buckets)
    assert breakdown == {
        "input_uncached_cost": pytest.approx(2000 * 0.000003),
        "cache_read_cost": pytest.approx(6000 * 0.0000003),
        "cache_write_cost": pytest.approx(2000 * 0.00000375),
        "output_cost": pytest.approx(1500 * 0.000015),
    }
    assert sum(breakdown.values()) == pytest.approx(cost_from_buckets(prices, buckets))


def test_cost_breakdown_from_buckets_treats_missing_cache_rates_as_zero():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets

    prices = {"input": 0.0000025, "output": 0.00001}  # OpenAI: no cache rates
    buckets = TokenBuckets(input_uncached=4000, output=1000, cache_read=4000, cache_write=0)
    breakdown = cost_breakdown_from_buckets(prices, buckets)
    assert breakdown["cache_read_cost"] == 0.0
    assert breakdown["cache_write_cost"] == 0.0
    assert breakdown["input_uncached_cost"] == pytest.approx(4000 * 0.0000025)
    assert breakdown["output_cost"] == pytest.approx(1000 * 0.00001)


def test_cost_breakdown_from_buckets_returns_none_without_prices():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets

    buckets = TokenBuckets(input_uncached=100, output=50)
    assert cost_breakdown_from_buckets(None, buckets) is None
    assert cost_breakdown_from_buckets({}, buckets) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest ../tests/worker/tokens/test_pricing.py -k cost_breakdown -v`
Expected: FAIL with `ImportError: cannot import name 'cost_breakdown_from_buckets'`.

- [ ] **Step 3: Implement the function and refactor `cost_from_buckets`**

In `backend/worker/tokens/pricing.py`, replace the entire `cost_from_buckets` function (lines 108-128) with this block (a shared private term-builder, the new public breakdown function, and the refactored total):

```python
def _bucket_cost_terms(
    prices: dict[str, float] | None, buckets: TokenBuckets
) -> dict[str, Decimal] | None:
    """Per-category cost terms as exact Decimals, or None when no prices are known.

    The single place the cost formula lives: each disjoint bucket priced once.
    Missing cacheRead / cacheWrite rates are treated as 0 (e.g. OpenAI has no
    cache-write rate). Both the total (cost_from_buckets) and the display-side
    breakdown (cost_breakdown_from_buckets) derive from this, so they cannot diverge.
    """
    if not prices:
        return None

    return {
        "input_uncached_cost": Decimal(buckets.input_uncached) * Decimal(str(prices.get("input", 0))),
        "cache_read_cost": Decimal(buckets.cache_read) * Decimal(str(prices.get("cacheRead") or 0)),
        "cache_write_cost": Decimal(buckets.cache_write) * Decimal(str(prices.get("cacheWrite") or 0)),
        "output_cost": Decimal(buckets.output) * Decimal(str(prices.get("output", 0))),
    }


def cost_from_buckets(prices: dict[str, float] | None, buckets: TokenBuckets) -> float | None:
    """Price DISJOINT token buckets — the single source of truth for total cost.

    Returns None when no prices are known, so callers can leave cost unset rather
    than recording $0. Both the inline ingest path (otel_transform.py) and
    calculate_cost() call this, so the cost formula lives in exactly one place.
    """
    terms = _bucket_cost_terms(prices, buckets)
    if terms is None:
        return None
    return float(sum(terms.values()))


def cost_breakdown_from_buckets(
    prices: dict[str, float] | None, buckets: TokenBuckets
) -> dict[str, float] | None:
    """Per-category dollar breakdown behind a span's single `cost` (issue #1069).

    Returns a dict keyed input_uncached_cost / cache_read_cost / cache_write_cost /
    output_cost, or None when no prices are known (same contract as
    cost_from_buckets). Summing the values reproduces cost_from_buckets. Display-only.
    """
    terms = _bucket_cost_terms(prices, buckets)
    if terms is None:
        return None
    return {key: float(value) for key, value in terms.items()}
```

- [ ] **Step 4: Run tests to verify they pass (incl. the existing pricing suite)**

Run: `cd backend && uv run pytest ../tests/worker/tokens/test_pricing.py -v`
Expected: PASS — the 3 new tests plus all pre-existing tests (the refactor keeps `cost_from_buckets` behavior, verified by `test_cost_from_buckets_*`).

- [ ] **Step 5: Commit**

```bash
git add backend/worker/tokens/pricing.py tests/worker/tokens/test_pricing.py
git commit -m "feat(pricing): add cost_breakdown_from_buckets sharing one cost formula

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — derive `cost_details` on the read path

**Files:**
- Modify: `backend/rest/services/trace_reader.py:1-6` (imports) and `:222-247` (span dict in `get_trace`)
- Modify: `backend/rest/schemas/traces.py:29` (after `usage_details`)
- Test: `tests/rest/test_trace_reader.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/rest/test_trace_reader.py`:

```python
"""Unit tests for read-path cost derivation (issue #1069).

Pure logic — get_model_price is patched, so no DB/ClickHouse is needed.
"""

from unittest.mock import patch

import pytest

CLAUDE_PRICES = {
    "input": 0.000003,
    "output": 0.000015,
    "cacheRead": 0.0000003,
    "cacheWrite": 0.00000375,
}


def test_span_cost_details_reconciles_to_cost():
    from rest.services.trace_reader import span_cost_details
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    with patch("rest.services.trace_reader.get_model_price", return_value=CLAUDE_PRICES):
        details = span_cost_details(
            "claude-3-5-sonnet-20241022",
            input_tokens=10000,  # gross: 2000 uncached + 6000 read + 2000 write
            output_tokens=1500,
            usage_details={
                "cache_read_tokens": 6000,
                "cache_write_tokens": 2000,
                "reasoning_tokens": 800,
            },
        )

    expected = cost_from_buckets(
        CLAUDE_PRICES,
        TokenBuckets(input_uncached=2000, output=1500, cache_read=6000, cache_write=2000),
    )
    assert sum(details.values()) == pytest.approx(expected)
    assert details["cache_read_cost"] == pytest.approx(6000 * 0.0000003)
    assert details["input_uncached_cost"] == pytest.approx(2000 * 0.000003)


def test_span_cost_details_empty_without_model():
    from rest.services.trace_reader import span_cost_details

    assert span_cost_details(None, 100, 50, {}) == {}


def test_span_cost_details_empty_for_unknown_model():
    from rest.services.trace_reader import span_cost_details

    with patch("rest.services.trace_reader.get_model_price", return_value=None):
        assert span_cost_details("mystery-model", 100, 50, {}) == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest ../tests/rest/test_trace_reader.py -v`
Expected: FAIL with `ImportError: cannot import name 'span_cost_details'`.

- [ ] **Step 3a: Add imports to `trace_reader.py`**

In `backend/rest/services/trace_reader.py`, the current imports (lines 1-6) are:

```python
"""Trace reader service - queries ClickHouse for trace data."""

from datetime import datetime

from db.clickhouse import get_clickhouse_client
from rest.sql_utils import escape_ilike, to_utc_naive
```

Add the two pricing imports below them:

```python
"""Trace reader service - queries ClickHouse for trace data."""

from datetime import datetime

from db.clickhouse import get_clickhouse_client
from rest.sql_utils import escape_ilike, to_utc_naive
from worker.tokens.buckets import TokenBuckets
from worker.tokens.pricing import cost_breakdown_from_buckets, get_model_price
```

(If the module's opening docstring differs from the snippet above, keep it as-is and just add the two `from worker.tokens...` lines after the existing imports.)

- [ ] **Step 3b: Add the `span_cost_details` helper**

In `backend/rest/services/trace_reader.py`, add this module-level function immediately above the `class TraceReaderService` declaration (search for `class TraceReaderService`):

```python
def span_cost_details(
    model_name: str | None,
    input_tokens: int | None,
    output_tokens: int | None,
    usage_details: dict[str, int],
) -> dict[str, float]:
    """Per-category dollar breakdown for a stored span (issue #1069).

    Rebuilds the disjoint token buckets from the stored GROSS input_tokens and the
    cache counts in usage_details, then prices each bucket with the model's current
    rates. Display-only: the values sum to the span's stored `cost` when rates are
    unchanged. Returns {} when the model has no known prices.
    """
    if not model_name:
        return {}
    cache_read = int(usage_details.get("cache_read_tokens", 0) or 0)
    cache_write = int(usage_details.get("cache_write_tokens", 0) or 0)
    buckets = TokenBuckets(
        input_uncached=max((input_tokens or 0) - cache_read - cache_write, 0),
        output=output_tokens or 0,
        cache_read=cache_read,
        cache_write=cache_write,
    )
    return cost_breakdown_from_buckets(get_model_price(model_name), buckets) or {}
```

- [ ] **Step 3c: Attach `cost_details` to each span in `get_trace`**

In `backend/rest/services/trace_reader.py`, the span dict in `get_trace` (around lines 224-246) currently ends like this:

```python
                    "usage_details": dict(row[14]) if row[14] else {},
                    "input": row[15],
```

Insert a `cost_details` entry right after `usage_details`:

```python
                    "usage_details": dict(row[14]) if row[14] else {},
                    "cost_details": span_cost_details(
                        row[9],  # model_name
                        int(row[11]) if row[11] is not None else None,  # input_tokens
                        int(row[12]) if row[12] is not None else None,  # output_tokens
                        dict(row[14]) if row[14] else {},  # usage_details
                    ),
                    "input": row[15],
```

- [ ] **Step 3d: Add the schema field**

In `backend/rest/schemas/traces.py`, `SpanResponse` currently has (lines 27-30):

```python
    # Generic token breakdown (e.g. cache_read_tokens, cache_write_tokens,
    # reasoning_tokens) — a map so new provider dimensions need no schema change.
    usage_details: dict[str, int] = {}
    input: str | None
```

Add `cost_details` after `usage_details`:

```python
    # Generic token breakdown (e.g. cache_read_tokens, cache_write_tokens,
    # reasoning_tokens) — a map so new provider dimensions need no schema change.
    usage_details: dict[str, int] = {}
    # Per-category dollar breakdown derived at read time (issue #1069):
    # input_uncached_cost, cache_read_cost, cache_write_cost, output_cost.
    # Empty when the model has no known prices. Display-only; sums to `cost`.
    cost_details: dict[str, float] = {}
    input: str | None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest ../tests/rest/test_trace_reader.py ../tests/rest/test_traces_router.py -v`
Expected: PASS (new helper tests pass; the existing traces-router tests still pass — the extra field defaults to `{}`).

- [ ] **Step 5: Commit**

```bash
git add backend/rest/services/trace_reader.py backend/rest/schemas/traces.py tests/rest/test_trace_reader.py
git commit -m "feat(traces): expose per-span cost_details on the trace detail API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend — add `cost_details` to the `Span` type

**Files:**
- Modify: `frontend/ui/src/types/api.ts:126-128`

- [ ] **Step 1: Add the field**

In `frontend/ui/src/types/api.ts`, the `Span` interface currently has (lines 126-129):

```typescript
  // Generic token breakdown map (cache_read_tokens, cache_write_tokens,
  // reasoning_tokens, …) — new provider dimensions appear here with no type change.
  usage_details?: Record<string, number>;
  input: string | null;
```

Add `cost_details` after `usage_details`:

```typescript
  // Generic token breakdown map (cache_read_tokens, cache_write_tokens,
  // reasoning_tokens, …) — new provider dimensions appear here with no type change.
  usage_details?: Record<string, number>;
  // Per-category dollar breakdown (issue #1069): input_uncached_cost,
  // cache_read_cost, cache_write_cost, output_cost. Empty when no known prices.
  cost_details?: Record<string, number>;
  input: string | null;
```

- [ ] **Step 2: Type-check**

Run: `cd frontend/ui && pnpm exec tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/ui/src/types/api.ts
git commit -m "feat(traces-ui): add cost_details to Span type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — `summarizeCostDetails` + `getTraceCostBreakdown` utils

**Files:**
- Modify: `frontend/ui/src/features/traces/utils/index.ts` (append after `getTraceTokenUsage`, ~line 299)
- Test: `frontend/ui/src/features/traces/utils/index.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `frontend/ui/src/features/traces/utils/index.test.ts` (the file already imports `describe, it, expect` and defines a `makeSpan` factory and imports `TraceDetail`). First extend the existing import from `./index` to include the two new functions — find the line:

```typescript
import { enrichSpansWithPending, getSpanDuration, getTraceDuration } from "./index";
```

and change it to:

```typescript
import {
  enrichSpansWithPending,
  getSpanDuration,
  getTraceDuration,
  summarizeCostDetails,
  getTraceCostBreakdown,
} from "./index";
```

Then append these test blocks at the end of the file:

```typescript
describe("summarizeCostDetails", () => {
  it("groups categories and totals input + output", () => {
    const s = summarizeCostDetails({
      input_uncached_cost: 0.006,
      cache_read_cost: 0.0018,
      cache_write_cost: 0.0075,
      output_cost: 0.0225,
    });
    expect(s.inputCost).toBeCloseTo(0.0153, 6);
    expect(s.outputCost).toBeCloseTo(0.0225, 6);
    expect(s.total).toBeCloseTo(0.0378, 6);
  });

  it("defaults missing/undefined details to zero", () => {
    const s = summarizeCostDetails(undefined);
    expect(s.inputCost).toBe(0);
    expect(s.outputCost).toBe(0);
    expect(s.total).toBe(0);
  });
});

describe("getTraceCostBreakdown", () => {
  it("sums each category across spans", () => {
    const trace = {
      spans: [
        makeSpan({
          span_id: "a",
          cost_details: {
            input_uncached_cost: 0.006,
            cache_read_cost: 0.0018,
            cache_write_cost: 0.0075,
            output_cost: 0.0225,
          },
        }),
        makeSpan({
          span_id: "b",
          cost_details: {
            input_uncached_cost: 0.01,
            cache_read_cost: 0.005,
            cache_write_cost: 0,
            output_cost: 0.01,
          },
        }),
      ],
    } as unknown as TraceDetail;

    const merged = getTraceCostBreakdown(trace);
    expect(merged).not.toBeNull();
    expect(merged!.input_uncached_cost).toBeCloseTo(0.016, 6);
    expect(merged!.cache_read_cost).toBeCloseTo(0.0068, 6);
    expect(merged!.cache_write_cost).toBeCloseTo(0.0075, 6);
    expect(merged!.output_cost).toBeCloseTo(0.0325, 6);
  });

  it("returns null when no span has cost_details", () => {
    const trace = { spans: [makeSpan({ span_id: "a" })] } as unknown as TraceDetail;
    expect(getTraceCostBreakdown(trace)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/ui && pnpm exec vitest run src/features/traces/utils/index.test.ts`
Expected: FAIL — `summarizeCostDetails`/`getTraceCostBreakdown` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/ui/src/features/traces/utils/index.ts` (after `getTraceTokenUsage`, end of file):

```typescript
// Cost breakdown categories stored in cost_details (issue #1069). Kept in one
// place so summarize + trace aggregation agree on the key set.
const COST_DETAIL_KEYS = [
  "input_uncached_cost",
  "cache_read_cost",
  "cache_write_cost",
  "output_cost",
] as const;

/**
 * Group a span's (or a merged trace's) per-category cost_details into the
 * input/output sections shown in the cost breakdown popup (issue #1069). Input
 * cost is the sum of uncached, cache-read and cache-write costs; total is input +
 * output. Missing keys default to 0.
 */
export function summarizeCostDetails(details: Record<string, number> | undefined | null): {
  inputUncachedCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputCost: number;
  outputCost: number;
  total: number;
} {
  const inputUncachedCost = details?.input_uncached_cost ?? 0;
  const cacheReadCost = details?.cache_read_cost ?? 0;
  const cacheWriteCost = details?.cache_write_cost ?? 0;
  const outputCost = details?.output_cost ?? 0;
  const inputCost = inputUncachedCost + cacheReadCost + cacheWriteCost;
  return {
    inputUncachedCost,
    cacheReadCost,
    cacheWriteCost,
    inputCost,
    outputCost,
    total: inputCost + outputCost,
  };
}

/**
 * Sum each cost_details category across a trace's spans for the trace-level cost
 * popup (mirrors getTraceTokenUsage). Returns null when no span reports a
 * breakdown, so the trace cost chip renders without a popup.
 */
export function getTraceCostBreakdown(trace: TraceDetail): Record<string, number> | null {
  const spansWithDetails = trace.spans.filter(
    (s) => s.cost_details && Object.keys(s.cost_details).length > 0,
  );
  if (spansWithDetails.length === 0) return null;
  const merged: Record<string, number> = {};
  for (const key of COST_DETAIL_KEYS) {
    merged[key] = spansWithDetails.reduce((sum, s) => sum + (s.cost_details?.[key] ?? 0), 0);
  }
  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/ui && pnpm exec vitest run src/features/traces/utils/index.test.ts`
Expected: PASS (all existing tests plus the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add frontend/ui/src/features/traces/utils/index.ts frontend/ui/src/features/traces/utils/index.test.ts
git commit -m "feat(traces-ui): add cost breakdown summarize + trace aggregation utils

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend — `CostBreakdown` popup component

**Files:**
- Create: `frontend/ui/src/features/traces/components/CostBreakdown.tsx`

- [ ] **Step 1: Create the component**

Create `frontend/ui/src/features/traces/components/CostBreakdown.tsx` (mirrors `TokenUsageBreakdown.tsx`):

```tsx
import { formatCost } from "@/lib/utils";
import { summarizeCostDetails } from "../utils";

interface CostBreakdownProps {
  details: Record<string, number> | null | undefined;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-8 text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatCost(value)}</span>
    </div>
  );
}

/**
 * Hierarchical "Cost breakdown" panel — the dollar analogue of
 * TokenUsageBreakdown (issue #1069). Input cost splits into uncached input,
 * cache read and cache write; output cost is shown on its own (reasoning is part
 * of output, already priced at the output rate). The Total is the sum of the
 * categories and reconciles to the span/trace cost chip when prices are unchanged.
 */
export function CostBreakdown({ details }: CostBreakdownProps) {
  const c = summarizeCostDetails(details);

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Cost breakdown</div>

      <div className="flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Input cost</span>
        <span className="tabular-nums">{formatCost(c.inputCost)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        <Row label="uncached input" value={c.inputUncachedCost} />
        <Row label="cache read" value={c.cacheReadCost} />
        <Row label="cache write" value={c.cacheWriteCost} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Output cost</span>
        <span className="tabular-nums">{formatCost(c.outputCost)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        <Row label="output" value={c.outputCost} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold">
        <span>Total cost</span>
        <span className="tabular-nums">{formatCost(c.total)}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend/ui && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/ui/src/features/traces/components/CostBreakdown.tsx
git commit -m "feat(traces-ui): add CostBreakdown popup component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend — `CostChip` component

**Files:**
- Create: `frontend/ui/src/features/traces/components/CostChip.tsx`

- [ ] **Step 1: Create the component**

Create `frontend/ui/src/features/traces/components/CostChip.tsx` (mirrors `TokenChip.tsx`; the chip markup matches the existing inline cost chip in `SpanInfoPanel` exactly — `CircleDollarSign` + `cost.toFixed(6)`):

```tsx
import { CircleDollarSign } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CostBreakdown } from "./CostBreakdown";

interface CostChipProps {
  cost: number | null | undefined;
  costDetails?: Record<string, number> | null;
}

/**
 * Cost chip ($ icon + amount) with a hover Cost breakdown panel (issue #1069).
 * Mirrors TokenChip. Renders nothing when cost is absent/non-finite; renders a
 * plain chip (no popup) when no per-category breakdown is available.
 */
export function CostChip({ cost, costDetails }: CostChipProps) {
  if (cost == null || !Number.isFinite(cost)) return null;

  const chip = (
    <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
      <CircleDollarSign className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{cost.toFixed(6)}</span>
    </div>
  );

  const hasBreakdown = costDetails && Object.keys(costDetails).length > 0;
  if (!hasBreakdown) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent className="border bg-popover p-3 text-popover-foreground shadow-md">
          <CostBreakdown details={costDetails} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend/ui && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/ui/src/features/traces/components/CostChip.tsx
git commit -m "feat(traces-ui): add CostChip with hover cost breakdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Frontend — wire `CostChip` into `SpanInfoPanel`

**Files:**
- Modify: `frontend/ui/src/features/traces/components/SpanInfoPanel.tsx` (imports `:4-22`, trace aggregates `:79`, cost chips `:137-142` and `:158-163`)

- [ ] **Step 1: Update imports**

In `frontend/ui/src/features/traces/components/SpanInfoPanel.tsx`:

(a) Remove `CircleDollarSign` from the `lucide-react` import (lines 4-14) — it becomes unused once both inline chips are replaced. The block currently is:

```tsx
import {
  Clock,
  Users,
  Layers,
  ChevronRight,
  CircleDollarSign,
  AlertCircle,
  GitBranch,
  GitCommitHorizontal,
  FileCode,
} from "lucide-react";
```

Change it to:

```tsx
import {
  Clock,
  Users,
  Layers,
  ChevronRight,
  AlertCircle,
  GitBranch,
  GitCommitHorizontal,
  FileCode,
} from "lucide-react";
```

(b) Add the `CostChip` import next to the existing `TokenChip` import (line 17):

```tsx
import { TokenChip } from "./TokenChip";
import { CostChip } from "./CostChip";
```

(c) Add `getTraceCostBreakdown` to the utils import (line 21). It currently is:

```tsx
import { getSpanDuration, getTraceDuration, getTraceTotalCost, getTraceTokenUsage } from "../utils";
```

Change it to:

```tsx
import {
  getSpanDuration,
  getTraceDuration,
  getTraceTotalCost,
  getTraceTokenUsage,
  getTraceCostBreakdown,
} from "../utils";
```

- [ ] **Step 2: Compute the trace-level breakdown**

Find the trace aggregates (line 79-80):

```tsx
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;
```

Add the breakdown alongside them:

```tsx
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceCostDetails = isTrace ? getTraceCostBreakdown(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;
```

- [ ] **Step 3: Replace the trace-level cost chip**

Replace the trace-level cost block (lines 137-142):

```tsx
          {isTrace && traceTotalCost && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleDollarSign className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{traceTotalCost.toFixed(6)}</span>
            </div>
          )}
```

with:

```tsx
          {isTrace && traceTotalCost != null && (
            <CostChip cost={traceTotalCost} costDetails={traceCostDetails} />
          )}
```

- [ ] **Step 4: Replace the span-level cost chip**

Replace the span-level cost block (lines 158-163):

```tsx
          {!isTrace && selection.span.cost != null && Number.isFinite(selection.span.cost) && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleDollarSign className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{selection.span.cost.toFixed(6)}</span>
            </div>
          )}
```

with (the `cost != null && Number.isFinite` guard now lives inside `CostChip`):

```tsx
          {!isTrace && (
            <CostChip cost={selection.span.cost} costDetails={selection.span.cost_details} />
          )}
```

- [ ] **Step 5: Type-check and lint**

Run: `cd frontend/ui && pnpm exec tsc --noEmit && pnpm exec eslint src/features/traces/components/SpanInfoPanel.tsx src/features/traces/components/CostChip.tsx src/features/traces/components/CostBreakdown.tsx`
Expected: PASS — no type errors and no `CircleDollarSign is defined but never used` lint error (confirms the import removal in Step 1a was correct).

- [ ] **Step 6: Commit**

```bash
git add frontend/ui/src/features/traces/components/SpanInfoPanel.tsx
git commit -m "feat(traces-ui): show cost breakdown popup on SpanInfoPanel cost chips

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Manual verification against the seeded trace

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend pricing + trace-reader tests**

Run: `cd backend && uv run pytest ../tests/worker/tokens/test_pricing.py ../tests/rest/test_trace_reader.py ../tests/rest/test_traces_router.py -v`
Expected: PASS.

- [ ] **Step 2: Run the full frontend utils tests + type-check**

Run: `cd frontend/ui && pnpm exec vitest run src/features/traces/utils/index.test.ts && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Confirm the API returns `cost_details`**

With the dev stack running (`make dev-autoreload`), the seeded trace lives in project `e6d01fce-655d-4220-ad02-db4befb5ab37`, trace `trace-costdemo-0001`. Confirm the detail endpoint now includes per-category cost by querying ClickHouse-backed data through the service is covered by tests; for an end-to-end check, open the UI (next step) — the API requires session auth, so visual verification is the practical path.

- [ ] **Step 4: Visually verify the popup**

Open `http://localhost:3000/projects/e6d01fce-655d-4220-ad02-db4befb5ab37/traces`, open trace `agent.handle_request`, select the `anthropic.messages.create` LLM span, and hover its cost chip. Expected popup:

```
Cost breakdown
Input cost          $0.0093
  uncached input    $0.006
  cache read        $0.0018
  cache write       $0.0075
Output cost         $0.0225
  output            $0.0225
Total cost          $0.0378
```

(Input cost = 0.006 + 0.0018 + 0.0075 = $0.0093; Total = $0.0378 = the chip value.) Hover the trace-level cost chip (select the trace root) and confirm Total = **$0.0628** (Claude $0.0378 + GPT-4o $0.025). Note: `formatCost` renders exact $0 categories as `-`.

- [ ] **Step 5: Final review**

Confirm the diff touches only the files in this plan and that the chip's visible appearance is unchanged (same `$` icon + 6-decimal amount) — only the hover popup is new.

---

## Self-review notes

- **Spec coverage:** backend derived-at-read `cost_details` (Tasks 1-2) ✓; `SpanResponse.cost_details` (Task 2) ✓; `Span.cost_details` type (Task 3) ✓; `getTraceCostBreakdown` aggregation (Task 4) ✓; `CostBreakdown` popup (Task 5) ✓; `CostChip` + SpanInfoPanel-only placement (Tasks 6-7) ✓; Total = derived sum (Task 4 `summarizeCostDetails`, Task 5) ✓; backend reconciliation + missing-rate + no-price tests (Tasks 1-2) ✓; empty-data → no popup (`CostChip` guard, Task 6) ✓.
- **Reconciliation/drift:** Total is the derived sum (decision 3); `cost_from_buckets` and `cost_breakdown_from_buckets` share `_bucket_cost_terms`, so per-span values reconcile to the stored cost when rates are unchanged.
- **Type consistency:** key set (`input_uncached_cost`, `cache_read_cost`, `cache_write_cost`, `output_cost`) is identical across backend (`_bucket_cost_terms`), API field, and frontend (`COST_DETAIL_KEYS`, `summarizeCostDetails`). Component prop name `costDetails` is consistent between `CostChip` and its call sites; `CostBreakdown` takes `details`.
- **Frontend test convention:** pure helpers tested in vitest (node env); presentational components verified by `tsc` + manual (Task 8), matching the untested `TokenChip`/`TokenUsageBreakdown` precedent — no test-infra changes.
