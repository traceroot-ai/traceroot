# Cost breakdown popup (#1069) — design

**Issue:** [#1069](https://github.com/traceroot-ai/traceroot/issues/1069) — Surface per-category cost breakdown in the UI (cost popup). Part of umbrella #959; extends the token breakdown from #958.

**Status:** Approved design — ready for implementation plan.

## Summary

Add a **display-only** hover popup on the cost (`$…`) chips in `SpanInfoPanel`, mirroring
the #958 token "Usage breakdown" popup but showing **dollars per category** instead of token
counts. Per-category dollar amounts are derived on the backend read path from already-stored
tokens × the pricing-table rates; the frontend renders them and (for the trace rollup)
aggregates them across spans.

Hovering a cost chip shows:

- **Input cost** — uncached input · cache read · cache write (each = category tokens × that category's rate)
- **Output cost** — output (reasoning is part of output, already at the output rate — *not* a separate row)
- **Total** — the sum of the categories

No change to how the span/trace `cost` total is computed or stored.

## Background: what already exists

- **#956** fixed cache-token cost in the ingest pipeline. The single cost formula is
  `cost_from_buckets(prices, buckets)` in `backend/worker/tokens/pricing.py` — a linear sum:
  `input_uncached×input + output×output + cache_read×cacheRead + cache_write×cacheWrite`,
  computed with `Decimal`.
- **#958** standardized token display (`x → y (z)`) and added the token "Usage breakdown"
  tooltip. The relevant UI:
  - `frontend/ui/src/features/traces/components/TokenChip.tsx` — the chip + shadcn `Tooltip`.
  - `frontend/ui/src/features/traces/components/TokenUsageBreakdown.tsx` — the tooltip body.
  - `frontend/ui/src/features/traces/components/SpanInfoPanel.tsx` — renders `TokenChip` at the
    span level and the trace-rollup level, and renders the two inline cost chips
    (`CircleDollarSign` + `$…`) this feature will replace.
  - `frontend/ui/src/features/traces/utils/index.ts` — `getTraceTokenUsage(spans)` aggregates
    token buckets across spans; `getTraceTotalCost(spans)` sums cost.
- **Data the frontend already has:** `span.cost`, `span.input_tokens`/`output_tokens`/`total_tokens`,
  and `span.usage_details` (`cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`).
- **The gap:** to show per-category *cost*, you need each category's tokens (frontend has these)
  × each category's *rate* (frontend does **not** have these — rates live in the Postgres pricing
  table, looked up server-side via `get_model_price`).

## Key decisions

1. **Where per-category cost is computed → backend, derived at read.**
   In the read path (`trace_reader`/the span service) re-derive the buckets from stored tokens
   and re-apply the per-category terms of `cost_from_buckets` via `get_model_price`, returning a
   `cost_details` map alongside `usage_details`. No storage/schema change; keeps the one pricing
   formula in Python.
   - *Rejected — store at ingest:* historically exact but needs a ClickHouse migration + storage
     and bends the issue's "no change to how cost is stored" note.
   - *Rejected — frontend from price JSON:* would re-implement model-name matching
     (`match_pattern` regex / version resolution) in TypeScript, duplicating `get_model_price`.

2. **Popup scope → `SpanInfoPanel` only.**
   Add the cost popup exactly where the #958 token popup lives: the span-level and trace-level
   cost chips in `SpanInfoPanel`. The tree/timeline rows and the trace-list table keep their
   current plain cost text. (Tightest match to #958, smallest surface, one shared component.)

3. **Total row → derived sum, accept rare drift.**
   The Total row is the sum of the per-category amounts (internally consistent popup). Because
   rates are looked up at read time, if a model's rates changed after ingest the derived sum
   could differ slightly from the stored `span.cost` on the chip. In the common case rates are
   unchanged and it matches exactly; rare drift is accepted as best-effort for a display-only
   feature. No special-casing.

## Architecture

### Backend

**`backend/worker/tokens/pricing.py`**
- Add `cost_breakdown_from_buckets(prices, buckets) -> dict[str, float] | None` returning the
  four priced terms using the existing `Decimal` math:
  - `input_uncached_cost = input_uncached × prices["input"]`
  - `cache_read_cost     = cache_read × (prices["cacheRead"] or 0)`
  - `cache_write_cost    = cache_write × (prices["cacheWrite"] or 0)`
  - `output_cost         = output × prices["output"]`
  - Returns `None` when `prices` is falsy (so callers can omit the breakdown rather than
    record zeros), matching `cost_from_buckets`'s contract.
- Refactor `cost_from_buckets` to return `sum(cost_breakdown_from_buckets(...).values())`
  (or `None`) so the total and the breakdown can never diverge by construction. The existing
  callers (`otel_transform.py`, `calculate_cost`) are unaffected.

**`backend/rest/services/trace_reader.py`**
- For each span returned from ClickHouse, reconstruct `TokenBuckets`:
  - `cache_read  = usage_details.get("cache_read_tokens", 0)`
  - `cache_write = usage_details.get("cache_write_tokens", 0)`
  - `input_uncached = max((input_tokens or 0) − cache_read − cache_write, 0)`
  - `output = output_tokens or 0`
- Call `get_model_price(model_name)` then `cost_breakdown_from_buckets`; attach the result as
  `cost_details` (empty `{}`/omitted when `None`, e.g. unknown model or no tokens).
- Trace-level needs no new endpoint: the detail view already has all spans and the frontend
  aggregates client-side.

**`backend/rest/schemas/traces.py`**
- Add `cost_details: dict[str, float] = {}` to `SpanResponse` (parallels `usage_details`).

### Frontend

**`frontend/ui/src/types/api.ts`**
- Add `cost_details?: Record<string, number>` to the `Span` interface.

**`frontend/ui/src/features/traces/utils/index.ts`**
- Add `getTraceCostBreakdown(spans)` summing each `cost_details` key across spans, returning
  `{ inputUncachedCost, cacheReadCost, cacheWriteCost, outputCost }`. Mirrors `getTraceTokenUsage`.

**`frontend/ui/src/features/traces/components/CostBreakdown.tsx`** (new)
- The popup body, styled identically to `TokenUsageBreakdown` (same shadcn tooltip container,
  section headers, `tabular-nums`). Sections:
  - **Input cost**: uncached input, cache read, cache write
  - **Output cost**: output
  - **Total**: sum of the four (border-top, semibold)
- Each amount formatted via the existing `formatCost()` (adaptive precision).
- Props accept either a single span's `cost_details` or the aggregated trace breakdown.

**`frontend/ui/src/features/traces/components/CostChip.tsx`** (new)
- Wraps the `$…` amount + `CircleDollarSign` in a `Tooltip` whose content is `CostBreakdown`
  (mirrors `TokenChip`). When no breakdown data is available it renders the plain chip with no
  tooltip.

**`frontend/ui/src/features/traces/components/SpanInfoPanel.tsx`**
- Replace the two inline cost chips (span-level and trace-level) with `CostChip`, passing the
  span's `cost_details` at span level and `getTraceCostBreakdown(spans)` at trace level.

## Data flow

```
ClickHouse spans (tokens + usage_details + cost)
        │  read
        ▼
trace_reader → rebuild TokenBuckets → get_model_price + cost_breakdown_from_buckets
        │  cost_details map per span
        ▼
SpanResponse.cost_details  ──API──►  Span.cost_details (frontend)
        │                                   │
        │ span level                        │ trace level: getTraceCostBreakdown(spans)
        ▼                                   ▼
            CostChip → CostBreakdown popup (Input / Output / Total)
```

## Edge cases

- **No prices for the model** (`get_model_price` → None): `cost_details` empty; `CostChip`
  renders the plain `$` chip with no popup. (`span.cost` itself is already null in this case.)
- **`span.cost` null:** no chip rendered today; unchanged.
- **Net-emitter spans** (cache > gross input): `input_uncached` floors to 0, so its cost row is
  `$0` while cache rows are still priced — consistent with `normalize_token_usage`.
- **Reasoning tokens:** never a separate cost row; they are a subset of output already priced at
  the output rate.
- **Price drift after ingest:** Total (derived sum) may differ slightly from the stored chip
  cost; accepted (decision 3).

## Testing

- **Backend** (`tests/worker/tokens/test_pricing.py`):
  - `cost_breakdown_from_buckets` reconciles to `cost_from_buckets` for representative buckets.
  - Missing `cacheRead`/`cacheWrite` rates treated as 0; `None` prices → `None`.
  - `trace_reader` test: a span with cache/reasoning tokens returns `cost_details` that sums to
    its `cost`.
- **Frontend:**
  - `getTraceCostBreakdown` aggregation across multiple spans.
  - `CostBreakdown` render test: rows present, total reconciles, empty data → no popup.

## Out of scope

- Cost popup on tree/timeline rows or the trace-list table.
- Storing per-category cost at ingest / any ClickHouse migration.
- Changing how the span/trace `cost` total is computed or stored.

## Manual verification

A bucket-consistent demo trace is seeded locally (project `my-llm-project`,
`trace-costdemo-0001`): a Claude LLM span (uncached 2k / cache-read 6k / cache-write 2k /
output 1.5k incl. 0.8k reasoning → $0.0378) and a GPT-4o LLM span (uncached 4k / cache-read 4k /
output 1k → $0.025), trace total $0.0628. After implementation, hovering the cost chips should
show the per-category split reconciling to those totals.
