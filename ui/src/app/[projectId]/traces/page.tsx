'use client'

import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { getTraces, getTrace, type TraceListItem, type TraceDetail, type Span } from '@/lib/api'
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
  Sparkle,
  ArrowRight,
  Bot,
  Wrench,
  ArrowUp,
  ArrowDown,
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

// Layout constants for tree alignment
const NESTING_INDENT = 22  // Space per nesting level
const ROW_HEIGHT = 28      // Height of each row (compact)
const ICON_BOX_SIZE = 18   // Size of icon box
const LEFT_PADDING = 8     // Left padding before first icon

// Icon mapping for node types
function getNodeIcon(type: string) {
  const normalizedType = type.toLowerCase()
  switch (normalizedType) {
    case 'trace':
      return Workflow
    case 'llm':
      return Sparkle
    case 'agent':
      return Bot
    case 'tool':
      return Wrench
    case 'span':
    default:
      return ArrowRight
  }
}

function NodeTypeIcon({ type, size = 'sm', selected = false, inTree = false }: { type: string; size?: 'sm' | 'md'; selected?: boolean; inTree?: boolean }) {
  const Icon = getNodeIcon(type)
  const iconSizeClass = size === 'md' ? 'h-4 w-4' : 'h-3 w-3'

  // In tree view, show icon with white background box
  if (inTree) {
    return (
      <div
        className="flex items-center justify-center rounded border bg-background flex-shrink-0"
        style={{ width: ICON_BOX_SIZE, height: ICON_BOX_SIZE }}
      >
        <Icon className="h-3 w-3 text-muted-foreground" />
      </div>
    )
  }

  // In detail panel, just show the icon
  return (
    <Icon className={cn(
      iconSizeClass,
      selected ? 'text-current' : 'text-muted-foreground'
    )} />
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
  // Lines should connect to the center of parent icon boxes
  const iconCenterOffset = ICON_BOX_SIZE / 2
  // Total width needed before the icon
  const width = LEFT_PADDING + level * NESTING_INDENT
  // Gap between icon edge and row edge (icon is centered vertically)
  const iconVerticalGap = (ROW_HEIGHT - ICON_BOX_SIZE) / 2

  if (level === 0) return <div style={{ width: LEFT_PADDING }} className="flex-shrink-0" />

  return (
    <div className="relative flex-shrink-0 overflow-visible" style={{ width, height: ROW_HEIGHT }}>
      {Array.from({ length: level }).map((_, i) => {
        const showContinuingLine = parentLevels.includes(i)
        const isCurrentLevel = i === level - 1
        // Line X position: center of the icon at this level
        const lineX = LEFT_PADDING + i * NESTING_INDENT + iconCenterOffset

        return (
          <div key={i}>
            {/* Continuing vertical line for non-terminal ancestors - extends up to touch parent icon */}
            {showContinuingLine && (
              <div
                className="absolute bg-muted-foreground/50"
                style={{
                  left: lineX,
                  top: -iconVerticalGap, // extend up to parent icon bottom
                  height: ROW_HEIGHT + iconVerticalGap, // full row + extension
                  width: 1
                }}
              />
            )}
            {/* Current level connector - L-shape */}
            {isCurrentLevel && (
              <>
                {/* Vertical part - from parent icon bottom to row center */}
                <div
                  className="absolute bg-muted-foreground/50"
                  style={{
                    left: lineX,
                    top: -iconVerticalGap, // start at parent icon bottom
                    height: isTerminal
                      ? (ROW_HEIGHT / 2 + iconVerticalGap) // to current row center
                      : ROW_HEIGHT, // to row bottom (child's line starts there)
                    width: 1
                  }}
                />
                {/* Horizontal part - extend to touch the icon box border */}
                <div
                  className="absolute bg-muted-foreground/50"
                  style={{
                    left: lineX,
                    top: Math.floor(ROW_HEIGHT / 2),
                    width: width - lineX + 1,
                    height: 1
                  }}
                />
              </>
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // Build children map to know which spans have children
  const childrenByParent = new Map<string | null, Span[]>()
  trace.spans.forEach((span) => {
    const pid = span.parent_span_id
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, [])
    childrenByParent.get(pid)!.push(span)
  })

  const hasChildren = (spanId: string | null) => {
    const children = childrenByParent.get(spanId) || []
    return children.length > 0
  }

  const toggleCollapse = (spanId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(spanId)) {
        next.delete(spanId)
      } else {
        next.add(spanId)
      }
      return next
    })
  }

  // Check if a span should be visible (not hidden by collapsed ancestor)
  const isVisible = (span: Span): boolean => {
    let currentId = span.parent_span_id
    while (currentId) {
      if (collapsedIds.has(currentId)) return false
      const parent = trace.spans.find(s => s.span_id === currentId)
      currentId = parent?.parent_span_id || null
    }
    return true
  }

  const spanRows = createSpanTree(trace.spans)
  const isTraceSelected = selection.type === 'trace'
  const traceDuration = getTraceDuration(trace)
  const traceHasChildren = hasChildren(null)
  const traceIsCollapsed = collapsedIds.has('trace')

  return (
    <div>
      {/* Trace row */}
      <div
        className={cn(
          'flex items-center cursor-pointer transition-colors rounded-sm',
          isTraceSelected
            ? 'bg-muted'
            : 'hover:bg-muted/50'
        )}
        style={{ height: ROW_HEIGHT, paddingLeft: LEFT_PADDING }}
        onClick={() => onSelect({ type: 'trace' })}
      >
        <div className="flex items-center gap-1.5 min-w-0 pr-2 flex-1">
          <NodeTypeIcon type="trace" inTree />
          <span className="truncate text-xs">{trace.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
            {formatDuration(traceDuration)}
          </span>
          <div className="flex-1" />
          {traceHasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setCollapsedIds(prev => {
                  const next = new Set(prev)
                  if (next.has('trace')) {
                    next.delete('trace')
                  } else {
                    next.add('trace')
                  }
                  return next
                })
              }}
              className="p-0.5 hover:bg-muted rounded transition-colors flex-shrink-0"
            >
              {traceIsCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Span rows */}
      {!traceIsCollapsed && spanRows.map(({ span, level, isTerminal, parentLevels }) => {
        // Skip if hidden by collapsed ancestor
        if (!isVisible(span)) return null

        const isSelected = selection.type === 'span' && selection.span.span_id === span.span_id
        const adjustedLevel = level + 1
        const adjustedParentLevels = parentLevels.map(l => l + 1)
        const spanHasChildren = hasChildren(span.span_id)
        const isCollapsed = collapsedIds.has(span.span_id)

        return (
          <div
            key={span.span_id}
            className={cn(
              'flex items-center cursor-pointer transition-colors pr-2 rounded-r-sm',
              isSelected
                ? 'bg-muted'
                : 'hover:bg-muted/50'
            )}
            style={{ height: ROW_HEIGHT }}
            onClick={() => onSelect({ type: 'span', span })}
          >
            <TreeConnector level={adjustedLevel} isTerminal={isTerminal} parentLevels={adjustedParentLevels} />
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <NodeTypeIcon type={span.span_kind} inTree />
              <span className="truncate text-xs">{span.name}</span>
              <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                {formatDuration(getSpanDuration(span))}
              </span>
              <div className="flex-1" />
              {spanHasChildren && (
                <button
                  onClick={(e) => toggleCollapse(span.span_id, e)}
                  className="p-0.5 hover:bg-muted rounded transition-colors flex-shrink-0"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// JSON Value Renderer - flat display with colored syntax
function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) {
    return <span className="text-orange-600">null</span>
  }

  if (typeof value === 'boolean') {
    return <span className="text-purple-600">{value ? 'true' : 'false'}</span>
  }

  if (typeof value === 'number') {
    return <span className="text-blue-600">{value}</span>
  }

  if (typeof value === 'string') {
    return (
      <span className="text-green-700 whitespace-pre-wrap break-words">
        &quot;{value}&quot;
      </span>
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>
    }

    return (
      <span>
        <span className="text-muted-foreground">[</span>
        <div className="ml-3">
          {value.map((item, index) => (
            <div key={index}>
              <JsonValue value={item} depth={depth + 1} />
              {index < value.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">]</span>
      </span>
    )
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    if (keys.length === 0) {
      return <span className="text-muted-foreground">{'{}'}</span>
    }

    return (
      <span>
        <span className="text-muted-foreground">{'{'}</span>
        <div className="ml-3">
          {keys.map((key, index) => (
            <div key={key}>
              <span className="text-blue-600">{key}</span>
              <span className="text-muted-foreground">: </span>
              <JsonValue value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
              {index < keys.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">{'}'}</span>
      </span>
    )
  }

  return <span>{String(value)}</span>
}

// Smart content renderer - tries to parse JSON, otherwise shows as text
function SmartContentRenderer({ content }: { content: string | null }) {
  if (!content) {
    return <span className="text-muted-foreground text-[11px]">-</span>
  }

  // Try to parse as JSON
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null) {
      return (
        <div className="text-[11px] font-mono leading-relaxed">
          <JsonValue value={parsed} />
        </div>
      )
    }
    // If it's a primitive after parsing, just show it
    return (
      <pre className="text-[11px] whitespace-pre-wrap break-words font-mono leading-relaxed">
        {content}
      </pre>
    )
  } catch {
    // Not valid JSON, show as plain text
    return (
      <pre className="text-[11px] whitespace-pre-wrap break-words font-mono leading-relaxed">
        {content}
      </pre>
    )
  }
}

// Collapsible section component
function CollapsibleSection({
  title,
  content,
  defaultOpen = true,
  onCopy,
}: {
  title: string
  content: string | null
  defaultOpen?: boolean
  onCopy?: () => void
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="border border-gray-200 rounded-md overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 transition-colors border-b border-gray-200"
      >
        <div className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-gray-500" />
          )}
          <span className="text-xs font-medium text-gray-700">{title}</span>
        </div>
        {onCopy && (
          <div
            onClick={(e) => {
              e.stopPropagation()
              onCopy()
            }}
            className="text-gray-400 hover:text-gray-600 transition-colors p-0.5"
            title="Copy"
          >
            <Copy className="h-3 w-3" />
          </div>
        )}
      </button>
      {isOpen && (
        <div className="px-2.5 py-2 bg-white">
          <SmartContentRenderer content={content} />
        </div>
      )}
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
      <div className="px-4 py-3 border-b sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2 mb-1">
          <NodeTypeIcon type={type} size="md" selected />
          <h3 className="text-sm font-medium">{name}</h3>
          <button
            onClick={() => copyToClipboard(isTrace ? trace.trace_id : selection.span.span_id)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Copy ID"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          {formatDate(timestamp)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Span Kind:</span>
            <span className="font-medium">{type.toLowerCase()}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Latency:</span>
            <span className="font-medium">{formatDuration(duration)}</span>
          </div>
          {isTrace && trace.environment && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <span className="text-muted-foreground">Env:</span>
              <span className="font-medium">{trace.environment}</span>
            </div>
          )}
          {!isTrace && selection.span.model_name && (
            <div className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.cost !== null && selection.span.cost > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <span className="font-medium">${selection.span.cost.toFixed(4)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Input */}
        <CollapsibleSection
          title="Input"
          content={input}
          defaultOpen={true}
          onCopy={input ? () => copyToClipboard(input) : undefined}
        />

        {/* Output */}
        <CollapsibleSection
          title="Output"
          content={output}
          defaultOpen={true}
          onCopy={output ? () => copyToClipboard(output) : undefined}
        />
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
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: {
  projectId: string
  traceId: string
  onClose: () => void
  onNavigate: (direction: 'up' | 'down') => void
  canNavigateUp: boolean
  canNavigateDown: boolean
}) {
  const [selection, setSelection] = useState<Selection>({ type: 'trace' })

  const { data: trace, isLoading, error } = useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
  })

  // Reset selection when navigating to a different trace
  useEffect(() => {
    setSelection({ type: 'trace' })
  }, [traceId])

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Top header bar */}
      <div className="flex items-center justify-between px-4 h-10 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Trace</span>
          <span className="text-xs text-muted-foreground font-mono truncate">
            {traceId}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Navigation buttons */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate('up')}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous trace"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate('down')}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next trace"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <div className="w-2" /> {/* Spacer */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading trace...</p>
        </div>
      ) : error || !trace ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-destructive">Error loading trace</p>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Tree view */}
          <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto">
            <TraceTreeView trace={trace} selection={selection} onSelect={setSelection} />
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 overflow-hidden">
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
      <div className="flex-1 flex flex-col">
        {/* Tab navigation */}
        <div className="border-b bg-white">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-gray-900 bg-muted'
                      : 'border-transparent hover:bg-muted/50'
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
        <div className="border-b bg-white px-3 py-1.5">
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
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100 w-[140px]">
                          Timestamp
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Name
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Trace ID
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Input
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500 border-r border-gray-100">
                          Output
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-gray-500">
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
                          <td className="px-3 py-1.5 text-[12px] text-gray-500 whitespace-nowrap border-r border-gray-100">
                            {formatDate(trace.trace_start_time)}
                          </td>
                          <td className="px-3 py-1.5 text-[12px] text-gray-900 border-r border-gray-100">
                            {trace.name}
                          </td>
                          <td className="px-3 py-1.5 text-[11px] font-mono text-gray-400 border-r border-gray-100">
                            {trace.trace_id.substring(0, 8)}...
                          </td>
                          <td className="px-3 py-1.5 max-w-[180px] border-r border-gray-100">
                            <span className="text-gray-600 text-[11px] font-mono truncate block">
                              {formatPreview(trace.input)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 max-w-[180px] border-r border-gray-100">
                            <span className="text-gray-600 text-[11px] font-mono truncate block">
                              {formatPreview(trace.output)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-[12px] text-gray-900 whitespace-nowrap">
                            {formatDuration(trace.duration_ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="border-t border-gray-200 px-4 py-2.5 flex items-center justify-end gap-6 bg-white">
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
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-gray-500">Page</span>
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, totalPages)}
                      value={meta.page + 1}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10)
                        if (!isNaN(val) && val >= 1 && val <= totalPages) {
                          setPage(val - 1)
                        }
                      }}
                      className="border border-gray-200 rounded px-2 py-1 text-[12px] bg-white h-7 w-12 text-center"
                    />
                    <span className="text-[12px] text-gray-500">of {Math.max(1, totalPages)}</span>
                  </div>
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

      {/* Detail panel - overlays header, takes 70% width, slides in from right */}
      {selectedTraceId && (
        <div className="fixed top-0 bottom-0 right-0 w-[70%] bg-white z-50 shadow-xl border-l animate-slide-in-right">
          <TraceDetailPanel
            projectId={projectId}
            traceId={selectedTraceId}
            onClose={() => setSelectedTraceId(null)}
            onNavigate={(direction) => {
              const currentIndex = traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId)
              if (direction === 'up' && currentIndex > 0) {
                setSelectedTraceId(traces[currentIndex - 1].trace_id)
              } else if (direction === 'down' && currentIndex < traces.length - 1) {
                setSelectedTraceId(traces[currentIndex + 1].trace_id)
              }
            }}
            canNavigateUp={traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) > 0}
            canNavigateDown={traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) < traces.length - 1}
          />
        </div>
      )}
    </div>
  )
}
