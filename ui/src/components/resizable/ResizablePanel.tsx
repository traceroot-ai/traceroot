"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ImperativePanelHandle } from "react-resizable-panels";

interface ResizablePanelProps {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultLeftWidth?: number;
  initialCollapsed?: boolean | null;
  onLeftPanelCollapse?: (isCollapsed: boolean) => void;
}

export default function ResizablePanelComponent({
  leftPanel,
  rightPanel,
  minLeftWidth = 30,
  maxLeftWidth = 60,
  defaultLeftWidth = 45,
  initialCollapsed = null,
  onLeftPanelCollapse,
}: ResizablePanelProps) {
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [previousSize, setPreviousSize] = useState(defaultLeftWidth);

  // Apply initial collapsed state when it's determined
  useEffect(() => {
    if (initialCollapsed !== null && leftPanelRef.current) {
      setIsCollapsed(initialCollapsed);
      if (initialCollapsed) {
        leftPanelRef.current.resize(0);
        onLeftPanelCollapse?.(true);
      }
    }
  }, [initialCollapsed, onLeftPanelCollapse]);

  const handleCollapse = () => {
    if (leftPanelRef.current) {
      if (isCollapsed) {
        // Expand to default size
        setIsCollapsed(false);
        localStorage.setItem("traceCollapsed", "false");
        onLeftPanelCollapse?.(false);
        // Use setTimeout to allow state to update before resizing
        setTimeout(() => {
          if (leftPanelRef.current) {
            leftPanelRef.current.resize(defaultLeftWidth);
          }
        }, 0);
      } else {
        // Collapse to 0
        leftPanelRef.current.resize(0);
        setIsCollapsed(true);
        localStorage.setItem("traceCollapsed", "true");
        onLeftPanelCollapse?.(true);
      }
    }
  };

  return (
    <ResizablePanelGroup direction="horizontal" className="h-screen w-full">
      <ResizablePanel
        ref={leftPanelRef}
        defaultSize={defaultLeftWidth}
        minSize={isCollapsed ? 0 : minLeftWidth}
        maxSize={isCollapsed ? 0 : maxLeftWidth}
        collapsible={true}
      >
        {leftPanel}
      </ResizablePanel>
      <ResizableHandle className="group relative" disabled={isCollapsed}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
              style={{ zIndex: 999999 }}
              onClick={handleCollapse}
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-zinc-950 border border-neutral-300 dark:border-neutral-700 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors shadow-lg">
                {isCollapsed ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-neutral-800 dark:text-neutral-200"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-neutral-800 dark:text-neutral-200"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                )}
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>
              {isCollapsed ? "Trace mode" : "Log mode with real-time logging"}
            </p>
          </TooltipContent>
        </Tooltip>
      </ResizableHandle>
      <ResizablePanel>{rightPanel}</ResizablePanel>
    </ResizablePanelGroup>
  );
}
