import React, { useState, useEffect } from 'react';
import { RxCross2 } from "react-icons/rx";
import { Span } from '@/models/trace';
import { PERCENTILE_COLORS, getPercentileColor, PercentileKey } from '@/constants/colors';

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
    <span
      className="inline-flex w-12 h-5 font-mono mr-1 text-xs items-center justify-center rounded-md"
      style={{
        background: `${color}`,
        color: '#000',
        boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
      }}
    >
      {percentile}
    </span>
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
  const [selectedSpanForPopup, setSelectedSpanForPopup] = useState<Span | null>(null);

  const closePopup = () => {
    setSelectedSpanForPopup(null);
  };

  // Handle ESC key to close popup
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selectedSpanForPopup) {
        closePopup();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedSpanForPopup]);

  if (!traceId || !spans.length) {
    return (
      <div className="h-screen flex flex-col">
        <div className="bg-white dark:bg-gray-800 pt-0 px-4 pb-4 overflow-y-auto flex-1 min-h-0">
          <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-600 dark:text-gray-300">
              {!traceId ? 'No trace selected' : 'No spans found for this trace'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Calculate trace timing if not provided
  const actualTraceStartTime = traceStartTime || Math.min(...getAllSpans(spans).map(s => s.start_time));
  const actualTraceEndTime = traceEndTime || Math.max(...getAllSpans(spans).map(s => s.end_time));
  const actualTraceDuration = traceDuration || (actualTraceEndTime - actualTraceStartTime);

  const allSpans = getAllSpans(spans);
  const selectedSpanIds = new Set(spanIds);

  // Calculate positioning for spans
  const getSpanPosition = (span: Span) => {
    const relativeStart = span.start_time - actualTraceStartTime;
    const left = (relativeStart / actualTraceDuration) * 100;
    const width = (span.duration / actualTraceDuration) * 100;
    return { left: `${left}%`, width: `${width}%` };
  };

  // Time markers for the timeline
  const timeMarkers = [];
  const markerCount = 10;
  for (let i = 0; i <= markerCount; i++) {
    const relativeTime = (actualTraceDuration * i / markerCount);
    timeMarkers.push({
      position: (i / markerCount) * 100,
      time: relativeTime,
      label: formatTime(relativeTime)
    });
  }

  const handleSpanClick = (span: Span) => {
    setSelectedSpanForPopup(span);
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="bg-white dark:bg-gray-800 pt-0 px-4 pb-4 overflow-y-auto">
        {/* Trace header */}
        <div className="mb-4 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <h3 className="text-xl font-mono font-semibold text-gray-900 dark:text-gray-100 mb-3">
            Timeline
          </h3>
          <div className="flex flex-wrap items-center gap-4 text-xs text-black-600 dark:text-black-400">
            {percentile && getPercentileTag(percentile)}
            <span className="flex items-center h-6 rounded-md px-2 bg-gray-200 dark:bg-gray-700">Trace ID: &nbsp;<span className="text-gray-800 dark:text-gray-200">{traceId}</span></span>
            <span className="flex items-center h-6 rounded-md px-2 bg-gray-200 dark:bg-gray-700">Latency: &nbsp;<span className="text-gray-800 dark:text-gray-200">{formatTime(actualTraceDuration)}</span></span>
            <span className="flex items-center h-6 rounded-md px-2 bg-gray-200 dark:bg-gray-700">Spans: &nbsp;<span className="text-gray-800 dark:text-gray-200">{allSpans.length}</span></span>
          </div>
        </div>

        {/* Timeline container */}
        <div className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 ${spanIds.length > 0 ? 'mb-16' : ''}`}>
          {/* Time axis */}
          <div className="relative mb-6 h-8">
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

          {/* Spans visualization */}
          <div className="space-y-2">
            {allSpans.map((span, index) => {
              const position = getSpanPosition(span);
              const isSelected = selectedSpanIds.has(span.id);

              return (
                <div key={span.id} className="relative h-10">
                  <div
                    className={`absolute h-10 rounded transition-all duration-200 hover:shadow-sm cursor-pointer ${
                      isSelected
                        ? 'bg-green-50 dark:bg-green-900/10 border-2 border-green-500 dark:border-green-400'
                        : 'bg-white dark:bg-gray-700 hover:scale-[1.01] border border-gray-200 dark:border-gray-700'
                    }`}
                    style={position}
                    title={`${span.name}`}
                    onClick={() => handleSpanClick(span)}
                  >
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          {spanIds.length > 0 && (
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                Selected Spans
              </h4>
              <div className="flex flex-wrap gap-2">
                {allSpans
                  .filter(span => selectedSpanIds.has(span.id))
                  .map((span, index) => {
                    return (
                      <div
                        key={span.id}
                        className="inline-flex items-center gap-2 px-3 py-1 rounded-md text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors duration-200"
                        onClick={() => handleSpanClick(span)}
                      >
                        <span className="font-medium text-gray-700 dark:text-gray-200">
                          {span.name}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Popup Modal - Slide from right */}
        {selectedSpanForPopup && (
          <div className="fixed inset-0 z-50" onClick={closePopup}>
            <div className="fixed top-0 right-0 h-full w-96 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl transform transition-transform duration-300 ease-in-out" onClick={(e) => e.stopPropagation()}>
              {/* Close button */}
              <button
                onClick={closePopup}
                className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <RxCross2 className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              </button>

              <div className="p-6 pt-16">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  Details
                </h3>
                <div className="space-y-3 font-mono">
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">ID:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm break-all">
                      {selectedSpanForPopup.id}
                    </p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Name:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm break-all italic">
                      {selectedSpanForPopup.name}
                    </p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Start Time:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm">
                      {new Date(selectedSpanForPopup.start_time * 1000).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">End Time:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm">
                      {new Date(selectedSpanForPopup.end_time * 1000).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Latency:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm">
                      {formatTime(selectedSpanForPopup.duration)}
                    </p>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Children:</span>
                    <p className="text-gray-900 dark:text-gray-100 font-mono text-sm">
                      {countChildrenRecursively(selectedSpanForPopup)}
                    </p>
                  </div>

                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
