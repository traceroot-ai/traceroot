'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { getTraces, getTrace, type TraceListItem, type TraceDetail, type Span } from '@/lib/api'
import { useLayout } from '@/components/layout/app-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { formatDuration, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Workflow,
  Users,
  Layers,
  X,
  Clock,
  Copy,
} from 'lucide-react'

// Tab definitions
const tabs = [
  { id: 'traces', label: 'Traces', icon: Workflow },
  { id: 'sessions', label: 'Sessions', icon: Layers },
  { id: 'users', label: 'Users', icon: Users },
]

const timeRangeOptions = [
  { label: 'Past 24 hours', value: '1d' },
  { label: 'Past 7 days', value: '7d' },
  { label: 'Past 30 days', value: '30d' },
  { label: 'Past 90 days', value: '90d' },
  { label: 'All time', value: 'all' },
]

function truncateText(text: string | null, maxLength: number = 50): string {
  if (!text) return '-'
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

function formatPreview(text: string | null): string {
  if (!text) return '-'
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object') {
      const preview = JSON.stringify(parsed).substring(0, 80)
      return preview.length < JSON.stringify(parsed).length ? preview + '...' : preview
    }
    return truncateText(String(parsed), 80)
  } catch {
    return truncateText(text, 80)
  }
}

// ============================================================================
// Trace Detail Panel Components
// ============================================================================

const NESTING_INDENT = 24

function NodeTypeBadge({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' }) {
  const baseStyles = 'inline-flex items-center justify-center font-semibold uppercase tracking-wider rounded'
  const sizeStyles = size === 'md'
    ? 'px-2.5 py-1 text-[10px]'
    : 'px-2 py-0.5 text-[9px]'

  // Clean black/white palette
  const isTrace = type.toLowerCase() === 'trace'

  return (
    <span className={cn(
      baseStyles,
      sizeStyles,
      isTrace
        ? 'bg-gray-900 text-white'
        : 'bg-white text-gray-600 border border-gray-200'
    )}>
      {type}
    </span>
  )
}

type Selection = { type: 'trace' } | { type: 'span'; span: Span }

function getSpanDuration(span: Span): number | null {
  if (!span.span_start_time || !span.span_end_time) return null
  return new Date(span.span_end_time).getTime() - new Date(span.span_start_time).getTime()
}

interface SpanRow {
  span: Span
  level: number
  isTerminal: boolean
  parentLevels: number[]
}

function createSpanTree(spans: Span[]): SpanRow[] {
  const childrenByParent = new Map<string | null, Span[]>()
  spans.forEach((span) => {
    const pid = span.parent_span_id
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, [])
    childrenByParent.get(pid)!.push(span)
  })

  const rows: SpanRow[] = []

  function traverse(span: Span, level: number, isTerminal: boolean, parentLevels: number[]) {
    rows.push({ span, level, isTerminal, parentLevels })
    const children = childrenByParent.get(span.span_id) || []
    children.forEach((child, idx) => {
      const childIsTerminal = idx === children.length - 1
      const nextParentLevels = isTerminal ? parentLevels : [...parentLevels, level]
      traverse(child, level + 1, childIsTerminal, nextParentLevels)
    })
  }

  const roots = childrenByParent.get(null) || []
  roots.forEach((root, idx) => {
    traverse(root, 0, idx === roots.length - 1, [])
  })

  return rows
}

function TreeConnector({ level, isTerminal, parentLevels }: { level: number; isTerminal: boolean; parentLevels: number[] }) {
  if (level === 0) return <div className="w-4 flex-shrink-0" />

  return (
    <div className="flex flex-shrink-0 items-center" style={{ width: 16 + level * NESTING_INDENT }}>
      {/* Initial padding */}
      <div className="w-4 flex-shrink-0" />

      {Array.from({ length: level }).map((_, i) => {
        const showContinuingLine = parentLevels.includes(i)
        const isCurrentLevel = i === level - 1

        return (
          <div
            key={i}
            className="relative flex-shrink-0"
            style={{ width: NESTING_INDENT, height: 40 }}
          >
            {/* Continuing vertical line for non-terminal ancestors */}
            {showContinuingLine && (
              <div
                className="absolute w-px bg-gray-300"
                style={{ left: NESTING_INDENT / 2, top: 0, bottom: 0 }}
              />
            )}
            {/* Current level connector - L-shape */}
            {isCurrentLevel && (
              <>
                {/* Vertical part of L */}
                <div
                  className="absolute w-px bg-gray-300"
                  style={{
                    left: NESTING_INDENT / 2,
                    top: 0,
                    height: isTerminal ? 20 : 40
                  }}
                />
                {/* Horizontal part of L */}
                <div
                  className="absolute h-px bg-gray-300"
                  style={{
                    left: NESTING_INDENT / 2,
                    top: 20,
                    width: NESTING_INDENT / 2
                  }}
                />
              </>
            )}
          </div>
        )
      })}
      {/* Gap after connector - more horizontal space */}
      <div className="w-4 flex-shrink-0" />
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
    <div className="py-3 px-2">
      {/* Trace row */}
      <div
        className={cn(
          'flex items-center cursor-pointer transition-all h-10 px-3 rounded-lg',
          isTraceSelected
            ? 'bg-gray-900 text-white'
            : 'hover:bg-gray-50'
        )}
        onClick={() => onSelect({ type: 'trace' })}
      >
        <div className="w-4 flex-shrink-0" />
        <div className="flex-1 flex items-center gap-3 min-w-0">
          <span className="px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-white text-gray-900 rounded">
            Trace
          </span>
          <span className={cn(
            'flex-1 truncate text-[13px] font-medium',
            isTraceSelected ? 'text-white' : 'text-gray-800'
          )}>{trace.name}</span>
          <span className={cn(
            'text-[11px] font-mono whitespace-nowrap',
            isTraceSelected ? 'text-gray-300' : 'text-gray-400'
          )}>
            {formatDuration(traceDuration)}
          </span>
        </div>
      </div>

      {/* Span rows */}
      {spanRows.map(({ span, level, isTerminal, parentLevels }) => {
        const isSelected = selection.type === 'span' && selection.span.span_id === span.span_id
        const adjustedLevel = level + 1
        const adjustedParentLevels = parentLevels.map(l => l + 1)

        return (
          <div
            key={span.span_id}
            className={cn(
              'flex items-center cursor-pointer transition-all h-10 pr-3 rounded-r-lg',
              isSelected
                ? 'bg-gray-100'
                : 'hover:bg-gray-50'
            )}
            onClick={() => onSelect({ type: 'span', span })}
          >
            <TreeConnector level={adjustedLevel} isTerminal={isTerminal} parentLevels={adjustedParentLevels} />
            <div className="flex-1 flex items-center gap-3 min-w-0">
              <span className={cn(
                'px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider rounded border',
                isSelected
                  ? 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white text-gray-500 border-gray-200'
              )}>
                {span.span_kind}
              </span>
              <span className={cn(
                'flex-1 truncate text-[13px]',
                isSelected ? 'text-gray-900 font-medium' : 'text-gray-600'
              )}>{span.name}</span>
              <span className="text-[11px] text-gray-400 font-mono whitespace-nowrap">
                {formatDuration(getSpanDuration(span))}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DetailRightPanel({ trace, selection }: { trace: TraceDetail; selection: Selection }) {
  const isTrace = selection.type === 'trace'
  const name = isTrace ? trace.name : selection.span.name
  const type = isTrace ? 'trace' : selection.span.span_kind
  const duration = isTrace ? getTraceDuration(trace) : getSpanDuration(selection.span)
  const timestamp = isTrace ? trace.trace_start_time : selection.span.span_start_time
  const input = isTrace ? trace.input : selection.span.input
  const output = isTrace ? trace.output : selection.span.output

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 sticky top-0 bg-white z-10">
        <div className="flex items-center gap-2 mb-2">
          <NodeTypeBadge type={type} size="md" />
          <h3 className="text-[15px] font-semibold text-gray-900">{name}</h3>
          <button
            onClick={() => copyToClipboard(isTrace ? trace.trace_id : selection.span.span_id)}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Copy ID"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="text-[12px] text-gray-500 mb-3">
          {formatDate(timestamp)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[12px]">
            <Clock className="h-3 w-3 text-gray-400" />
            <span className="text-gray-500">Latency:</span>
            <span className="font-medium text-gray-900">{formatDuration(duration)}</span>
          </div>
          {isTrace && trace.environment && (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[12px]">
              <span className="text-gray-500">Env:</span>
              <span className="font-medium text-gray-900">{trace.environment}</span>
            </div>
          )}
          {!isTrace && selection.span.model_name && (
            <div className="inline-flex items-center rounded-md bg-gray-900 px-2.5 py-1 text-[12px] text-white">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.cost !== null && selection.span.cost > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[12px]">
              <span className="font-medium text-gray-900">${selection.span.cost.toFixed(4)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Content - scrolls as one unit */}
      <div className="p-4 space-y-5">
        {/* Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[13px] font-semibold text-gray-900">Input</h4>
            <button
              onClick={() => input && copyToClipboard(input)}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
            <pre className="text-[12px] whitespace-pre-wrap break-words text-gray-800 font-mono">
              {input || '-'}
            </pre>
          </div>
        </div>

        {/* Output */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[13px] font-semibold text-gray-900">Output</h4>
            <button
              onClick={() => output && copyToClipboard(output)}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
            <pre className="text-[12px] whitespace-pre-wrap break-words text-gray-800 font-mono">
              {output || '-'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

function getTraceDuration(trace: TraceDetail): number | null {
  if (!trace.spans.length) return null
  const startTimes = trace.spans.map((s) => new Date(s.span_start_time).getTime())
  const endTimes = trace.spans.filter((s) => s.span_end_time).map((s) => new Date(s.span_end_time!).getTime())
  if (!endTimes.length) return null
  return Math.max(...endTimes) - Math.min(...startTimes)
}

// Full-screen slide-in panel (covers everything including header)
function TraceDetailPanel({
  projectId,
  traceId,
  onClose,
}: {
  projectId: string
  traceId: string
  onClose: () => void
}) {
  const [selection, setSelection] = useState<Selection>({ type: 'trace' })

  const { data: trace, isLoading, error } = useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
  })

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Top header bar - with workflow icon + "Trace" + ID */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-3 min-w-0">
          <Workflow className="h-4 w-4 text-gray-600" />
          <span className="text-[13px] font-medium text-gray-700">Trace</span>
          <span className="text-[12px] text-gray-400 font-mono">
            {traceId}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 w-7 p-0 text-gray-400 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Subheader - trace name with badge */}
      {trace && (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white">
          <NodeTypeBadge type="trace" size="md" />
          <h2 className="text-[15px] font-semibold text-gray-900">{trace.name}</h2>
          <button
            onClick={() => copyToClipboard(traceId)}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Copy Trace ID"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-gray-500">Loading trace...</p>
        </div>
      ) : error || !trace ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-red-600">Error loading trace</p>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Tree view */}
          <div className="w-[340px] flex-shrink-0 border-r border-gray-200 overflow-y-auto bg-white">
            <TraceTreeView trace={trace} selection={selection} onSelect={setSelection} />
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 overflow-hidden bg-white">
            <DetailRightPanel trace={trace} selection={selection} />
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function TracesPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const { sidebarCollapsed } = useLayout()
  const [activeTab, setActiveTab] = useState('traces')
  const [page, setPage] = useState(0)
  const [limit, setLimit] = useState(50)
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState(timeRangeOptions[2])
  const [timeRangeOpen, setTimeRangeOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['traces', projectId, page, limit, search, timeRange.value],
    queryFn: () =>
      getTraces(projectId, '', {
        page,
        limit,
        name: search || undefined,
      }),
    enabled: activeTab === 'traces',
  })

  const traces = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  return (
    <div className="flex h-full relative text-[13px]">
      {/* Main content */}
      <div className={cn(
        "flex-1 flex flex-col transition-opacity duration-200",
        selectedTraceId ? "opacity-0 pointer-events-none" : "opacity-100"
      )}>
        {/* Tab navigation */}
        <div className="border-b bg-white px-6">
          <div className="flex gap-6">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-2 py-2.5 text-[13px] font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-gray-900 text-gray-900'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Filters bar */}
        <div className="border-b bg-white px-6 py-2.5">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
                className="pl-8 h-8 text-[13px] border-gray-200"
              />
            </div>
            <div className="flex-1" />
            <Popover open={timeRangeOpen} onOpenChange={setTimeRangeOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 min-w-[140px] justify-between text-[13px] border-gray-200">
                  <span>{timeRange.label}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[160px] p-1">
                {timeRangeOptions.map((option) => (
                  <button
                    key={option.value}
                    className={cn(
                      'w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                      timeRange.value === option.value ? 'bg-gray-100' : 'hover:bg-gray-50'
                    )}
                    onClick={() => {
                      setTimeRange(option)
                      setTimeRangeOpen(false)
                      setPage(0)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-white">
          {activeTab === 'traces' ? (
            isLoading ? (
              <div className="flex h-64 items-center justify-center">
                <p className="text-gray-500 text-[13px]">Loading traces...</p>
              </div>
            ) : error ? (
              <div className="flex h-64 items-center justify-center flex-col gap-3">
                <p className="text-red-600 text-[13px]">Error loading traces</p>
                <p className="text-[12px] text-gray-500">
                  Make sure the API server is running and you have API keys configured.
                </p>
              </div>
            ) : traces.length === 0 ? (
              <div className="flex h-64 items-center justify-center flex-col gap-3">
                <p className="text-gray-500 text-[13px]">No traces found</p>
                <p className="text-[12px] text-gray-500">
                  Start sending traces using the SDK to see them here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex-1 overflow-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-gray-200 bg-gray-50/50">
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100 w-[140px]">
                          Timestamp
                        </th>
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Name
                        </th>
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Trace ID
                        </th>
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Input
                        </th>
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Output
                        </th>
                        <th className="px-3 py-2 text-left text-[12px] font-medium text-gray-500">
                          Latency
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {traces.map((trace: TraceListItem) => (
                        <tr
                          key={trace.trace_id}
                          onClick={() => setSelectedTraceId(trace.trace_id)}
                          className={cn(
                            "border-b border-gray-100 last:border-0 cursor-pointer transition-colors",
                            selectedTraceId === trace.trace_id ? "bg-gray-100" : "hover:bg-gray-50"
                          )}
                        >
                          <td className="px-3 py-2 text-[12px] text-gray-500 whitespace-nowrap border-r border-gray-100">
                            {formatDate(trace.trace_start_time)}
                          </td>
                          <td className="px-3 py-2 text-[12px] text-gray-900 border-r border-gray-100">
                            {trace.name}
                          </td>
                          <td className="px-3 py-2 text-[11px] font-mono text-gray-400 border-r border-gray-100">
                            {trace.trace_id.substring(0, 8)}...
                          </td>
                          <td className="px-3 py-2 max-w-[180px] border-r border-gray-100">
                            <span className="text-gray-600 text-[11px] font-mono truncate block">
                              {formatPreview(trace.input)}
                            </span>
                          </td>
                          <td className="px-3 py-2 max-w-[180px] border-r border-gray-100">
                            <span className="text-gray-600 text-[11px] font-mono truncate block">
                              {formatPreview(trace.output)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[12px] text-gray-900 whitespace-nowrap">
                            {formatDuration(trace.duration_ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="border-t border-gray-200 px-4 py-2.5 flex items-center justify-end gap-6 bg-white">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-gray-500">
                      Page {meta.page + 1} of {Math.max(1, totalPages)}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Button variant="outline" size="sm" onClick={() => setPage(0)} disabled={page === 0} className="h-7 w-7 p-0 border-gray-200">
                        <ChevronLeft className="h-3.5 w-3.5" /><ChevronLeft className="h-3.5 w-3.5 -ml-2" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="h-7 w-7 p-0 border-gray-200">
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1} className="h-7 w-7 p-0 border-gray-200">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="h-7 w-7 p-0 border-gray-200">
                        <ChevronRight className="h-3.5 w-3.5" /><ChevronRight className="h-3.5 w-3.5 -ml-2" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-gray-500">Items per page</span>
                    <select
                      className="border border-gray-200 rounded px-2 py-1 text-[12px] bg-white h-7"
                      value={limit}
                      onChange={(e) => {
                        setLimit(Number(e.target.value))
                        setPage(0)
                      }}
                    >
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={200}>200</option>
                    </select>
                  </div>
                </div>
              </div>
            )
          ) : activeTab === 'sessions' ? (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <Layers className="h-10 w-10 text-gray-400" />
              <p className="text-gray-500 text-[13px]">Sessions view coming soon</p>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <Users className="h-10 w-10 text-gray-400" />
              <p className="text-gray-500 text-[13px]">Users view coming soon</p>
            </div>
          )}
        </div>
      </div>

      {/* Slide-in detail panel - positioned below the top header */}
      <div
        className={cn(
          "fixed top-14 bottom-0 right-0 bg-white transition-all duration-300 ease-in-out z-50 shadow-lg",
          sidebarCollapsed ? "left-14" : "left-52",
          selectedTraceId ? "translate-x-0" : "translate-x-full"
        )}
      >
        {selectedTraceId && (
          <TraceDetailPanel
            projectId={projectId}
            traceId={selectedTraceId}
            onClose={() => setSelectedTraceId(null)}
          />
        )}
      </div>
    </div>
  )
}
