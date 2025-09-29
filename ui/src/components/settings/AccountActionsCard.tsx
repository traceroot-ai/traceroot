import React from "react";
import { FaCreditCard } from "react-icons/fa";
import { useRouter } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface AccountActionsCardProps {
  isOnTrial: () => boolean;
  handleManageBilling: () => Promise<void>;
  isProcessing: boolean;
  user?: any;
}

export function AccountActionsCard({
  isOnTrial,
  handleManageBilling,
  isProcessing,
  user,
}: AccountActionsCardProps) {
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaCreditCard className="text-foreground" size={24} />
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold">MANAGE</CardTitle>
            <CardDescription className="text-xs">
              Manage your subscription and billing
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={() => router.push("/pricing")}
          className="w-full"
          variant={isOnTrial() ? "default" : "outline"}
        >
          {isOnTrial() ? "Upgrade Plan" : "Change Plan"}
        </Button>
        {user?.email && (
          <Button
            onClick={handleManageBilling}
            disabled={isProcessing}
            className="w-full gap-2"
            variant="secondary"
          >
            <FaCreditCard size={16} />
            {isProcessing ? "Opening..." : "Manage Billing"}
          </Button>
        )}
        <p className="text-xs text-muted-foreground text-center">
          Update payment methods, view invoices, and manage your subscription
        </p>
      </CardContent>
    </Card>
  );
}

// Local version for mock data
export function LocalAccountActionsCard() {
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaCreditCard className="text-foreground" size={24} />
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-semibold">MANAGE</CardTitle>
            <CardDescription className="text-sm">
              Manage subscription and billing
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={() => router.push("/pricing")}
          className="w-full"
          variant="outline"
        >
          Change Plan
        </Button>
        <Button className="w-full" variant="secondary" disabled>
          <FaCreditCard size={16} />
          <span className="ml-2">Manage Billing</span>
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          Billing portal is disabled in local mode.
        </p>
      </CardContent>
    </Card>
  );
}
