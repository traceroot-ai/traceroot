import React, { useState, useEffect } from 'react';
import { Span as SpanType } from '@/models/trace';
import { TRACE_ENTRY_COLOR } from '@/constants/colors';
import { fadeInAnimationStyles } from '@/constants/animations';
import { IoWarningOutline } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";

// Function to calculate and format latency
const formatLatency = (startTime: number, endTime: number): string => {
  const latencyMs = (endTime - startTime) * 1000; // Convert to milliseconds

  if (latencyMs < 1) {
    return `${(latencyMs * 1000).toFixed(0)}μs`; // Microseconds
  } else if (latencyMs < 1000) {
    return `${latencyMs.toFixed(1)}ms`; // Milliseconds
  } else {
    return `${(latencyMs / 1000).toFixed(2)}s`; // Seconds
  }
};

interface SpanProps {
  span: SpanType;
  widthPercentage?: number;
  isSelected?: boolean;
  onSpanSelect?: (spanId: string, childSpanIds: string[]) => void;
  selectedSpanId?: string | null;
  selectedSpanIds?: string[];
  level?: number;
  parentHasMoreSiblings?: boolean[];
  isRepeated?: boolean;
}

const Span: React.FC<SpanProps> = ({
  span: span,
  widthPercentage = 100,
  isSelected = false,
  onSpanSelect,
  selectedSpanId,
  selectedSpanIds = [],
  level = 0,
  parentHasMoreSiblings = [],
  isRepeated = false
}) => {
  const childWidthPercentage = Math.max(widthPercentage, 10);
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset and trigger animation when span changes
  useEffect(() => {
    // First collapse
    setIsExpanded(false);

    // Then expand after a small delay
    const timer = setTimeout(() => {
      setIsExpanded(true);
    }, 50);

    return () => clearTimeout(timer);
  }, [span.id]);

  const handleSpanClick = () => {
    // Recursively collect all child span IDs from all nested levels
    const getAllChildSpanIds = (spanNode: SpanType): string[] => {
      const childIds: string[] = [];
      if (spanNode.spans) {
        for (const childSpan of spanNode.spans) {
          childIds.push(childSpan.id);
          childIds.push(...getAllChildSpanIds(childSpan));
        }
      }
      return childIds;
    };

    const childSpanIds = getAllChildSpanIds(span);
    onSpanSelect?.(span.id, childSpanIds);
  };

  const renderChildSpans = (childSpans: SpanType[]) => {
    // Identify repeated leaf spans among siblings
    const leafSpans = childSpans.filter(childSpan => !childSpan.spans || childSpan.spans.length === 0);
    const spanNameCounts = new Map<string, number>();

    // Count occurrences of each span name among leaf spans
    leafSpans.forEach(leafSpan => {
      const count = spanNameCounts.get(leafSpan.name) || 0;
      spanNameCounts.set(leafSpan.name, count + 1);
    });

    // Determine which spans are repeated (name appears more than once among leaf spans)
    // const repeatedNames = new Set<string>();
    // spanNameCounts.forEach((count, name) => {
    //   if (count > 1) {
    //     repeatedNames.add(name);
    //   }
    // });

    return (
      <div className="relative">
        {/* Vertical Line: extends naturally with the content */}
        {isExpanded && (
          <div
            className="absolute top-0 w-px"
            style={{
              left: `${100 - childWidthPercentage}%`, // Position at the left edge of child spans
              height: '100%',
              background: '#e5e7eb',
              zIndex: 0,
            }}
          />
        )}

        <div
          className={`mt-1 space-y-2 overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[3000px] opacity-100' : 'max-h-0 opacity-0'}`}
          style={{
            width: `${childWidthPercentage}%`,
            marginLeft: `${100 - childWidthPercentage}%`,
            willChange: 'max-height, opacity'
          }}
        >
          {childSpans.map((childSpan, index) => {
            const isLast = index === childSpans.length - 1;
            // const isLeaf = !childSpan.spans || childSpan.spans.length === 0;
            // const isRepeatedLeaf = isLeaf && repeatedNames.has(childSpan.name);

            return (
              <Span
                key={childSpan.id}
                span={childSpan}
                widthPercentage={childWidthPercentage}
                isSelected={selectedSpanIds.includes(childSpan.id)}
                onSpanSelect={onSpanSelect}
                selectedSpanId={selectedSpanId}
                selectedSpanIds={selectedSpanIds}
                level={level + 1}
                parentHasMoreSiblings={[...parentHasMoreSiblings, !isLast]}
                isRepeated={false}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <>
      {level === 0 && <style>{fadeInAnimationStyles}</style>}
      <div
        className={`relative space-y-2 transition-all duration-300 ease-in-out ${isExpanded ? 'animate-fadeIn' : ''}`}
        style={{
          width: `${widthPercentage}%`,
          marginLeft: `${100 - widthPercentage}%`,
          opacity: isExpanded ? 1 : 0,
          transform: `translateY(${isExpanded ? '0' : '-10px'})`,
          willChange: 'opacity, transform',
        }}
      >
        <div
          onClick={handleSpanClick}
          className={`h-[45px] p-3 rounded border border-gray-200 dark:border-gray-700 transition-colors cursor-pointer transform transition-all duration-300 ease-in-out hover:scale-[1.01] hover:shadow-sm ${
            isSelected
              ? 'bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20'
              : 'hover:bg-green-50 dark:hover:bg-green-900/10'
          }`}
        >
          <div className="flex items-center h-full">
            {/* Span Tag */}
            <span
              className="inline-flex w-16 h-6 mr-2 text-xs items-center justify-center rounded-md italic"
              style={{
                background: '#f3f4f6',
                color: '#374151',
                boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
              }}
            >
              func
            </span>

            {/* Repeated Tag - only show for repeated leaf spans */}
            {isRepeated && (
              <span
                className="inline-flex h-6 mr-2 text-xs items-center justify-center rounded-md px-2"
                style={{
                  background: '#fef3c7',
                  color: '#92400e',
                  boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
                }}
              >
                Repeated
              </span>
            )}

            <span
              className="inline-flex h-6 mr-1 text-xs items-center justify-center rounded-md px-2"
              style={{ backgroundColor: TRACE_ENTRY_COLOR }}
              title={span.name.length > 40 ? span.name : undefined}
            >
              {span.name.length > 40 ? span.name.slice(0, 40) + '...' : span.name}
            </span>

            {/* Logs */}

            {/* Error icon for error/critical logs */}
            {((span.num_error_logs ?? 0) > 0 || (span.num_critical_logs ?? 0) > 0) && (
              <MdErrorOutline
                className="text-red-600 mr-1"
                size={20}
                title={`${span.num_error_logs ?? 0} error logs, ${span.num_critical_logs ?? 0} critical logs`}
              />
            )}

            {/* Warning icon for warning logs */}
            {((span.num_warning_logs ?? 0) > 0) && (
              <IoWarningOutline
                className="text-yellow-600 mr-1"
                size={20}
                title={`${span.num_warning_logs ?? 0} warning logs`}
              />
            )}

            <span className="flex items-center text-xs text-gray-500 dark:text-gray-400 ml-auto">
              {formatLatency(span.start_time, span.end_time)}
            </span>
          </div>
        </div>

        {span.spans && span.spans.length > 0 && renderChildSpans(span.spans)}
      </div>
    </>
  );
};

export default Span;
