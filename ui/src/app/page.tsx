'use client'

import React, { useState } from 'react';
import { GoArrowRight, GoArrowUpRight } from 'react-icons/go';
import { BsLightning } from "react-icons/bs";
import { RiRobot2Line } from "react-icons/ri";
import { FaCode } from "react-icons/fa6";
import Link from 'next/link';
import { shouldShowPaymentFeatures } from '@/utils/stripe-config';
import { Button } from '@/components/ui/button';

export default function Home() {
  const [isDocsHovered, setIsDocsHovered] = useState(false);
  const [isContactHovered, setIsContactHovered] = useState(false);
  const [isConnectHovered, setIsConnectHovered] = useState(false);
  const [isQuickstartHovered, setIsQuickstartHovered] = useState(false);
  const [isMonitorHovered, setIsMonitorHovered] = useState(false);
  const [isSettingsHovered, setIsSettingsHovered] = useState(false);

  const showPaymentFeatures = shouldShowPaymentFeatures();

  return (
    <div className="min-h-screen flex items-center justify-center relative">
      {/* Top right buttons */}
      <div className="absolute top-6 right-6 flex gap-4">
        <Button
          variant="outline"
          className="w-auto bg-white hover:bg-zinc-50 backdrop-blur-xl text-neutral-800 font-semibold text-sm"
          onClick={() => window.open('https://cal.com/traceroot/30min', '_blank')}
          onMouseEnter={() => setIsContactHovered(true)}
          onMouseLeave={() => setIsContactHovered(false)}
        >
          Contact Us
          <span className="transition-transform duration-300 ease-in-out">
            {isContactHovered ? (
              <GoArrowRight className="w-4 h-4 animate-pulse" />
            ) : (
              <GoArrowUpRight className="w-4 h-4" />
            )}
          </span>
        </Button>
        <Button
          variant="outline"
          className="w-auto bg-white hover:bg-zinc-50 backdrop-blur-xl text-neutral-800 font-semibold text-sm"
          onClick={() => window.open('https://docs.traceroot.ai', '_blank')}
          onMouseEnter={() => setIsDocsHovered(true)}
          onMouseLeave={() => setIsDocsHovered(false)}
        >
          Docs
          <span className="transition-transform duration-300 ease-in-out">
            {isDocsHovered ? (
              <GoArrowRight className="w-4 h-4 animate-pulse" />
            ) : (
              <GoArrowUpRight className="w-4 h-4" />
            )}
          </span>
        </Button>
      </div>

      {/* Main content */}
      <div className="text-center px-6 max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="mb-5 scroll-m-20 text-center text-4xl font-extrabold tracking-tight text-balance">
            TraceRoot.AI
          </h1>

          {/* Y Combinator Badge */}
          <div className="mb-4">
            <Button
              variant="outline"
              className="bg-zinc-800 hover:bg-zinc-800 text-white hover:text-white font-mono px-4 py-4.5 rounded-lg"
              onClick={() => window.open('https://www.ycombinator.com', '_blank')}
            >
              Backed by <span className="bg-orange-500 text-white font-mono px-2 py-1 rounded text-sm">Y</span>Combinator
            </Button>
          </div>

          <h3 className="scroll-m-20 pb-2 text-3xl tracking-tight first:mt-5">
            Agentic debugging made <span className="font-bold">simple</span>
          </h3>
        </div>

        <div className="space-y-8 max-w-4xl mx-auto">
          <p className="leading-7 [&:not(:first-child)]:mt-6">
            A platform for understanding application performance and debugging issues with AI agents
          </p>

          <div className="grid gap-6 md:gap-8 mt-12">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-zinc-100 rounded-lg p-6 border border-zinc-200/50">
                <div className="flex items-center justify-center gap-3 mb-3">
                  <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
                    <RiRobot2Line className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="font-semibold text-gray-800">AI Powered</h3>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">
                  Customized AI agents that can answer any questions about the trace, logs, and more
                </p>
              </div>

              <div className="bg-zinc-100 rounded-lg p-6 border border-zinc-200/50">
                <div className="flex items-center justify-center gap-3 mb-3">
                  <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
                    <FaCode className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="font-semibold text-gray-800">Multiple Types</h3>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">
                  Support systems such as microservices, voice agents, and multi-agent systems
                </p>
              </div>

              <div className="bg-zinc-100 rounded-lg p-6 border border-zinc-200/50">
                <div className="flex items-center justify-center gap-3 mb-3">
                  <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
                    <BsLightning className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="font-semibold text-gray-800">Fast & Easy</h3>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">
                  Set up in minutes with our intuitive SDK, UI interface and AI agents that get instant insights
                </p>
              </div>
            </div>

            <div className="bg-zinc-100 rounded-lg p-3 border border-zinc-200/50">
              <p className="text-gray-800 text-md">
                Connect to your applications securely by visiting &nbsp;
                <Link
                  href="/integrate"
                  className="inline-flex items-center gap-2 font-bold text-black hover:text-zinc-700 underline decoration-black/30 hover:decoration-zinc-700 transition-all duration-200"
                  onMouseEnter={() => setIsConnectHovered(true)}
                  onMouseLeave={() => setIsConnectHovered(false)}
                >
                  Navigate to Integrate
                  <span className="transition-transform duration-600 ease-in-out">
                    {isConnectHovered ? (
                      <GoArrowRight className="w-4 h-4 animate-pulse" />
                    ) : (
                      <GoArrowUpRight className="w-4 h-4" />
                    )}
                  </span>
                </Link>
              </p>
            </div>

            <div className="bg-zinc-100 rounded-lg p-3 border border-zinc-200/50">
              <p className="text-gray-800 text-md">
                Start monitoring by visiting &nbsp;
                <Link
                  href="/explore"
                  className="inline-flex items-center gap-2 font-bold text-black hover:text-zinc-700 underline decoration-black/30 hover:decoration-zinc-700 transition-all duration-200"
                  onMouseEnter={() => setIsMonitorHovered(true)}
                  onMouseLeave={() => setIsMonitorHovered(false)}
                >
                  Navigate to Explore
                  <span className="transition-transform duration-600 ease-in-out">
                    {isMonitorHovered ? (
                      <GoArrowRight className="w-4 h-4 animate-pulse" />
                    ) : (
                      <GoArrowUpRight className="w-4 h-4" />
                    )}
                  </span>
                </Link>
              </p>
            </div>

            {/* Only show settings link if Stripe is configured */}
            {showPaymentFeatures && (
              <div className="bg-zinc-100 rounded-lg p-3 border border-zinc-200/50">
                <p className="text-gray-800 text-md">
                  Manage your account and subscription settings by visiting &nbsp;
                  <Link
                    href="/settings"
                    className="inline-flex items-center gap-2 font-bold text-black hover:text-zinc-700 underline decoration-black/30 hover:decoration-zinc-700 transition-all duration-200"
                    onMouseEnter={() => setIsSettingsHovered(true)}
                    onMouseLeave={() => setIsSettingsHovered(false)}
                  >
                    Navigate to Settings
                    <span className="transition-transform duration-600 ease-in-out">
                      {isSettingsHovered ? (
                        <GoArrowRight className="w-4 h-4 animate-pulse" />
                      ) : (
                        <GoArrowUpRight className="w-4 h-4" />
                      )}
                    </span>
                  </Link>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
