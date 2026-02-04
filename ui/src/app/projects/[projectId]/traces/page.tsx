'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ChevronDown, Workflow, Users, Layers, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchFilterBar } from '@/components/search-filter-bar'
import { ProjectBreadcrumb } from '@/features/projects/components'
import { formatDuration, formatDate, cn } from '@/lib/utils'
import type { TraceListItem } from '@/types/api'
import { useTraces, useListPageState } from '@/features/traces/hooks'
import { TraceViewerPanel } from '@/features/traces/components'
import { formatContentPreview } from '@/features/traces/utils'

// Tab definitions
const tabs = [
  { id: 'traces', label: 'Traces', icon: Workflow, href: 'traces' },
  { id: 'sessions', label: 'Sessions', icon: Layers, href: 'sessions' },
  { id: 'users', label: 'Users', icon: Users, href: 'users' },
]

export default function TracesPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const projectId = params.projectId as string
  const userId = searchParams.get('user_id')

  // Use URL-synced state management hook (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState()

  // UI state for popovers
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  // Fetch traces with combined query options + user filter from URL
  const { data, isLoading, error } = useTraces(projectId, {
    ...queryOptions,
    user_id: userId || undefined,
  })

  const traces = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  // Build URL with preserved date filter params
  const buildUrlWithFilters = (path: string, extraParams?: Record<string, string>) => {
    const params = new URLSearchParams()

    // Add extra params
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        params.set(key, value)
      }
    }

    // Preserve date filter params
    const dateFilter = searchParams.get('date_filter')
    const start = searchParams.get('start')
    const end = searchParams.get('end')

    if (dateFilter) params.set('date_filter', dateFilter)
    if (start) params.set('start', start)
    if (end) params.set('end', end)

    const queryString = params.toString()
    return queryString ? `${path}?${queryString}` : path
  }

  return (
    <div className="flex h-full relative text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Tab navigation */}
        <div className="border-b border-border bg-background">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === 'traces'
              return (
                <Link
                  key={tab.id}
                  href={buildUrlWithFilters(`/projects/${projectId}/${tab.href}`)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-foreground bg-muted text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Filters bar */}
        <SearchFilterBar
          searchValue={state.keyword}
          onSearchChange={updateKeyword}
          searchPlaceholder="Search..."
          dateFilter={state.dateFilter}
          customStartDate={state.customStartDate}
          customEndDate={state.customEndDate}
          onDateFilterChange={updateDateFilter}
          onCustomRangeChange={updateCustomRange}
        >
          {userId && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 pl-2.5 pr-1.5 py-1">
              <Users className="h-3 w-3 text-muted-foreground" />
              <span className="text-[12px] text-muted-foreground">User:</span>
              <span className="text-[12px] font-medium text-foreground">{userId}</span>
              <button
                type="button"
                onClick={() => router.push(buildUrlWithFilters(`/projects/${projectId}/traces`))}
                className="ml-1 rounded hover:bg-muted p-0.5 transition-colors"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          )}
        </SearchFilterBar>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-muted-foreground text-[13px]">Loading traces...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <p className="text-destructive text-[13px]">Error loading traces</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running and you have API keys configured.
              </p>
            </div>
          ) : traces.length === 0 ? (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <p className="text-muted-foreground text-[13px]">No traces found</p>
              <p className="text-[12px] text-muted-foreground">
                Start sending traces using the SDK to see them here.
              </p>
            </div>
          ) : (
              <div className="flex flex-col h-full">
                <div className="flex-1 overflow-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border bg-muted/50">
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50 w-[140px]">
                          Timestamp
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50">
                          Name
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50">
                          Trace ID
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50">
                          Input
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50">
                          Output
                        </th>
                        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
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
                            "border-b border-border/50 last:border-0 cursor-pointer transition-colors",
                            selectedTraceId === trace.trace_id ? "bg-muted" : "hover:bg-muted/50"
                          )}
                        >
                          <td className="px-3 py-1.5 text-[12px] text-muted-foreground whitespace-nowrap border-r border-border/50">
                            {formatDate(trace.trace_start_time)}
                          </td>
                          <td className="px-3 py-1.5 text-[12px] text-foreground border-r border-border/50">
                            {trace.name}
                          </td>
                          <td className="px-3 py-1.5 text-[11px] font-mono text-muted-foreground border-r border-border/50">
                            {trace.trace_id.substring(0, 8)}...
                          </td>
                          <td className="px-3 py-1.5 max-w-[180px] border-r border-border/50">
                            <span className="text-muted-foreground text-[11px] font-mono truncate block">
                              {formatContentPreview(trace.input)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 max-w-[180px] border-r border-border/50">
                            <span className="text-muted-foreground text-[11px] font-mono truncate block">
                              {formatContentPreview(trace.output)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-[12px] text-foreground whitespace-nowrap">
                            {formatDuration(trace.duration_ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="border-t border-border px-4 py-2.5 flex items-center justify-end gap-6 bg-background">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">Items per page</span>
                    <Popover open={itemsPerPageOpen} onOpenChange={setItemsPerPageOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 min-w-[60px] justify-between text-[12px] px-2">
                          <span>{state.limit}</span>
                          <ChevronDown className="h-3 w-3 text-muted-foreground ml-1" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent side="top" align="start" className="w-[80px] p-1">
                        {[50, 100, 200].map((value) => (
                          <button
                            key={value}
                            className={cn(
                              'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
                              state.limit === value ? 'bg-muted' : 'hover:bg-muted/50'
                            )}
                            onClick={() => {
                              updateLimit(value)
                              setItemsPerPageOpen(false)
                            }}
                          >
{value}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">Page</span>
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, totalPages)}
                      value={state.page + 1}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10)
                        if (!isNaN(val) && val >= 1 && val <= totalPages) {
                          goToPage(val - 1)
                        }
                      }}
                      className="border border-border rounded px-2 py-1 text-[12px] bg-background h-7 w-12 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-[12px] text-muted-foreground">of {Math.max(1, totalPages)}</span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <Button variant="outline" size="sm" onClick={() => goToPage(0)} disabled={state.page === 0} className="h-7 w-7 p-0">
                      <ChevronLeft className="h-3.5 w-3.5" /><ChevronLeft className="h-3.5 w-3.5 -ml-2" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => goToPage(Math.max(0, state.page - 1))} disabled={state.page === 0} className="h-7 w-7 p-0">
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => goToPage(state.page + 1)} disabled={state.page >= totalPages - 1} className="h-7 w-7 p-0">
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => goToPage(totalPages - 1)} disabled={state.page >= totalPages - 1} className="h-7 w-7 p-0">
                      <ChevronRight className="h-3.5 w-3.5" /><ChevronRight className="h-3.5 w-3.5 -ml-2" />
                    </Button>
                  </div>
                </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel - overlays header, takes 70% width, slides in from right */}
      {selectedTraceId && (
        <div className="fixed top-0 bottom-0 right-0 w-[70%] bg-background z-50 shadow-xl border-l border-border animate-slide-in-right">
          <TraceViewerPanel
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
