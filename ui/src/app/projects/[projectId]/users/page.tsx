'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Workflow, Users, Layers, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchFilterBar } from '@/components/search-filter-bar'
import { ProjectBreadcrumb } from '@/features/projects/components'
import { useUsers, useListPageState } from '@/features/traces/hooks'
import { formatDate, cn } from '@/lib/utils'
import type { UserListItem } from '@/lib/api/users'
import type { UserQueryOptions } from '@/lib/api/users'

const tabs = [
  { id: 'traces', label: 'Traces', icon: Workflow, href: 'traces' },
  { id: 'users', label: 'Users', icon: Users, href: 'users' },
  { id: 'sessions', label: 'Sessions', icon: Layers, href: 'sessions' },
]

export default function UsersPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = params.projectId as string
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false)

  // Use URL-synced state management (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState()

  // Build user query options from shared state
  const userQueryOptions = useMemo<UserQueryOptions>(() => ({
    page: queryOptions.page,
    limit: queryOptions.limit,
    search_query: queryOptions.search_query,
    start_after: queryOptions.start_after,
    end_before: queryOptions.end_before,
  }), [queryOptions])

  const { data, isLoading, error } = useUsers(projectId, userQueryOptions)

  const users = data?.data || []
  const meta = data?.meta || { page: 0, limit: 50, total: 0 }
  const totalPages = Math.ceil(meta.total / meta.limit)

  // Build URL with preserved filter and pagination params
  const buildUrlWithFilters = (path: string, extraParams?: Record<string, string>) => {
    const params = new URLSearchParams()

    // Add extra params (like user_id)
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        params.set(key, value)
      }
    }

    // Preserve pagination params
    const pageIndex = searchParams.get('page_index')
    const pageLimit = searchParams.get('page_limit')

    if (pageIndex) params.set('page_index', pageIndex)
    if (pageLimit) params.set('page_limit', pageLimit)

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

  const handleUserClick = (userId: string) => {
    router.push(buildUrlWithFilters(`/projects/${projectId}/traces`, { user_id: userId }))
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
              const isActive = tab.id === 'users'
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
        />

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-muted-foreground text-[13px]">Loading users...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <p className="text-destructive text-[13px]">Error loading users</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running.
              </p>
            </div>
          ) : users.length === 0 ? (
            <div className="flex h-64 items-center justify-center flex-col gap-3">
              <Users className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground text-[13px]">No users found</p>
              <p className="text-[12px] text-muted-foreground">
                Users will appear here when traces include user_id.
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full">
              <div className="flex-1 overflow-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border bg-muted/50">
                      <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50">
                        User ID
                      </th>
                      <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground border-r border-border/50 w-[120px]">
                        Traces
                      </th>
                      <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground w-[160px]">
                        Last Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user: UserListItem) => (
                      <tr
                        key={user.user_id}
                        onClick={() => handleUserClick(user.user_id)}
                        className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                      >
                        <td className="px-3 py-2 text-[12px] text-foreground border-r border-border/50">
                          {user.user_id}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-muted-foreground border-r border-border/50">
                          {user.trace_count}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-muted-foreground">
                          {formatDate(user.last_trace_time)}
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
    </div>
  )
}
