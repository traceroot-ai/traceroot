'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { getTrace, type Span } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDuration, formatTokens, formatDate } from '@/lib/utils'
import { ArrowLeft, Clock, Cpu, Layers } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

function SpanTypeBadge({ type }: { type: string }) {
  const variants: Record<string, 'default' | 'info' | 'warning' | 'success'> = {
    llm: 'info',
    span: 'default',
    agent: 'warning',
    tool: 'success',
  }
  return (
    <Badge variant={variants[type.toLowerCase()] || 'default'} className="text-xs">
      {type.toUpperCase()}
    </Badge>
  )
}

function SpanTree({
  spans,
  selectedSpanId,
  onSelect,
}: {
  spans: Span[]
  selectedSpanId: string | null
  onSelect: (span: Span) => void
}) {
  // Build tree structure
  const spanMap = new Map<string, Span>()
  spans.forEach((span) => spanMap.set(span.id, span))

  const rootSpans = spans.filter((s) => !s.parent_span_id)

  function renderSpan(span: Span, depth: number = 0) {
    const children = spans.filter((s) => s.parent_span_id === span.id)
    const isSelected = selectedSpanId === span.id

    return (
      <div key={span.id}>
        <div
          className={cn(
            'flex items-center gap-2 py-2 px-3 cursor-pointer rounded-md transition-colors',
            isSelected ? 'bg-primary/10' : 'hover:bg-muted'
          )}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => onSelect(span)}
        >
          <SpanTypeBadge type={span.type} />
          <span className="flex-1 truncate text-sm font-medium">{span.name}</span>
          <span className="text-xs text-muted-foreground">
            {formatDuration(span.duration_ms)}
          </span>
        </div>
        {children.map((child) => renderSpan(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {rootSpans.map((span) => renderSpan(span))}
    </div>
  )
}

function SpanDetail({ span }: { span: Span }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SpanTypeBadge type={span.type} />
          <h3 className="font-semibold">{span.name}</h3>
        </div>
        <Badge variant={span.level === 'error' ? 'destructive' : 'success'}>
          {span.level}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Duration:</span>
          <span className="font-medium">{formatDuration(span.duration_ms)}</span>
        </div>
        {span.model && (
          <div className="flex items-center gap-2 text-sm">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Model:</span>
            <span className="font-medium">{span.model}</span>
          </div>
        )}
        {span.usage && (
          <div className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Tokens:</span>
            <span className="font-medium">{formatTokens(span.usage.total_tokens)}</span>
          </div>
        )}
      </div>

      {span.input && (
        <div>
          <h4 className="text-sm font-medium mb-2">Input</h4>
          <pre className="rounded-md bg-muted p-4 text-xs overflow-auto max-h-64">
            {JSON.stringify(span.input, null, 2)}
          </pre>
        </div>
      )}

      {span.output && (
        <div>
          <h4 className="text-sm font-medium mb-2">Output</h4>
          <pre className="rounded-md bg-muted p-4 text-xs overflow-auto max-h-64">
            {JSON.stringify(span.output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

export default function TraceDetailPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const traceId = params.traceId as string
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
  })

  const trace = data?.data

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading trace...</p>
      </div>
    )
  }

  if (error || !trace) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-destructive">Error loading trace</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <Link href={`/${projectId}/traces`}>
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to traces
          </Button>
        </Link>

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{trace.name}</h2>
            <p className="text-sm text-muted-foreground">
              {formatDate(trace.timestamp)} • {formatDuration(trace.duration_ms)}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {trace.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="grid grid-cols-3 gap-6">
        {/* Span tree */}
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">Spans ({trace.spans.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <SpanTree
              spans={trace.spans}
              selectedSpanId={selectedSpan?.id || null}
              onSelect={setSelectedSpan}
            />
          </CardContent>
        </Card>

        {/* Span detail */}
        <Card className="col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Span Details</CardTitle>
          </CardHeader>
          <CardContent>
            {selectedSpan ? (
              <SpanDetail span={selectedSpan} />
            ) : (
              <p className="text-muted-foreground">
                Select a span from the tree to view details
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
