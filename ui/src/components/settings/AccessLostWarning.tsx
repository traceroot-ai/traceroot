import React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface AccessLostWarningProps {
  customer: any;
  hasAccess: boolean;
}

export function AccessLostWarning({
  customer,
  hasAccess,
}: AccessLostWarningProps) {
  const router = useRouter();

  if (!customer || hasAccess) {
    return null;
  }

  return (
    <Card className="mb-6 border-destructive bg-destructive/5">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <svg
              className="h-5 w-5 text-destructive"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-destructive">
              Subscription Access Lost
            </h3>
            <p className="mt-2 text-sm text-destructive/80">
              Your subscription has expired or been cancelled. You no longer
              have access to premium features. To restore access, please upgrade
              your subscription.
            </p>
            <div className="mt-4">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => router.push("/pricing")}
              >
                Upgrade Now
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
