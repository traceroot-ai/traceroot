import React, { useState, useEffect } from "react";
import { Span as SpanType } from "@/models/trace";
import { fadeInAnimationStyles } from "@/constants/animations";
import { IoWarningOutline, IoLogoJavascript } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import { FaPython, FaJava } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CirclePlus, CircleMinus } from "lucide-react";

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

const FUNCTION_NAME_TRUNCATION_LENGTH = 50;

function getDisplayFunctionName(fullFunctionName: string): string {
  if (fullFunctionName.length <= FUNCTION_NAME_TRUNCATION_LENGTH) {
    return fullFunctionName;
  }

  return `${fullFunctionName.slice(0, FUNCTION_NAME_TRUNCATION_LENGTH)}...`;
}

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
  expandedSpans?: Set<string>;
  onSpanExpandToggle?: (spanId: string, event: React.MouseEvent) => void;
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
  expandedSpans = new Set<string>(),
  onSpanExpandToggle,
}) => {
  const childWidthPercentage = Math.max(widthPercentage, 10);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChildren = span.spans && span.spans.length > 0;
  // Spans are expanded by default unless explicitly collapsed
  const isSpanExpanded = !expandedSpans.has(span.id);

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

    return (
      <div className="relative">
        {/* Vertical Line: extends naturally with the content */}
        {isExpanded && isSpanExpanded && (
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
          className={`mt-1 space-y-1.5 overflow-hidden transition-all duration-100 ease-in-out ${isExpanded && isSpanExpanded ? "max-h-none opacity-100" : "max-h-0 opacity-0"}`}
          style={{
            width: `${childWidthPercentage}%`,
            marginLeft: `${100 - childWidthPercentage}%`,
            willChange: "max-height, opacity",
          }}
        >
          {childSpans.map((childSpan, index) => {
            const isLast = index === childSpans.length - 1;

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
                expandedSpans={expandedSpans}
                onSpanExpandToggle={onSpanExpandToggle}
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
          className={`h-[40px] p-2 rounded border border-neutral-300 dark:border-neutral-700 transition-colors cursor-pointer transform transition-all duration-300 ease-in-out hover:shadow-sm ${
            isSelected
              ? "bg-zinc-200 dark:bg-zinc-800 border-l-4 border-l-zinc-400 dark:border-l-zinc-600"
              : "bg-white dark:bg-zinc-950"
          }`}
        >
          <div className="flex items-center h-full">
            <div className="flex items-center min-w-0 flex-1">
              {/* Language Icons Container */}
              <div className="flex items-center flex-shrink-0">
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

                {/* Java Icon - show when telemetry_sdk_language is "java" */}
                {span.telemetry_sdk_language === "java" && (
                  <FaJava
                    className="text-neutral-700 dark:text-neutral-300 mr-2"
                    size={14}
                  />
                )}
              </div>

              {/* Function Name Badge */}
              {(() => {
                const fullFunctionName = span.name;
                const displayFunctionName =
                  getDisplayFunctionName(fullFunctionName);
                const isTruncated =
                  fullFunctionName.length > FUNCTION_NAME_TRUNCATION_LENGTH;
                const shouldShowTooltip = isTruncated;

                const badge = (
                  <Badge
                    variant="outline"
                    className="min-w-[6rem] h-6 mr-1 flex-shrink-0 justify-center font-mono font-normal text-center whitespace-nowrap max-w-[26rem]"
                    title={shouldShowTooltip ? fullFunctionName : undefined}
                  >
                    {displayFunctionName}
                  </Badge>
                );

                return shouldShowTooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{badge}</TooltipTrigger>
                    <TooltipContent>
                      <p>{fullFunctionName}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  badge
                );
              })()}

              {/* Warning and Error Badges Container */}
              <div className="flex items-center flex-shrink-0">
                {/* Error icon for error/critical logs - hidden below 300px */}
                {((span.num_error_logs ?? 0) > 0 ||
                  (span.num_critical_logs ?? 0) > 0) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="destructive"
                        className="h-6 mr-1 px-1 font-normal flex-shrink-0 hidden @[300px]:inline-flex"
                      >
                        <MdErrorOutline size={16} className="text-white" />
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{`${span.num_error_logs ?? 0} error logs, ${span.num_critical_logs ?? 0} critical logs`}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Warning icon for warning logs - hidden below 300px */}
                {(span.num_warning_logs ?? 0) > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="h-6 mr-1 px-1 bg-[#fb923c] text-white hover:bg-[#fb923c]/80 font-normal flex-shrink-0 hidden @[300px]:inline-flex"
                      >
                        <IoWarningOutline size={16} className="text-white" />
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{`${span.num_warning_logs ?? 0} warning logs`}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* Spacer to push right-side badges to the right */}
              <div className="flex-1 min-w-4" />

              {/* Right-side badges container */}
              <div className="flex items-center gap-1 flex-shrink-0">
                {/* Duration Badge - hidden below 500px */}
                <Badge
                  variant="outline"
                  className="h-6 px-2 font-mono text-xs font-normal flex-shrink-0 whitespace-nowrap hidden @[500px]:inline-flex"
                >
                  {formatLatency(span.start_time, span.end_time)}
                </Badge>

                {/* Expand/Collapse Badge - hidden below 550px */}
                {hasChildren && onSpanExpandToggle && (
                  <Badge
                    variant="outline"
                    className="h-6 px-1.5 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors flex-shrink-0 whitespace-nowrap hidden @[550px]:inline-flex"
                    onClick={(e) => onSpanExpandToggle(span.id, e)}
                  >
                    {isSpanExpanded ? (
                      <CircleMinus size={12} />
                    ) : (
                      <CirclePlus size={12} />
                    )}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {span.spans &&
          span.spans.length > 0 &&
          isSpanExpanded &&
          renderChildSpans(span.spans)}
      </div>
    </>
  );
};

export default Span;
