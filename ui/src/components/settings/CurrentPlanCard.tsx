import React from "react";
import { FaCrown } from "react-icons/fa";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface CurrentPlanCardProps {
  currentPlan: string;
  subscriptionStatus: {
    status: string;
    variant: "default" | "secondary";
  };
  customer?: any;
  isOnTrial: () => boolean;
  trialDaysRemaining: number | null;
  formatPlanName: (plan: string | null | undefined) => string;
}

export function CurrentPlanCard({
  currentPlan,
  subscriptionStatus,
  customer,
  isOnTrial,
  trialDaysRemaining,
  formatPlanName,
}: CurrentPlanCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaCrown className="text-foreground" size={20} />
          <CardTitle className="font-semibold text-sm">CURRENT PLAN</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Plan Name
              </div>
              <div className="text-sm font-medium mt-1">
                {formatPlanName(currentPlan)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Status
              </div>
              <div className="text-sm font-medium mt-1">
                {subscriptionStatus.status}
              </div>
            </div>
          </div>

          {customer?.products && customer.products.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  Start Date
                </div>
                <div className="text-sm font-medium mt-1">
                  {(() => {
                    if (!customer.created_at) return "N/A";

                    try {
                      const date = new Date(customer.created_at);
                      if (isNaN(date.getTime())) {
                        return "N/A";
                      }
                      return date.toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                      });
                    } catch (error) {
                      return "N/A";
                    }
                  })()}
                </div>
              </div>
              {isOnTrial() && trialDaysRemaining !== null && (
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Trial Remaining
                  </div>
                  <div className="text-sm font-medium mt-1">
                    {trialDaysRemaining} days
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Local version for mock data
interface LocalCurrentPlanCardProps {
  planName: string;
  status: string;
}

export function LocalCurrentPlanCard({
  planName,
  status,
}: LocalCurrentPlanCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaCrown className="text-foreground" size={20} />
          <CardTitle className="text-base font-semibold">
            CURRENT PLAN
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Plan Name
            </div>
            <div className="text-sm font-medium mt-1">{planName}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Status
            </div>
            <div className="text-sm font-medium mt-1">{status}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
