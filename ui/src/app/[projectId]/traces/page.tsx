'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { getTraces, getApiKeys, type TraceListItem } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDuration, formatTokens, formatRelativeTime } from '@/lib/utils'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'

export default function TracesPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')

  // First get API keys to use for authentication
  const { data: keysData } = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: () => getApiKeys(projectId),
  })

  const apiKey = keysData?.data?.[0]?.key_prefix
    ? `${keysData.data[0].key_prefix}...` // Display key prefix
    : null

  // For MVP, we'll show a message if no API key
  const { data, isLoading, error } = useQuery({
    queryKey: ['traces', projectId, page, search],
    queryFn: () =>
      getTraces(projectId, '', {
        page,
        limit: 50,
        name: search || undefined,
      }),
    enabled: true, // For MVP, try without auth first
  })

  const traces = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Traces</h2>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-64"
            />
          </div>
        </div>
      </div>

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
                    Tokens
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
                    key={trace.id}
                    className="border-b last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/${projectId}/traces/${trace.id}`}
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
                    <td className="px-4 py-3 text-sm">
                      {formatTokens(trace.total_tokens)}
                    </td>
                    <td className="px-4 py-3 text-sm">{trace.span_count}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatRelativeTime(trace.timestamp)}
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
  )
}
