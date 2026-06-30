import { CircleStop } from "lucide-react";
import { formatTokenFlow } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TokenUsageBreakdown } from "./TokenUsageBreakdown";

interface TokenChipProps {
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  totalTokens: number | null | undefined;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}

/**
 * Token count chip (`x → y (z)`) with a hover Usage breakdown panel. Used for
 * both the trace-level rollup and per-span counts (issue #958).
 */
export function TokenChip({
  inputTokens,
  outputTokens,
  totalTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
}: TokenChipProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <CircleStop className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">
              {formatTokenFlow(inputTokens, outputTokens, totalTokens)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="border bg-popover p-3 text-popover-foreground shadow-md">
          <TokenUsageBreakdown
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            totalTokens={totalTokens}
            cacheReadTokens={cacheReadTokens}
            cacheWriteTokens={cacheWriteTokens}
            reasoningTokens={reasoningTokens}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
