# Standardize List States Across Main Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make loading, empty, error, and table treatment identical across Traces, Detectors, Datasets, Evaluations (plus Users and Sessions) using one shared component set and one table implementation.

**Architecture:** New `components/ui/list-state.tsx` owns all list states (`ListState` for empty/error with icon+title+description+action, `ListLoading` for the spinner, `TableStateRow` for in-table rows). `TableEmpty` is deleted from `components/ui/table.tsx`; `EmptyState` stays only for detail pages (dataset-detail, compare-runs). All six list pages move onto the shared `Table/*` primitives, `Timestamp`, and truncate+title ID cells. Error treatment everywhere: AlertTriangle icon + title + guidance + `Try again` button wired to the hook's `refetch` (all hooks are TanStack `useQuery`).

**Tech Stack:** React 19, Next.js 16, TanStack Query v5, Tailwind, Vitest + Testing Library.

## Global Constraints

- Keep existing user-facing copy verbatim (`Loading datasets...`, `No datasets yet`, `Error loading runs`, etc.) so `evaluations.smoke.test.tsx` and `detectors/page.test.tsx` stay green.
- `LoadingState` in `components/ui/loading-state.tsx` is the single spinner; do not create another.
- Shared `TH`/`TD` classes already carry `border-r ... last:border-r-0` — never re-add positional divider logic.
- `THead` is already sticky (`sticky top-0 z-10 bg-background`) — do not restyle.
- Do NOT touch `EmptyState` (offline-eval page-chrome) or the settings tables (AccessKeys, Members, ModelProviders).
- Follow file style: JSDoc comments on shared components, `"use client"` where hooks are used.

---

## File Structure

**Create:**
- `frontend/ui/src/components/ui/list-state.tsx` — ListState, ListLoading, TableStateRow
- `frontend/ui/src/components/ui/list-state.test.tsx`

**Modify:**
- `frontend/ui/src/components/ui/table.tsx` — delete `TableEmpty`
- `frontend/ui/src/app/projects/[projectId]/traces/page.tsx` — states
- `frontend/ui/src/features/traces/components/TraceListTable.tsx` — Table primitives
- `frontend/ui/src/features/traces/components/TraceMetadataCell.tsx` — drop borderClassName
- `frontend/ui/src/features/traces/components/TraceListTable.test.tsx` — add `<time>` test
- `frontend/ui/src/app/projects/[projectId]/detectors/page.tsx` — states + primitives
- `frontend/ui/src/app/projects/[projectId]/detectors/page.test.tsx` — refetch mock + retry test
- `frontend/ui/src/features/evaluations/views/datasets-view.tsx` — states
- `frontend/ui/src/features/evaluations/views/evaluations-view.tsx` — states + id truncation
- `frontend/ui/src/features/evaluations/evaluations.smoke.test.tsx` — Try again assertions
- `frontend/ui/src/app/projects/[projectId]/users/page.tsx` — states + primitives
- `frontend/ui/src/app/projects/[projectId]/sessions/page.tsx` — states + primitives

---

### Task 1: Shared list-state components, retire TableEmpty

**Files:**
- Create: `frontend/ui/src/components/ui/list-state.tsx`, `frontend/ui/src/components/ui/list-state.test.tsx`
- Modify: `frontend/ui/src/components/ui/table.tsx:93-102`

- [ ] **Step 1: Write the failing test** `list-state.test.tsx`

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListState, ListLoading, TableStateRow } from "./list-state";

describe("ListState", () => {
  it("renders icon, title, description and action in order", () => {
    render(
      <ListState
        icon={<svg data-testid="icon" />}
        title="No items"
        description="Nothing here yet."
        action={<button type="button">Go</button>}
      />,
    );
    const title = screen.getByText("No items");
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
    expect(title.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("renders just the title when nothing else is given", () => {
    render(<ListState title="No rows" />);
    expect(screen.getByText("No rows")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ListLoading", () => {
  it("shows a labeled spinner", () => {
    render(<ListLoading label="Loading traces..." />);
    expect(screen.getByText("Loading traces...")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("TableStateRow", () => {
  it("spans every table column", () => {
    render(
      <table>
        <tbody>
          <TableStateRow colSpan={7}>
            <ListState title="Empty" />
          </TableStateRow>
        </tbody>
      </table>,
    );
    expect(screen.getByText("Empty").closest("td")?.colSpan).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/components/ui/list-state.test.tsx` (in `frontend/ui`). Expected: module not found.

- [ ] **Step 3: Implement `list-state.tsx` and delete `TableEmpty`** (see code in Task description above; exact source below)

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";

export interface ListStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Centered empty/error block for list pages: icon, title, optional guidance and
 * optional CTA (retry / new-item / clear-search). Owns the h-64 state area so
 * every list renders the same shape.
 */
export function ListState({ icon, title, description, action, className }: ListStateProps) {
  return (
    <div
      className={cn(
        "flex h-64 flex-col items-center justify-center gap-3 text-center",
        className,
      )}
    >
      {icon}
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {description && <p className="text-[12px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Centered spinner + label filling the same h-64 state area. */
export function ListLoading({ label }: { label: string }) {
  return (
    <div className="flex h-64 items-center justify-center">
      <LoadingState label={label} />
    </div>
  );
}

/** A full-width table row wrapping a list state (loading / empty / error). */
export function TableStateRow({
  colSpan,
  className,
  children,
}: {
  colSpan: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-3", className)}>
        {children}
      </td>
    </tr>
  );
}
```

In `table.tsx`: delete the `TableEmpty` component (lines 93-102).

- [ ] **Step 4: Run test to verify pass** — same command. Expected: PASS (6 tests).
- [ ] **Step 5: Commit** — `git add frontend/ui/src/components/ui/ && git commit -m "feat(ui): add shared list-state components, retire TableEmpty"`

---

### Task 2: Datasets list states

**Files:**
- Modify: `frontend/ui/src/features/evaluations/views/datasets-view.tsx:106-124`
- Test: `frontend/ui/src/features/evaluations/evaluations.smoke.test.tsx` (extend error test)

- [ ] **Step 1: Extend the failing smoke test**

```tsx
it("Datasets shows an error state when the fetch fails", async () => {
  global.fetch = failingFetch();
  mount(<DatasetsView projectId="p1" />);
  expect(await screen.findByText(withText(/Error loading datasets/))).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/features/evaluations/evaluations.smoke.test.tsx`. Expected: FAIL (no Try again button).
- [ ] **Step 3: Rewrite the TBody states in `datasets-view.tsx`**

Imports: add `AlertTriangle, Inbox` from `lucide-react`; replace `TableEmpty` in the ui/table import with nothing (drop it); add `import { ListState, ListLoading, TableStateRow } from "@/components/ui/list-state";`

```tsx
<TBody>
  {isLoading ? (
    <TableStateRow colSpan={7}>
      <ListLoading label="Loading datasets..." />
    </TableStateRow>
  ) : error ? (
    <TableStateRow colSpan={7}>
      <ListState
        icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
        title="Error loading datasets"
        description="Make sure the API server is running and you have API keys configured."
        action={
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => refetch()}
          >
            Try again
          </Button>
        }
      />
    </TableStateRow>
  ) : datasets.length === 0 ? (
    <TableStateRow colSpan={7}>
      <ListState
        icon={<Inbox className="h-8 w-8 text-muted-foreground/40" />}
        title={keyword ? "No datasets match your search." : "No datasets yet"}
        description={keyword ? undefined : "Save a trace or span as a test case to start one."}
      />
    </TableStateRow>
  ) : (
    datasets.map((dataset) => { /* unchanged */ })
  )}
</TBody>
```

`refetch` is already destructured from `useDatasets` (datasets-view.tsx:37). Run the smoke test; all "loading / error / empty states" tests must pass.

- [ ] **Step 4: Run full affected suite** — `pnpm exec vitest run src/features/evaluations/evaluations.smoke.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(evaluations): unify datasets list loading/empty/error states"`

---

### Task 3: Evaluations list states

**Files:**
- Modify: `frontend/ui/src/features/evaluations/views/evaluations-view.tsx` (imports, `useEvaluationRuns` call, TBody 349-376, datasetVersion cell 136, delete local `Cell` 433-439)
- Test: `frontend/ui/src/features/evaluations/evaluations.smoke.test.tsx` (extend error test)

- [ ] **Step 1: Extend the failing smoke test**

```tsx
it("Evaluations Runs tab shows an error state when the fetch fails", async () => {
  global.fetch = failingFetch();
  mount(<EvaluationsView projectId="p1" />);
  expect(await screen.findByText("Error loading runs")).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/features/evaluations/evaluations.smoke.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**

Imports: add `AlertTriangle, Inbox` to the lucide-react import; remove `EmptyState` from the offline-eval components import; add `import { ListState, ListLoading, TableStateRow } from "@/components/ui/list-state";`

Destructure `refetch`: `const { data, isLoading, error, refetch } = useEvaluationRuns(...)`.

Replace TBody branches (keep the `runs.map` branch unchanged):

```tsx
{isLoading ? (
  <TableStateRow colSpan={RUNS_COLUMN_COUNT}>
    <ListLoading label="Loading runs..." />
  </TableStateRow>
) : error ? (
  <TableStateRow colSpan={RUNS_COLUMN_COUNT}>
    <ListState
      icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
      title="Error loading runs"
      description="Make sure the API server is running and you have API keys configured."
      action={
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[12px]"
          onClick={() => refetch()}
        >
          Try again
        </Button>
      }
    />
  </TableStateRow>
) : runs.length === 0 ? (
  <TableStateRow colSpan={RUNS_COLUMN_COUNT}>
    <ListState
      icon={<Inbox className="h-8 w-8 text-muted-foreground/40" />}
      title={filtered ? "No runs match these filters." : "No evaluation runs yet"}
      description={filtered ? undefined : "Report a run from your SDK and it appears here."}
    />
  </TableStateRow>
) : (
  runs.map((r) => ( /* unchanged */ ))
)}
```

Delete the local `Cell` helper (lines 433-439). Dataset version id (line 136) gains truncation:

```tsx
{datasetVersion && (
  <span
    className="inline-block max-w-[200px] truncate align-bottom font-mono text-[11px]"
    title={datasetVersion}
  >
    {datasetVersion}
  </span>
)}
```

- [ ] **Step 4: Run smoke tests** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(evaluations): unify runs list states and truncate version ids"`

---

### Task 4: Traces — page states + TraceListTable onto shared primitives

**Files:**
- Modify: `frontend/ui/src/app/projects/[projectId]/traces/page.tsx:264-285`
- Modify: `frontend/ui/src/features/traces/components/TraceListTable.tsx` (whole file)
- Modify: `frontend/ui/src/features/traces/components/TraceMetadataCell.tsx` (drop borderClassName)
- Test: `frontend/ui/src/features/traces/components/TraceListTable.test.tsx` (add one test)

- [ ] **Step 1: Add the failing test**

```tsx
it("renders the timestamp as a semantic <time> element", () => {
  renderTable({ traces: [makeTrace({ trace_id: "t-1" })] });
  expect(cellAt("t-1", "Timestamp").querySelector("time")).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/features/traces/components/TraceListTable.test.tsx`. Expected: FAIL (raw td). All other tests must still pass OR fail only from the migration not yet done — migrate first if needed, then verify at Step 4.
- [ ] **Step 3: Implement**

`traces/page.tsx`:
- Import `ListState, ListLoading` from `@/components/ui/list-state` (drop `LoadingState` import, keep `Button`, `AlertTriangle`, `Inbox`).
- `const { data, isLoading, error, refetch } = useTraces(...)`.
- Replace the loading/error/empty branches:

```tsx
{isLoading || checking ? (
  <ListLoading label="Loading traces..." />
) : error && !data ? (
  <ListState
    icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
    title="Error loading traces"
    description="Make sure the API server is running and you have API keys configured."
    action={
      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => refetch()}>
        Try again
      </Button>
    }
  />
) : showGettingStarted ? (
  <GettingStarted projectId={projectId} />
) : traces.length === 0 ? (
  <ListState
    icon={<Inbox className="h-8 w-8 text-muted-foreground/40" />}
    title="No traces found"
    description="Try adjusting your filters or date range."
  />
) : ( /* existing table + pagination branch unchanged */ )}
```

`TraceListTable.tsx` — migrate to shared primitives:

- Imports: `import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";` and `import { Timestamp } from "@/features/offline-eval/components";`. Drop `formatDate` import.
- Delete `CELL_BORDER`, `HEADER_CELL`, `borderClassName` props, `FixedCellProps.borderClassName`.
- Component body:

```tsx
export function TraceListTable({ traces, selectedTraceId, onSelectTrace, visibleColumns }: TraceListTableProps) {
  const hasAddedColumns = visibleColumns.some((id) => !isDefaultOnColumn(id));
  const hasColumns = visibleColumns.length > 0;

  return (
    <Table className={hasAddedColumns ? ADDED_COLUMN_TABLE_MIN_WIDTH : undefined}>
      {hasColumns && (
        <THead>
          <TRHead>
            {visibleColumns.map((id) => (
              <ColumnHeader key={id} id={id} />
            ))}
          </TRHead>
        </THead>
      )}
      <TBody>
        {hasColumns ? (
          traces.map((trace) => (
            <TraceRow
              key={trace.trace_id}
              trace={trace}
              isSelected={selectedTraceId === trace.trace_id}
              onSelect={onSelectTrace}
              columns={visibleColumns}
            />
          ))
        ) : (
          <tr>
            <td className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No columns selected. Choose one from the Columns menu.
            </td>
          </tr>
        )}
      </TBody>
    </Table>
  );
}

function ColumnHeader({ id }: { id: FixedColumnId }) {
  const label = fixedColumnLabel(id);
  const isDefaultOn = isDefaultOnColumn(id);
  const className = isDefaultOn ? HEADER_WIDTH[id] : ADDED_COLUMN_WIDTH;
  if (isDefaultOn) return <Th className={className}>{label}</Th>;
  return (
    <Th className={className} title={label}>
      <span className="block truncate">{label}</span>
    </Th>
  );
}

function TraceRow({ trace, isSelected, onSelect, columns }: {
  trace: TraceListItem;
  isSelected: boolean;
  onSelect: (traceId: string) => void;
  columns: readonly FixedColumnId[];
}) {
  return (
    <TR interactive selected={isSelected} onClick={() => onSelect(trace.trace_id)}>
      {columns.map((id) => {
        const Cell = FIXED_CELLS[id];
        return <Cell key={id} trace={trace} />;
      })}
    </TR>
  );
}
```

- `FIXED_CELLS: Record<FixedColumnId, (props: { trace: TraceListItem }) => ReactElement>` — cells become:

```tsx
timestamp: ({ trace }) => (
  <Td className="whitespace-nowrap text-muted-foreground">
    <Timestamp iso={trace.trace_start_time} />
  </Td>
),
name: ({ trace }) => <Td className="text-foreground">{trace.name}</Td>,
trace_id: ({ trace }) => (
  <Td className="min-w-[280px] max-w-[400px] whitespace-nowrap font-mono text-[11px] text-muted-foreground">
    <span className="block truncate" title={trace.trace_id}>{trace.trace_id}</span>
  </Td>
),
errors: ({ trace }) => (
  <Td className="text-center">
    {trace.error_count > 0 ? (
      <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
        {trace.error_count}
      </span>
    ) : (
      <span className="text-[12px] text-muted-foreground">0</span>
    )}
  </Td>
),
spans: ({ trace }) => <Td className="text-center text-muted-foreground">{trace.span_count}</Td>,
input: ({ trace }) => <PreviewCell value={formatContentPreview(trace.input)} />,
output: ({ trace }) => <PreviewCell value={formatContentPreview(trace.output)} />,
metadata: ({ trace }) => <TraceMetadataCell entries={traceMetadataEntries(trace)} />,
user_id: ({ trace }) => <FixedFieldCell value={trace.user_id} />,
session_id: ({ trace }) => <FixedFieldCell value={trace.session_id} />,
input_usage: ({ trace }) => <UsageCell value={trace.total_input_tokens} />,
output_usage: ({ trace }) => <UsageCell value={trace.total_output_tokens} />,
total_usage: ({ trace }) => <UsageCell value={traceTotalTokens(trace)} />,
tokens: ({ trace }) => {
  const totalTokens = traceTotalTokens(trace) ?? 0;
  return (
    <Td className="whitespace-nowrap text-muted-foreground">
      {totalTokens > 0 ? (
        <span
          title={`${formatExactTokens(trace.total_input_tokens)} → ${formatExactTokens(trace.total_output_tokens)} (${formatExactTokens(totalTokens)})`}
        >
          {formatTokenFlow(trace.total_input_tokens, trace.total_output_tokens)}
        </span>
      ) : (
        "-"
      )}
    </Td>
  );
},
cost: ({ trace }) => (
  <Td className="text-foreground">
    {trace.total_cost && trace.total_cost > 0 ? formatCost(trace.total_cost) : "-"}
  </Td>
),
latency: ({ trace }) => (
  <Td className="whitespace-nowrap text-foreground">
    {formatDuration(trace.duration_ms)}
  </Td>
),
```

- Helpers:

```tsx
function PreviewCell({ value }: { value: string }) {
  return (
    <Td className="max-w-[180px]">
      <span className="block truncate font-mono text-[11px] text-muted-foreground">{value}</span>
    </Td>
  );
}

function UsageCell({ value }: { value: number | null | undefined }) {
  return (
    <Td className="whitespace-nowrap text-muted-foreground">
      {value == null ? "-" : formatExactTokens(value)}
    </Td>
  );
}

function FixedFieldCell({ value }: { value: string | null | undefined }) {
  if (value == null || value === "") {
    return <Td className="text-muted-foreground">-</Td>;
  }
  return (
    <Td className="max-w-[180px]">
      <span className="block truncate font-mono text-[11px] text-muted-foreground" title={value}>
        {value}
      </span>
    </Td>
  );
}
```

`traceTotalTokens` unchanged. Keep `HEADER_WIDTH`, `ADDED_COLUMN_WIDTH`, `ADDED_COLUMN_TABLE_MIN_WIDTH`, `ADDED_COLUMN_WIDTH` constants; delete `CELL_BORDER`, `HEADER_CELL`.

`TraceMetadataCell.tsx`:
- `interface TraceMetadataCellProps { entries: readonly MetadataEntry[] }` (drop `borderClassName`).
- Replace both `<td className={cellClassName}>` with `<Td className="max-w-[180px]">`; import `Td` from `@/components/ui/table`; delete the `cellClassName` line and the `cn` import if unused elsewhere in the file (it is not).

- [ ] **Step 4: Run tests** — `pnpm exec vitest run src/features/traces/components/TraceListTable.test.tsx src/features/traces/components/TraceMetadataCell.test.tsx` → PASS. (Check TraceMetadataCell.test.tsx first for any class assertions; keep them green.)
- [ ] **Step 5: Commit** — `git add frontend/ui/src/app/projects/[projectId]/traces/ frontend/ui/src/features/traces/components/ && git commit -m "feat(traces): unify list states and move onto shared table primitives"`

---

### Task 5: Detectors — states + table onto shared primitives

**Files:**
- Modify: `frontend/ui/src/app/projects/[projectId]/detectors/page.tsx` (imports, refetch, states 160-196, table 198-321)
- Test: `frontend/ui/src/app/projects/[projectId]/detectors/page.test.tsx`

- [ ] **Step 1: Update test mock + add failing test**

- Add `refetch: vi.fn()` to `defaultDetectorList` and add:

```tsx
it("shows the error state with a retry that refetches", () => {
  const refetch = vi.fn();
  mocks.useDetectorList.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: new Error("boom"),
    refetch,
  });
  render(<DetectorsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(refetch).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/app/projects/[projectId]/detectors/page.test.tsx`. Expected: FAIL (Try again missing; existing tests still pass since copy kept).
- [ ] **Step 3: Implement `detectors/page.tsx`**

Imports:
- `AlertTriangle` added to `lucide-react` import.
- `import { ListState, ListLoading } from "@/components/ui/list-state";`
- `import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";`
- `import { Timestamp } from "@/features/offline-eval/components";`
- Remove `LoadingState` and `formatDate` imports; remove `cn` only if now unused (it is — rows/hover styling moves into TR).

`const { data, isLoading, error, refetch } = useDetectorList(...)`.

Replace states:

```tsx
{isLoading ? (
  <ListLoading label="Loading detectors..." />
) : error ? (
  <ListState
    icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
    title="Error loading detectors"
    description="Make sure the API server is running and you have API keys configured."
    action={
      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => refetch()}>
        Try again
      </Button>
    }
  />
) : isEmptyProject ? (
  <ListState
    icon={<DOMAIN_ICONS.detector className="h-8 w-8 text-muted-foreground/40" />}
    title="No detectors yet"
    description="Create a detector to automatically analyze your traces."
    action={
      <Button
        size="sm"
        className="h-7 text-[12px]"
        onClick={() => router.push(`/projects/${projectId}/detectors/new`)}
      >
        New Detector
      </Button>
    }
  />
) : isEmptySearch ? (
  <ListState
    title={`No detectors match “${state.keyword}”`}
    action={
      <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => updateKeyword("")}>
        Clear search
      </Button>
    }
  />
) : (
  <Table>
    <THead>
      <TRHead>
        <Th>Name</Th>
        <Th>Template</Th>
        <Th>Model</Th>
        <Th>Sampling</Th>
        <Th className="text-right">Findings</Th>
        <Th className="text-right">Runs</Th>
        <Th>Created At</Th>
        <Th>Updated At</Th>
        <Th>Detector ID</Th>
        <Th className="w-[56px] text-right">Actions</Th>
      </TRHead>
    </THead>
    <TBody>
      {detectors.map((detector) => {
        const template = getTemplate(detector.template);
        const modelLabel = formatDetectorModel(detector);
        const c = counts?.[detector.id];
        const findingCount = c?.finding_count ?? 0;
        const runCount = c?.run_count ?? 0;
        return (
          <TR
            key={detector.id}
            interactive
            onClick={() => router.push(buildUrl(`/projects/${projectId}/detectors/${detector.id}`))}
          >
            <Td className="text-foreground">{detector.name}</Td>
            <Td className="text-muted-foreground">{template?.label ?? detector.template}</Td>
            <Td className="text-muted-foreground">{modelLabel}</Td>
            <Td className="text-muted-foreground">{detector.sampleRate}%</Td>
            <Td className="text-right tabular-nums text-muted-foreground">
              {countsLoading ? "—" : findingCount}
            </Td>
            <Td className="text-right tabular-nums text-muted-foreground">
              {countsLoading ? "—" : runCount}
            </Td>
            <Td className="whitespace-nowrap text-muted-foreground">
              <Timestamp iso={detector.createTime} />
            </Td>
            <Td className="whitespace-nowrap text-muted-foreground">
              <Timestamp iso={detector.updateTime} />
            </Td>
            <Td
              className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground"
              title={detector.id}
            >
              {detector.id}
            </Td>
            <Td className="text-right">
              <Popover open={actionsOpen === detector.id} ...>
                {/* trigger + content unchanged */}
              </Popover>
            </Td>
          </TR>
        );
      })}
    </TBody>
  </Table>
)}
```

(Delete the old `countClass` const.)

- [ ] **Step 4: Run tests** — `pnpm exec vitest run src/app/projects/[projectId]/detectors/page.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/ui/src/app/projects/[projectId]/detectors/ && git commit -m "feat(detectors): unify list states and move onto shared table primitives"`

---

### Task 6: Users + Sessions lists

**Files:**
- Modify: `frontend/ui/src/app/projects/[projectId]/users/page.tsx`
- Modify: `frontend/ui/src/app/projects/[projectId]/sessions/page.tsx`

No page tests exist for either; verify via `pnpm lint` + typecheck through `tsc --noEmit` if available, plus full suite.

- [ ] **Step 1: Implement `users/page.tsx`**

Imports: add `AlertTriangle` to lucide; `ListState, ListLoading`; `Table, TBody, Td, Th, THead, TR, TRHead`; `Timestamp`; remove `LoadingState` and `formatDate` (only used in Last Activity cell).

`const { data, isPending, error, refetch } = useUsers(...)` — check the actual destructure the page already uses (`checking` gate) and add `refetch`.

Replace states (138-157):

```tsx
{checking ? (
  <ListLoading label="Loading users..." />
) : error && !data ? (
  <ListState
    icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
    title="Error loading users"
    description="Make sure the API server is running and you have API keys configured."
    action={
      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => refetch()}>
        Try again
      </Button>
    }
  />
) : users.length === 0 ? (
  <ListState
    icon={<DOMAIN_ICONS.user className="h-8 w-8 text-muted-foreground/40" />}
    title="No users found"
    description="Users will appear here when traces include user_id."
  />
) : ( /* table */ )}
```

Migrate the table (161-215) to primitives with the same cell classes used above: `User ID` cell becomes `<Td className="max-w-[300px] truncate text-foreground" title={user.user_id}>{user.user_id}</Td>`; count/tokens/cost cells `<Td className="text-muted-foreground">`; Last Activity `<Td className="whitespace-nowrap text-muted-foreground"><Timestamp iso={user.last_trace_time} /></Td>`; rows `<TR interactive onClick={() => handleUserClick(user.user_id)}>`; headers `<Th>`/`<Th className="w-[100px]">`-style widths preserved, last header `w-[160px]`. Keep `py-2` → shared `py-1.5` (unification).

- [ ] **Step 2: Implement `sessions/page.tsx`** — same pattern:

States: `ListLoading label="Loading sessions..."`; error ListState same shape; empty `<ListState icon={<DOMAIN_ICONS.session className="h-8 w-8 text-muted-foreground/40" />} title="No sessions found" description="Sessions will appear here when traces include session_id." />`.

Table (160-228): headers `Timestamp w-[140px]`, `Session ID`, `User ID`, `Tokens w-[110px]`, `Cost w-[100px]`, `Traces w-[70px]`; rows `<TR interactive onClick={() => setSelectedSessionId(session.session_id)}>`; Timestamp cell `<Timestamp iso={session.first_trace_time} />`; Session ID cell `<Td className="max-w-[300px] truncate font-medium text-foreground" title={session.session_id}>{session.session_id}</Td>`; other cells `<Td className="text-muted-foreground">` (tokens/cost keep their `title` spans verbatim). Destructure `refetch` from `useSessions`.

- [ ] **Step 3: Verify** — `pnpm exec vitest run` (full) and `pnpm lint` in `frontend/ui`. Both green.
- [ ] **Step 4: Commit** — `git add frontend/ui/src/app/projects/[projectId]/users/ frontend/ui/src/app/projects/[projectId]/sessions/ && git commit -m "feat(users-sessions): unify list states and tables with the main lists"`

---

### Task 7: Full verification

- [ ] **Step 1:** `cd frontend/ui && pnpm test` → full suite green.
- [ ] **Step 2:** `pnpm lint` → clean.
- [ ] **Step 3:** `pnpm format:check` → clean (run `pnpm format` if it reports whitespace diffs, then re-check).
- [ ] **Step 4:** Grep to confirm no leftovers: `TableEmpty` (0 hits outside git history), `border-r border-border/50 px-3 py-1.5` hand-rolled cells gone from the six list pages, `formatDate(` gone from the six pages.
- [ ] **Step 5:** Commit any format fixups. Report done.