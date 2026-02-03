'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { Search, ChevronLeft, ChevronRight, ChevronDown, Workflow, Users, Layers, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProjectBreadcrumb } from '@/features/projects/components'
import { formatDuration, formatDate, cn } from '@/lib/utils'
import type { TraceListItem } from '@/types/api'
import { useTraces } from '@/features/traces/hooks'
import { TraceViewerPanel } from '@/features/traces/components'
import { formatContentPreview } from '@/features/traces/utils'

// Tab definitions
const tabs = [
  { id: 'traces', label: 'Traces', icon: Workflow, href: 'traces' },
  { id: 'sessions', label: 'Sessions', icon: Layers, href: 'sessions' },
  { id: 'users', label: 'Users', icon: Users, href: 'users' },
]

const timeRangeOptions = [
  { label: 'Past 24 hours', value: '1d' },
  { label: 'Past 7 days', value: '7d' },
  { label: 'Past 30 days', value: '30d' },
  { label: 'Past 90 days', value: '90d' },
  { label: 'All time', value: 'all' },
]

export default function TracesPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const projectId = params.projectId as string
  const userId = searchParams.get('user_id')
  const [page, setPage] = useState(0)
  const [limit, setLimit] = useState(50)
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState(timeRangeOptions[2])
  const [timeRangeOpen, setTimeRangeOpen] = useState(false)
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const { data, isLoading, error } = useTraces(projectId, {
    page,
    limit,
    name: search || undefined,
    user_id: userId || undefined,
  })

  const traces = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  return (
    <div className="flex h-full relative text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Tab navigation */}
        <div className="border-b bg-white">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === 'traces'
              return (
                <Link
                  key={tab.id}
                  href={`/projects/${projectId}/${tab.href}`}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-gray-900 bg-muted'
                      : 'border-transparent hover:bg-muted/50'
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
            {userId && (
              <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-muted/40 pl-2.5 pr-1.5 py-1">
                <Users className="h-3 w-3 text-muted-foreground" />
                <span className="text-[12px] text-muted-foreground">User:</span>
                <span className="text-[12px] font-medium text-gray-900">{userId}</span>
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${projectId}/traces`)}
                  className="ml-1 rounded hover:bg-muted p-0.5 transition-colors"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            )}
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
          {isLoading ? (
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
                              {formatContentPreview(trace.input)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 max-w-[180px] border-r border-gray-100">
                            <span className="text-gray-600 text-[11px] font-mono truncate block">
                              {formatContentPreview(trace.output)}
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
                    <Popover open={itemsPerPageOpen} onOpenChange={setItemsPerPageOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 min-w-[60px] justify-between text-[12px] border-gray-200 px-2">
                          <span>{limit}</span>
                          <ChevronDown className="h-3 w-3 text-gray-400 ml-1" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent side="top" align="start" className="w-[80px] p-1">
                        {[50, 100, 200].map((value) => (
                          <button
                            key={value}
                            className={cn(
                              'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
                              limit === value ? 'bg-gray-100' : 'hover:bg-gray-50'
                            )}
                            onClick={() => {
                              setLimit(value)
                              setPage(0)
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
                      className="border border-gray-200 rounded px-2 py-1 text-[12px] bg-white h-7 w-12 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
          )}
        </div>
      </div>

      {/* Detail panel - overlays header, takes 70% width, slides in from right */}
      {selectedTraceId && (
        <div className="fixed top-0 bottom-0 right-0 w-[70%] bg-white z-50 shadow-xl border-l animate-slide-in-right">
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
