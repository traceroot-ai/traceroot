import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { CostBreakdown } from "./CostBreakdown";

interface CostChipProps {
  cost: number | null | undefined;
  costDetails?: Record<string, number> | null;
}

/**
 * Cost chip ($ icon + amount) with a hover Cost breakdown panel.
 * Mirrors TokenChip. Renders nothing when cost is absent/non-finite; renders a
 * plain chip (no popup) when no per-category breakdown is available.
 */
export function CostChip({ cost, costDetails }: CostChipProps) {
  if (cost == null || !Number.isFinite(cost)) return null;

  const chip = (
    <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
      <DOMAIN_ICONS.cost className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{cost.toFixed(6)}</span>
    </div>
  );

  const hasBreakdown = costDetails && Object.keys(costDetails).length > 0;
  if (!hasBreakdown) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent className="border bg-popover p-3 text-popover-foreground shadow-md">
          <CostBreakdown details={costDetails} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
