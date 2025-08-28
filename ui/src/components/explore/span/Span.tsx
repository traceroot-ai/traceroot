import React, { useState, useEffect } from "react";
import { Span as SpanType } from "@/models/trace";
import { TRACE_ENTRY_COLOR } from "@/constants/colors";
import { fadeInAnimationStyles } from "@/constants/animations";
import { IoWarningOutline, IoLogoJavascript } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import { FaPython } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  isRepeated = false,
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
    const leafSpans = childSpans.filter(
      (childSpan) => !childSpan.spans || childSpan.spans.length === 0,
    );
    const spanNameCounts = new Map<string, number>();

    // Count occurrences of each span name among leaf spans
    leafSpans.forEach((leafSpan) => {
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
              height: "100%",
              background: "#e5e7eb",
              zIndex: 0,
            }}
          />
        )}

        <div
          className={`mt-1 space-y-1.5 overflow-hidden transition-all duration-100 ease-in-out ${isExpanded ? "max-h-none opacity-100" : "max-h-0 opacity-0"}`}
          style={{
            width: `${childWidthPercentage}%`,
            marginLeft: `${100 - childWidthPercentage}%`,
            willChange: "max-height, opacity",
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
        className={`relative space-y-1.5 transition-all duration-100 ease-in-out ${isExpanded ? "animate-fadeIn" : ""}`}
        style={{
          width: `${widthPercentage}%`,
          marginLeft: `${100 - widthPercentage}%`,
          opacity: isExpanded ? 1 : 0,
          transform: `translateY(${isExpanded ? "0" : "-10px"})`,
          willChange: "opacity, transform",
        }}
      >
        <div
          onClick={handleSpanClick}
          className={`h-[43px] p-2 rounded border border-neutral-300 dark:border-neutral-700 transition-colors cursor-pointer transform transition-all duration-300 ease-in-out hover:scale-[1.01] hover:shadow-sm ${
            isSelected
              ? "bg-zinc-100 dark:bg-zinc-900"
              : "bg-white dark:bg-zinc-900"
          }`}
        >
          <div className="flex items-center h-full">
            {/* Python Icon - show when telemetry_sdk_language is "python" */}
            {span.telemetry_sdk_language === "python" && (
              <FaPython
                className="text-neutral-700 dark:text-neutral-300 mr-2"
                size={14}
              />
            )}

            {/* TypeScript Icon - show when telemetry_sdk_language is "ts" */}
            {span.telemetry_sdk_language === "ts" && (
              <SiTypescript
                className="text-neutral-700 dark:text-neutral-300 mr-2"
                size={14}
              />
            )}

            {/* JavaScript Icon - show when telemetry_sdk_language is "js" */}
            {span.telemetry_sdk_language === "js" && (
              <IoLogoJavascript
                className="text-neutral-700 dark:text-neutral-300 mr-2"
                size={14}
              />
            )}

            {/* Span Tag */}
            {/* <span
              className="inline-flex w-16 h-6 mr-2 text-xs items-center justify-center rounded-md italic"
              style={{
                background: '#f3f4f6',
                color: '#374151',
                boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
              }}
            >
              func
            </span> */}

            {/* Repeated Tag - only show for repeated leaf spans */}
            {/* {isRepeated && (
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
            )} */}

            {span.name.length > 20 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-6 mr-1 justify-center font-mono font-normal max-w-fit"
                  >
                    {span.name.slice(0, 35) + "..."}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{span.name}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Badge
                variant="outline"
                className="h-6 mr-1 justify-center font-mono font-normal max-w-fit"
              >
                {span.name}
              </Badge>
            )}

            {/* Logs */}

            {/* Error icon for error/critical logs */}
            {((span.num_error_logs ?? 0) > 0 ||
              (span.num_critical_logs ?? 0) > 0) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="destructive"
                    className="h-6 mr-1 px-1 font-normal"
                  >
                    <MdErrorOutline size={16} className="text-white" />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{`${span.num_error_logs ?? 0} error logs, ${span.num_critical_logs ?? 0} critical logs`}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Warning icon for warning logs */}
            {(span.num_warning_logs ?? 0) > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="h-6 mr-1 px-1 bg-[#fb923c] text-white hover:bg-[#fb923c]/80 font-normal"
                  >
                    <IoWarningOutline size={16} className="text-white" />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{`${span.num_warning_logs ?? 0} warning logs`}</p>
                </TooltipContent>
              </Tooltip>
            )}

            <span className="flex items-center text-xs text-neutral-600 dark:text-neutral-300 ml-auto">
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
