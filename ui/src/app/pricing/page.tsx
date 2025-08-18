'use client';

import { Suspense } from 'react';
import { PricingTable } from "autumn-js/react";

// Product details configuration to match Autumn documentation style
const productDetails = [
  {
    id: "starter",
    description: "7-day free trial, then choose to continue at $19/month",
    items: [
      {
        primaryText: "100k trace + logs",
      },
      {
        primaryText: "1M LLM tokens",
      },
      {
        primaryText: "30d retention",
      },
      {
        primaryText: "Source code visible in UI",
      },
      {
        primaryText: "AI agent with chat mode only",
      },
    ],
  },
  {
    id: "pro",
    description: "For all your extra messaging needs",
    recommendText: "Popular",
    items: [
      {
        primaryText: "Everything in Starter",
      },
      {
        primaryText: "Unlimited users",
      },
      {
        primaryText: "AI agent has chat + agent mode",
      },
      {
        primaryText: "Optional full codebase access (GitHub integration)",
      },
      {
        primaryText: "AI Agent auto-triaging production issues",
      },
    ],
  },
  {
    id: "startups",
    description: "For those of you who are really serious",
    items: [
      {
        primaryText: "Everything in Pro",
      },
      {
        primaryText: "5M trace + logs",
      },
      {
        primaryText: "50M LLM tokens",
      },
      {
        primaryText: "Slack & Notion integration, full GitHub support with ticket/PR context",
      },
      {
        primaryText: "SOC2 & ISO27001 reports, BAA available (HIPAA)",
      },
    ],
  },
];

// Main page component with Suspense
export default function PricingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-700 dark:text-gray-300">Loading pricing information...</p>
        </div>
      </div>
    }>
      <div className="min-h-screen bg-gray-50 py-12 dark:bg-gray-900">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
              Pricing
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">
              Choose the plan that works for you
            </p>
          </div>
          <div className="mt-16">
            <PricingTable productDetails={productDetails} />
          </div>
        </div>
      </div>
    </Suspense>
  );
}
