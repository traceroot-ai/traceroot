import React from "react";
import { FaHistory } from "react-icons/fa";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

interface PaymentHistoryCardProps {
  customer: any;
}

export function PaymentHistoryCard({ customer }: PaymentHistoryCardProps) {
  if (!customer?.invoices || customer.invoices.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaHistory className="text-foreground" size={20} />
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-semibold">
              RECENT PAYMENTS
            </CardTitle>
            <CardDescription className="text-sm">
              Your recent payment history
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {customer.invoices
            .slice(-3)
            .reverse()
            .map((invoice: any, index: number) => (
              <div
                key={invoice.id || invoice.stripe_id || index}
                className="flex items-center justify-between py-2 border-b border-border last:border-b-0"
              >
                <div className="text-sm font-medium">
                  $
                  {((invoice.amount_paid || invoice.amount || 0) / 100).toFixed(
                    2,
                  )}
                </div>
                <div className="text-sm text-muted-foreground">
                  {invoice.created
                    ? new Date(invoice.created * 1000).toLocaleDateString()
                    : invoice.date
                      ? new Date(invoice.date).toLocaleDateString()
                      : "N/A"}
                </div>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
