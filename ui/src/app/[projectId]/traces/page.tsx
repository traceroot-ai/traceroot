'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { getTraces, type TraceListItem } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Search, ChevronLeft, ChevronRight, ChevronDown, Calendar } from 'lucide-react'

const timeRangeOptions = [
  { label: 'Last 24 hours', value: '1d', days: 1 },
  { label: 'Last 7 days', value: '7d', days: 7 },
  { label: 'Last 30 days', value: '30d', days: 30 },
  { label: 'Last 90 days', value: '90d', days: 90 },
  { label: 'All time', value: 'all', days: null },
]

export default function TracesPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState(timeRangeOptions[2]) // Default to 30 days
  const [timeRangeOpen, setTimeRangeOpen] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['traces', projectId, page, search, timeRange.value],
    queryFn: () =>
      getTraces(projectId, '', {
        page,
        limit: 50,
        name: search || undefined,
      }),
  })

  const traces = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  return (
    <div className="flex h-full flex-col">
      {/* Header section */}
      <div className="border-b bg-background">
        <div className="px-6 py-4">
          <h1 className="text-xl font-semibold">Traces</h1>
        </div>
      </div>

      {/* Filters bar */}
      <div className="border-b bg-background px-6 py-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0) // Reset to first page on search
              }}
              className="pl-9"
            />
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Time range filter */}
          <Popover open={timeRangeOpen} onOpenChange={setTimeRangeOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="min-w-[160px] justify-between">
                <span className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  {timeRange.label}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[180px] p-1">
              {timeRangeOptions.map((option) => (
                <button
                  key={option.value}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    timeRange.value === option.value
                      ? 'bg-accent'
                      : 'hover:bg-accent'
                  )}
                  onClick={() => {
                    setTimeRange(option)
                    setTimeRangeOpen(false)
                    setPage(0) // Reset to first page on time range change
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
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-muted-foreground">Loading traces...</p>
          </div>
        ) : error ? (
          <div className="flex h-64 items-center justify-center flex-col gap-4">
            <p className="text-destructive">Error loading traces</p>
            <p className="text-sm text-muted-foreground">
              Make sure the API server is running and you have API keys configured.
            </p>
          </div>
        ) : traces.length === 0 ? (
          <div className="flex h-64 items-center justify-center flex-col gap-4">
            <p className="text-muted-foreground">No traces found</p>
            <p className="text-sm text-muted-foreground">
              Start sending traces using the SDK to see them here.
            </p>
          </div>
        ) : (
          <>
            {/* Traces table */}
            <div className="rounded-lg border">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Duration
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Spans
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((trace: TraceListItem) => (
                    <tr
                      key={trace.trace_id}
                      className="border-b last:border-0 hover:bg-muted/50"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/${projectId}/traces/${trace.trace_id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {trace.name}
                        </Link>
                        {trace.user_id && (
                          <p className="text-xs text-muted-foreground">
                            User: {trace.user_id}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={trace.status === 'ok' ? 'success' : 'destructive'}
                        >
                          {trace.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatDuration(trace.duration_ms)}
                      </td>
                      <td className="px-4 py-3 text-sm">{trace.span_count}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatRelativeTime(trace.trace_start_time)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Showing {meta.page * meta.limit + 1} to{' '}
                  {Math.min((meta.page + 1) * meta.limit, meta.total)} of{' '}
                  {meta.total} traces
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages - 1}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
