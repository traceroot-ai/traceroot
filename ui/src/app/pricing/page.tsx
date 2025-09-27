"use client";

import { Suspense } from "react";
import { PricingTable } from "autumn-js/react";

// Product details config
const productDetails = [
  {
    id: "starter",
    description: "7-day free trial, then $49/month",
    items: [
      { primaryText: "100k trace + logs" },
      { primaryText: "1M LLM tokens" },
      { primaryText: "30d retention" },
      { primaryText: "Source code visible in UI" },
      { primaryText: "AI agent with chat mode only" },
    ],
  },
  {
    id: "pro",
    description: "For all your extra messaging needs",
    recommendText: "Popular",
    items: [
      { primaryText: "Everything in Starter" },
      { primaryText: "Unlimited users" },
      { primaryText: "AI agent has chat + agent mode" },
      { primaryText: "Optional full codebase access (GitHub integration)" },
      { primaryText: "AI Agent auto-triaging production issues" },
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
        primaryText:
          "Slack & Notion integration, full GitHub support with ticket/PR context",
      },
      {
        primaryText: "SOC2 & ISO27001 reports, BAA available (HIPAA)",
      },
    ],
  },
];

// Loading fallback UI
function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-900">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto mb-4"></div>
        <p className="text-gray-700 dark:text-gray-300">
          Loading pricing information...
        </p>
      </div>
    </div>
  );
}

// Local mock fallback (avoids Autumn API in dev)
function LocalPricingTable() {
  return (
    <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
      {productDetails.map((plan) => (
        <div
          key={plan.id}
          className="rounded-2xl border p-6 shadow-sm bg-white dark:bg-gray-800"
        >
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            {plan.id.charAt(0).toUpperCase() + plan.id.slice(1)}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {plan.description}
          </p>
          <ul className="mt-4 space-y-2 text-sm text-gray-700 dark:text-gray-300">
            {plan.items.map((item, idx) => (
              <li key={idx}>• {item.primaryText}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// Page component
export default function PricingPage() {
  const disablePayment = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

  return (
    <Suspense fallback={<LoadingFallback />}>
      <section className="min-h-screen bg-gray-50 py-12 dark:bg-zinc-900">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <header className="text-center">
            <h1 className="text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
              Pricing
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-zinc-300">
              Choose the plan that works for you
            </p>
          </header>

          <div className="mt-16">
            {disablePayment ? (
              <LocalPricingTable />
            ) : (
              <PricingTable productDetails={productDetails} />
            )}
          </div>
        </div>
      </section>
    </Suspense>
  );
}
