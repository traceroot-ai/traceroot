'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface BillingTabProps {
  workspaceId: string;
}

const pricingPlans = [
  {
    id: 'free',
    name: 'Free',
    description: 'Get started with basic features',
    price: 0,
    features: [
      '1 seat only',
      '10k trace + logs',
      '100k LLM tokens',
      '7d retention',
      'AI agent with chat mode only',
    ],
    buttonText: 'Current Plan',
    highlighted: false,
    disabled: true,
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'For individuals and small teams',
    price: 49,
    features: [
      'Up to 1 workspace',
      'Up to 5 seats',
      '100k trace + logs',
      '1M LLM tokens',
      '30d retention',
      'Source code visible in UI',
      'AI agent with chat mode only',
    ],
    buttonText: 'Upgrade',
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For all your extra messaging needs',
    price: 99,
    features: [
      'Everything in Starter',
      'Up to 1 workspace',
      'Unlimited users',
      'AI agent has chat + agent mode',
      'Optional full codebase access (GitHub integration)',
      'AI Agent auto-triaging production issues',
    ],
    buttonText: 'Upgrade',
    highlighted: true,
    badge: 'Popular',
  },
  {
    id: 'startups',
    name: 'Startups',
    description: 'For those of you who are really serious',
    price: 999,
    features: [
      'Everything in Pro',
      'Up to 5 workspaces',
      '5M trace + logs',
      '50M LLM tokens',
      'Slack & Notion integration, full GitHub support with ticket/PR context',
      'SOC2 & ISO27001 reports, BAA available (HIPAA)',
    ],
    buttonText: 'Upgrade',
    highlighted: false,
  },
];


export function BillingTab({ workspaceId: _workspaceId }: BillingTabProps) {
  const [showPricingDialog, setShowPricingDialog] = useState(false);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Billing</h2>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and billing details
        </p>
      </div>

      {/* Current Plan Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Current plan</h3>
        <p className="text-sm text-muted-foreground mt-1">
          You are currently on the <span className="font-medium text-foreground">Free</span> plan.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowPricingDialog(true)}
          className="mt-3"
        >
          Change plan
        </Button>
      </div>

      {/* Usage Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Usage</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Your usage statistics for the current billing period.
        </p>
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Traces</span>
            <span>0 / 1,000</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">LLM tokens</span>
            <span>0 / 100,000</span>
          </div>
        </div>
      </div>

      {/* Pricing Dialog */}
      <Dialog open={showPricingDialog} onOpenChange={setShowPricingDialog}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Choose a plan</DialogTitle>
            <DialogDescription>
              Select a plan that best fits your needs.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {pricingPlans.map((plan) => (
                <div
                  key={plan.id}
                  className={cn(
                    "border flex flex-col",
                    plan.highlighted && "border-foreground shadow-md"
                  )}
                >
                  {/* Plan header */}
                  <div className="border-b px-4 pt-4 pb-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">{plan.name}</h3>
                      {plan.badge && (
                        <span className="text-xs px-2 py-1 bg-muted rounded-full">
                          {plan.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {plan.description}
                    </p>
                  </div>

                  {/* Price */}
                  <div className="px-4 py-3 border-b">
                    <span className="text-2xl font-bold">${plan.price}</span>
                    <span className="text-muted-foreground"> per month</span>
                  </div>

                  {/* Features */}
                  <div className="px-4 py-3 flex-1">
                    <ul className="space-y-2">
                      {plan.features.map((feature, index) => (
                        <li key={index} className="text-sm">
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* CTA Button */}
                  <div className="px-4 pb-4">
                    <Button
                      variant={plan.highlighted ? "default" : "outline"}
                      className="w-full justify-between"
                      disabled={plan.disabled}
                      onClick={() => {
                        // TODO: Implement plan selection
                        setShowPricingDialog(false);
                      }}
                    >
                      {plan.buttonText}
                      {!plan.disabled && <ArrowRight className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}