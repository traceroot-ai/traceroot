import React, { useState } from 'react';
import { Span } from '@/models/trace';
import { PERCENTILE_COLORS, getPercentileColor, PercentileKey } from '@/constants/colors';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface TraceDetailProps {
  traceId?: string;
  spanIds?: string[];
  spans?: Span[];
  traceStartTime?: number;
  traceEndTime?: number;
  traceDuration?: number;
  percentile?: string;
}

function formatTime(timeS: number): string {
  if (timeS < 60) {
    return `${timeS.toFixed(3)}s`;
  } else {
    return `${(timeS / 60).toFixed(2)}m`;
  }
}

function getAllSpans(spans: Span[]): Span[] {
  const allSpans: Span[] = [];

  function collectSpans(spanList: Span[]) {
    for (const span of spanList) {
      allSpans.push(span);
      if (span.spans && span.spans.length > 0) {
        collectSpans(span.spans);
      }
    }
  }

  collectSpans(spans);
  return allSpans;
}

function countChildrenRecursively(span: Span): number {
  if (!span.spans || span.spans.length === 0) {
    return 0;
  }

  let totalChildren = span.spans.length;
  for (const childSpan of span.spans) {
    totalChildren += countChildrenRecursively(childSpan);
  }

  return totalChildren;
}

// Add the getPercentileTag function
const getPercentileTag = (percentile: string) => {
  // Ensure the percentile is a valid key
  if (!Object.keys(PERCENTILE_COLORS).includes(percentile)) {
    return null;
  }
  const color = getPercentileColor(percentile as PercentileKey);
  return (
    <Badge
      className="w-12 h-5 font-mono mr-1 text-xs items-center justify-center text-zinc-700"
      style={{
        background: `${color}`,
        boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
      }}
    >
      {percentile}
    </Badge>
  );
};

export default function TraceDetail({
  traceId,
  spanIds = [],
  spans = [],
  traceStartTime,
  traceEndTime,
  traceDuration,
  percentile
}: TraceDetailProps) {
  const [selectedSpanForSheet, setSelectedSpanForSheet] = useState<Span | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Function to estimate if badges will fit in the span width
  const estimateBadgesFit = (span: Span, spanWidth: number) => {
    // Rough estimation: each character is ~7px, badges have padding, gap between badges
    const nameWidth = span.name.length * 7 + 16; // text + padding
    const latencyWidth = formatTime(span.duration).length * 7 + 16; // text + padding
    const gapWidth = 4; // gap between badges
    const totalEstimatedWidth = nameWidth + latencyWidth + gapWidth + 16; // +16 for span padding

    return spanWidth >= totalEstimatedWidth;
  };

  if (!traceId || !spans.length) {
    return (
      <div className="h-screen flex flex-col">
        <div className="bg-white dark:bg-gray-800 p-2 overflow-y-auto flex-1 min-h-0">
          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-600 dark:text-gray-300">
              {!traceId ? 'No trace selected' : 'No spans found for this trace'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Calculate trace timing if not provided
  const allSpansFlat = getAllSpans(spans);
  const actualTraceStartTime = traceStartTime || Math.min(...allSpansFlat.map(s => s.start_time));
  const actualTraceEndTime = traceEndTime || Math.max(...allSpansFlat.map(s => s.end_time));
  const actualTraceDuration = traceDuration || (actualTraceEndTime - actualTraceStartTime);

  // Ensure we have the true trace boundaries by also considering span end times
  const trueTraceStart = Math.min(actualTraceStartTime, ...allSpansFlat.map(s => s.start_time));
  const trueTraceEnd = Math.max(actualTraceEndTime, ...allSpansFlat.map(s => s.start_time + s.duration));
  const trueTraceDuration = trueTraceEnd - trueTraceStart;

  const allSpans = getAllSpans(spans);
  const selectedSpanIds = new Set(spanIds);

  // Calculate positioning for spans using true trace boundaries
  const getSpanPosition = (span: Span) => {
    const relativeStart = span.start_time - trueTraceStart;
    const left = (relativeStart / trueTraceDuration) * 100;
    const width = (span.duration / trueTraceDuration) * 100;
    return { left: `${left}%`, width: `${width}%` };
  };

  // Time markers for the timeline using true trace duration
  const timeMarkers = [];
  const markerCount = 10;
  for (let i = 0; i <= markerCount; i++) {
    const relativeTime = (trueTraceDuration * i / markerCount);
    timeMarkers.push({
      position: (i / markerCount) * 100,
      time: relativeTime,
      label: formatTime(relativeTime)
    });
  }

  const handleSpanClick = (span: Span) => {
    setSelectedSpanForSheet(span);
    setIsSheetOpen(true);
  };

  return (
    <div className="h-screen flex flex-col overflow-y-auto">
      <div className="bg-zinc-50 dark:bg-zinc-900 mt-1 ml-4 mr-4 rounded-lg flex flex-col min-h-0 flex-1">
        {/* Trace header */}
        <div className="bg-white dark:bg-zinc-900 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 m-2 flex-shrink-0">
          <div className="flex flex-wrap items-center gap-4 text-xs text-black-600 dark:text-black-400">
            {percentile && getPercentileTag(percentile)}
            <Badge variant="secondary" className="h-6">Trace ID: {traceId}</Badge>
            <Badge variant="outline" className="h-6">Latency: {formatTime(trueTraceDuration)}</Badge>
            <Badge variant="secondary" className="h-6">Spans: {allSpans.length}</Badge>
          </div>
        </div>

        {/* Timeline container */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 mx-2 mb-2 flex flex-col min-h-0 flex-1">
          {/* Time axis - fixed header */}
          <div className="relative p-3 pb-1 flex-shrink-0">
            <div className="relative mb-4 h-8">
              <div className="absolute top-0 left-0 w-full h-0.5 bg-gray-500 dark:bg-gray-400 rounded"></div>
              {timeMarkers.map((marker, index) => {
                const isFirst = index === 0;
                const isLast = index === timeMarkers.length - 1;

                return (
                  <div
                    key={index}
                    className="absolute top-0"
                    style={{ left: `${marker.position}%` }}
                  >
                    <div
                      className="w-0.5 h-2 bg-gray-500 dark:bg-gray-400 mb-1.5"
                      style={{
                        transform: isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)'
                      }}
                    ></div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 whitespace-nowrap"
                         style={{
                           transform: isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)'
                         }}>
                      {marker.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Spans visualization - scrollable area */}
          <div className="flex-1 overflow-y-scroll px-3 mb-[10vh]">
            <div className="space-y-0.5">
              {allSpans.map((span, index) => {
                const position = getSpanPosition(span);
                const isSelected = selectedSpanIds.has(span.id);
                const spanLatency = formatTime(span.duration);

                // Calculate actual pixel width from percentage
                const spanWidthPercent = (span.duration / trueTraceDuration) * 100;
                const containerWidth = 800;
                const spanPixelWidth = (spanWidthPercent / 100) * containerWidth;
                const contentFits = estimateBadgesFit(span, spanPixelWidth);

                // For very small spans, use minimal styling
                const isVerySmall = spanWidthPercent < 1; // Less than 1% of total duration
                const paddingClass = isVerySmall ? 'px-0.1' : 'px-2';
                const borderClass = isVerySmall ? 'border' : 'border';

                const spanElement = (
                  <div
                    className={`absolute h-9 rounded cursor-pointer flex items-center ${paddingClass} gap-1 overflow-hidden ${borderClass} ${
                      isSelected
                        ? 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                        : 'bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900 border-zinc-200 dark:border-zinc-700'
                    }`}
                    style={position}
                    onClick={() => handleSpanClick(span)}
                  >
                    {contentFits ? (
                      <div className="span-content flex items-center gap-1 min-w-0">
                        <Badge variant="secondary" className="text-xs h-5 px-2 py-0 flex-shrink-0">
                          {span.name}
                        </Badge>
                        <Badge variant="outline" className="text-xs h-5 px-2 py-0 flex-shrink-0">
                          {spanLatency}
                        </Badge>
                      </div>
                    ) : (
                      <div className="span-content flex items-center gap-1 min-w-0 w-full h-full" />
                    )}
                  </div>
                );

                return (
                  <div key={span.id} className="relative h-10.5">
                    {contentFits ? (
                      spanElement
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {spanElement}
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="flex flex-col gap-1">
                            <div className="font-medium">{span.name}</div>
                            <div className="text-xs opacity-90">{spanLatency}</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Selected Spans Legend - inside scrollable area */}
            {spanIds.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Selected Spans
                </h4>
                <div className="flex flex-wrap gap-2">
                  {allSpans
                    .filter(span => selectedSpanIds.has(span.id))
                    .map((span, index) => {
                      return (
                        <Badge
                          key={span.id}
                          variant="secondary"
                          className="cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors duration-200 px-3 py-1"
                          onClick={() => handleSpanClick(span)}
                        >
                          {span.name}
                        </Badge>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Span Details Sheet */}
        <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
          <SheetContent side="right" className="pt-4 w-96 sm:max-w-96">
            <SheetHeader className="pb-1">
              <SheetTitle>Span Details</SheetTitle>
              <SheetDescription>
                View detailed information about the selected span
              </SheetDescription>
            </SheetHeader>

            {selectedSpanForSheet && (
              <div className="m-1">
                <div className="grid grid-cols-1 gap-2 m-3">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      ID
                    </label>
                    <p className="text-sm font-mono bg-muted/50 p-2 rounded border break-all">
                      {selectedSpanForSheet.id}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Name
                    </label>
                    <p className="text-sm font-mono bg-muted/50 p-2 rounded border italic">
                      {selectedSpanForSheet.name}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Start Time
                      </label>
                      <p className="text-sm font-mono bg-muted/50 p-2 rounded border">
                        {new Date(selectedSpanForSheet.start_time * 1000).toLocaleString()}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        End Time
                      </label>
                      <p className="text-sm font-mono bg-muted/50 p-2 rounded border">
                        {new Date(selectedSpanForSheet.end_time * 1000).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Latency
                      </label>
                      <p className="text-sm font-mono bg-muted/50 p-2 rounded border">
                        {formatTime(selectedSpanForSheet.duration)}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Children
                      </label>
                      <p className="text-sm font-mono bg-muted/50 p-2 rounded border">
                        {countChildrenRecursively(selectedSpanForSheet)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
