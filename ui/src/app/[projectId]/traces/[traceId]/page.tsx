'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { getTrace, type Span, type TraceDetail } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { formatDuration, formatDate } from '@/lib/utils'
import { ArrowLeft, Clock, Cpu, DollarSign } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

const NESTING_INDENT = 20

function NodeTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    trace: 'bg-blue-600 text-white',
    llm: 'bg-neutral-800 text-white',
    span: 'bg-neutral-500 text-white',
    agent: 'bg-neutral-700 text-white',
    tool: 'bg-neutral-600 text-white',
  }
  return (
    <span className={cn(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
      styles[type.toLowerCase()] || 'bg-neutral-500 text-white'
    )}>
      {type}
    </span>
  )
}

// Selection can be either trace or span
type Selection = { type: 'trace' } | { type: 'span'; span: Span }

function getSpanDuration(span: Span): number | null {
  if (!span.span_start_time || !span.span_end_time) return null
  const start = new Date(span.span_start_time).getTime()
  const end = new Date(span.span_end_time).getTime()
  return end - start
}

// Linearized span row for rendering
interface SpanRow {
  span: Span
  level: number
  isTerminal: boolean // Last child of parent (for L-shaped connector)
  parentLevels: number[] // Ancestor levels that need continuing vertical lines
}

function createSpanTree(spans: Span[]): SpanRow[] {
  // Build parent -> children map
  const childrenByParent = new Map<string | null, Span[]>()
  spans.forEach((span) => {
    const pid = span.parent_span_id
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, [])
    childrenByParent.get(pid)!.push(span)
  })

  const rows: SpanRow[] = []

  // Recursive traversal (Phoenix style)
  function traverse(span: Span, level: number, isTerminal: boolean, parentLevels: number[]) {
    rows.push({ span, level, isTerminal, parentLevels })

    const children = childrenByParent.get(span.span_id) || []
    children.forEach((child, idx) => {
      const childIsTerminal = idx === children.length - 1
      // If current node is not terminal, add its level to parentLevels for children
      const nextParentLevels = isTerminal ? parentLevels : [...parentLevels, level]
      traverse(child, level + 1, childIsTerminal, nextParentLevels)
    })
  }

  // Start with root spans
  const roots = childrenByParent.get(null) || []
  roots.forEach((root, idx) => {
    traverse(root, 0, idx === roots.length - 1, [])
  })

  return rows
}

// L-shaped connector component (Phoenix style)
function TreeEdge({ level, isTerminal, parentLevels }: { level: number; isTerminal: boolean; parentLevels: number[] }) {
  if (level === 0) return null

  return (
    <div className="flex h-9" style={{ width: level * NESTING_INDENT }}>
      {/* Render continuing lines for non-terminal ancestors */}
      {Array.from({ length: level }).map((_, i) => {
        const showContinuingLine = parentLevels.includes(i)
        const isCurrentLevel = i === level - 1

        return (
          <div key={i} className="relative" style={{ width: NESTING_INDENT }}>
            {/* Continuing vertical line from ancestor */}
            {showContinuingLine && (
              <div
                className="absolute top-0 bottom-0 w-px bg-neutral-300"
                style={{ left: NESTING_INDENT / 2 }}
              />
            )}
            {/* L-shaped connector for current level */}
            {isCurrentLevel && (
              <div
                className={cn(
                  'absolute border-l border-b border-neutral-300',
                  isTerminal ? 'top-0 h-[18px]' : 'top-0 bottom-0'
                )}
                style={{
                  left: NESTING_INDENT / 2,
                  width: NESTING_INDENT / 2,
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function TraceTreeView({
  trace,
  selection,
  onSelect,
}: {
  trace: TraceDetail
  selection: Selection
  onSelect: (selection: Selection) => void
}) {
  const spanRows = createSpanTree(trace.spans)
  const isTraceSelected = selection.type === 'trace'
  const traceDuration = getTraceDuration(trace)

  return (
    <div className="text-sm">
      {/* Trace node at top */}
      <div
        className={cn(
          'flex items-center cursor-pointer transition-all duration-200',
          isTraceSelected
            ? 'bg-neutral-100 border-l-2 border-l-blue-600'
            : 'hover:bg-neutral-50 border-l-2 border-l-transparent'
        )}
        onClick={() => onSelect({ type: 'trace' })}
      >
        <div className="flex-1 flex items-center gap-2 py-2 px-3 min-w-0">
          <NodeTypeBadge type="trace" />
          <span className={cn(
            'flex-1 truncate',
            isTraceSelected ? 'font-semibold text-neutral-900' : 'font-medium text-neutral-700'
          )}>{trace.name}</span>
          <span className="text-xs text-neutral-400 whitespace-nowrap">
            {formatDuration(traceDuration)}
          </span>
        </div>
      </div>

      {/* Span rows with +1 level offset */}
      {spanRows.map(({ span, level, isTerminal, parentLevels }) => {
        const isSelected = selection.type === 'span' && selection.span.span_id === span.span_id
        const adjustedLevel = level + 1
        const adjustedParentLevels = parentLevels.map(l => l + 1)

        return (
          <div
            key={span.span_id}
            className={cn(
              'flex items-center cursor-pointer transition-all duration-200',
              isSelected
                ? 'bg-neutral-100 border-l-2 border-l-neutral-800'
                : 'hover:bg-neutral-50 border-l-2 border-l-transparent'
            )}
            onClick={() => onSelect({ type: 'span', span })}
          >
            {/* L-shaped tree connectors */}
            <TreeEdge level={adjustedLevel} isTerminal={isTerminal} parentLevels={adjustedParentLevels} />

            {/* Span content */}
            <div className="flex-1 flex items-center gap-2 py-2 pr-3 min-w-0">
              <NodeTypeBadge type={span.span_kind} />
              <span className={cn(
                'flex-1 truncate',
                isSelected ? 'font-semibold text-neutral-900' : 'font-medium text-neutral-700'
              )}>{span.name}</span>
              <span className="text-xs text-neutral-400 whitespace-nowrap">
                {formatDuration(getSpanDuration(span))}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TraceDetailPanel({ trace }: { trace: TraceDetail }) {
  const durationMs = getTraceDuration(trace)

  return (
    <div className="space-y-5">
      {/* Metadata badges row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
          <Clock className="h-3.5 w-3.5 text-neutral-500" />
          <span className="text-neutral-500">Latency:</span>
          <span className="font-medium text-neutral-900">{formatDuration(durationMs)}</span>
        </div>
        {trace.environment && (
          <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
            <span className="text-neutral-500">Env:</span>
            <span className="font-medium text-neutral-900">{trace.environment}</span>
          </div>
        )}
        {trace.user_id && (
          <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
            <span className="text-neutral-500">User:</span>
            <span className="font-medium text-neutral-900">{trace.user_id}</span>
          </div>
        )}
        {trace.session_id && (
          <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
            <span className="text-neutral-500">Session:</span>
            <span className="font-medium text-neutral-900">{trace.session_id}</span>
          </div>
        )}
      </div>

      {/* Input section */}
      {trace.input && (
        <div>
          <h4 className="text-xs font-semibold mb-2 text-neutral-500 uppercase tracking-wider">
            Input
          </h4>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
            <pre className="text-sm whitespace-pre-wrap break-words text-neutral-800">
              {trace.input}
            </pre>
          </div>
        </div>
      )}

      {/* Output section */}
      {trace.output && (
        <div>
          <h4 className="text-xs font-semibold mb-2 text-neutral-500 uppercase tracking-wider">
            Output
          </h4>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
            <pre className="text-sm whitespace-pre-wrap break-words text-neutral-800">
              {trace.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function SpanDetailPanel({ span }: { span: Span }) {
  const durationMs = getSpanDuration(span)

  return (
    <div className="space-y-5">
      {/* Metadata badges row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
          <Clock className="h-3.5 w-3.5 text-neutral-500" />
          <span className="text-neutral-500">Latency:</span>
          <span className="font-medium text-neutral-900">{formatDuration(durationMs)}</span>
        </div>
        {span.model_name && (
          <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
            <Cpu className="h-3.5 w-3.5 text-neutral-500" />
            <span className="font-medium text-neutral-900">{span.model_name}</span>
          </div>
        )}
        {span.cost !== null && span.cost > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2.5 py-1 text-sm">
            <DollarSign className="h-3.5 w-3.5 text-neutral-500" />
            <span className="font-medium text-neutral-900">${span.cost.toFixed(4)}</span>
          </div>
        )}
        {/* Status badge */}
        <div className={cn(
          'ml-auto inline-flex items-center rounded px-2 py-0.5 text-xs font-medium uppercase',
          span.status === 'ERROR'
            ? 'bg-red-100 text-red-700'
            : 'bg-green-100 text-green-700'
        )}>
          {span.status}
        </div>
      </div>

      {/* Input section */}
      {span.input && (
        <div>
          <h4 className="text-xs font-semibold mb-2 text-neutral-500 uppercase tracking-wider">
            Input
          </h4>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
            <pre className="text-sm whitespace-pre-wrap break-words text-neutral-800">
              {span.input}
            </pre>
          </div>
        </div>
      )}

      {/* Output section */}
      {span.output && (
        <div>
          <h4 className="text-xs font-semibold mb-2 text-neutral-500 uppercase tracking-wider">
            Output
          </h4>
          <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
            <pre className="text-sm whitespace-pre-wrap break-words text-neutral-800">
              {span.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function getTraceDuration(trace: TraceDetail): number | null {
  if (!trace.spans.length) return null
  const startTimes = trace.spans.map((s) => new Date(s.span_start_time).getTime())
  const endTimes = trace.spans
    .filter((s) => s.span_end_time)
    .map((s) => new Date(s.span_end_time!).getTime())
  if (!endTimes.length) return null
  return Math.max(...endTimes) - Math.min(...startTimes)
}

export default function TraceDetailPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const traceId = params.traceId as string
  const [selection, setSelection] = useState<Selection>({ type: 'trace' })

  const { data: trace, isLoading, error } = useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
  })

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-neutral-500">Loading trace...</p>
      </div>
    )
  }

  if (error || !trace) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-red-600">Error loading trace</p>
      </div>
    )
  }

  const durationMs = getTraceDuration(trace)

  return (
    <div className="p-6 bg-white min-h-screen">
      {/* Header */}
      <div className="mb-4">
        <Link href={`/${projectId}/traces`}>
          <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-neutral-600 hover:text-neutral-900">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to traces
          </Button>
        </Link>

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-neutral-900">{trace.name}</h2>
            <p className="text-sm text-neutral-500">
              {formatDate(trace.trace_start_time)} • {formatDuration(durationMs)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {trace.environment && (
              <span className="inline-flex items-center rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600">
                {trace.environment}
              </span>
            )}
            {trace.release && (
              <span className="inline-flex items-center rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600">
                {trace.release}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex gap-4 items-start">
        {/* Trace/Span tree */}
        <div className="w-[340px] flex-shrink-0 rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-3">
            <h3 className="font-semibold text-neutral-900">Trace & Spans ({trace.spans.length})</h3>
          </div>
          <div className="max-h-[calc(100vh-240px)] overflow-y-auto">
            <TraceTreeView
              trace={trace}
              selection={selection}
              onSelect={setSelection}
            />
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-3 flex items-center gap-3">
            {selection.type === 'trace' ? (
              <>
                <NodeTypeBadge type="trace" />
                <h3 className="font-semibold text-neutral-900 truncate">{trace.name}</h3>
              </>
            ) : (
              <>
                <NodeTypeBadge type={selection.span.span_kind} />
                <h3 className="font-semibold text-neutral-900 truncate">{selection.span.name}</h3>
              </>
            )}
          </div>
          <div className="p-4 overflow-y-auto max-h-[calc(100vh-240px)]">
            {selection.type === 'trace' ? (
              <TraceDetailPanel trace={trace} />
            ) : (
              <SpanDetailPanel span={selection.span} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
