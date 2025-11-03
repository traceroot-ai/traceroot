"use client";

import React, { useState, useRef, useEffect } from "react";
import { RiRobot2Line } from "react-icons/ri";
import { X } from "lucide-react";
import Agent from "@/components/right-panel/agent/Agent";

interface AgentPanelProps {
  traceId?: string;
  traceIds?: string[];
  spanIds?: string[];
  queryStartTime?: Date;
  queryEndTime?: Date;
  onSpanSelect?: (spanIds: string[] | string, traceId?: string) => void;
  onViewTypeChange?: (viewType: "log" | "trace") => void;
  children: React.ReactNode;
}

export default function AgentPanel({
  traceId,
  traceIds = [],
  spanIds = [],
  queryStartTime,
  queryEndTime,
  onSpanSelect,
  onViewTypeChange,
  children,
}: AgentPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [panelWidth, setPanelWidth] = useState(30); // Track panel width percentage (default 30%)
  const [hasBeenOpened, setHasBeenOpened] = useState(false); // Track if panel has ever been opened
  const panelRef = useRef<HTMLDivElement>(null);

  const MIN_WIDTH = 20;
  const MAX_WIDTH = 35;

  // Ensure panel stays closed unless explicitly opened
  useEffect(() => {
    // Do NOT auto-open when traceId changes
    // Panel should only open via user click on the robot icon
  }, [traceId, traceIds]);

  // Handle ESC key to close panel
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen]);

  // Handle Cmd+Shift+I (Mac) or Ctrl+Shift+I (Windows) to toggle panel
  useEffect(() => {
    const handleToggleShortcut = (e: KeyboardEvent) => {
      // Check for Cmd+Shift+I on Mac or Ctrl+Shift+I on Windows
      if (
        (e.key === "I" || e.key === "i") &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) {
          setHasBeenOpened(true);
        }
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleToggleShortcut, true); // Use capture phase
    return () =>
      window.removeEventListener("keydown", handleToggleShortcut, true);
  }, [isOpen]);

  // Calculate the icon position based on panel width when open
  useEffect(() => {
    if (isOpen && panelRef.current) {
      const updateIconPosition = () => {
        const windowWidth = window.innerWidth;
        const panelPixelWidth = (windowWidth * panelWidth) / 100;
        setPanelWidth(panelWidth);
      };
      updateIconPosition();
      window.addEventListener("resize", updateIconPosition);
      return () => window.removeEventListener("resize", updateIconPosition);
    }
  }, [isOpen, panelWidth]);

  // Calculate icon right position: when closed = 0 (50% hidden), when open = at panel left edge
  const getIconRightPosition = () => {
    if (!isOpen) {
      return isHovered ? "4px" : "-12px"; // Half-hidden when closed, centered on edge
    }
    // When open, position at the panel's left edge (border)
    return `calc(${panelWidth}% - 16px)`; // Centered on the border line
  };

  return (
    <div className="relative w-full h-full flex overflow-hidden">
      {/* Main content - always rendered, never remounted */}
      <div
        className="h-full"
        style={{
          width: isOpen ? `${100 - panelWidth}%` : "100%",
        }}
      >
        {children}
      </div>

      {/* Agent panel - slides in from right */}
      {isOpen && (
        <div
          className="bg-white dark:bg-zinc-950 border-l border-border h-full flex flex-col"
          style={{
            width: `${panelWidth}%`,
          }}
          ref={panelRef}
        >
          {/* Agent content area */}
          <div className="h-full overflow-hidden pt-2">
            {/* Only render Agent when opened at least once */}
            {hasBeenOpened && (
              <Agent
                traceId={traceId}
                traceIds={traceIds}
                spanIds={spanIds}
                queryStartTime={queryStartTime}
                queryEndTime={queryEndTime}
                onSpanSelect={onSpanSelect}
                onViewTypeChange={onViewTypeChange}
                onClosePanel={() => setIsOpen(false)}
              />
            )}
          </div>
        </div>
      )}

      {/* Resize handle - only visible when open, matches ResizableHandle styling */}
      {isOpen && (
        <div
          className="absolute top-0 bottom-0 w-1 bg-border hover:bg-muted transition-colors cursor-col-resize z-40 focus-visible:outline-none"
          style={{
            right: `${panelWidth}%`,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = panelWidth;
            const containerWidth = window.innerWidth;

            const handleMouseMove = (e: MouseEvent) => {
              const currentX = e.clientX;
              const deltaX = startX - currentX;
              const deltaPercent = (deltaX / containerWidth) * 100;
              const newWidth = startWidth + deltaPercent;
              const clampedWidth = Math.min(
                MAX_WIDTH,
                Math.max(MIN_WIDTH, newWidth),
              );
              setPanelWidth(clampedWidth);
            };

            const handleMouseUp = () => {
              document.removeEventListener("mousemove", handleMouseMove);
              document.removeEventListener("mouseup", handleMouseUp);
            };

            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
          }}
        />
      )}

      {/* Robot icon trigger - only visible when closed */}
      {!isOpen && (
        <div
          className="fixed bottom-4 right-4 z-50 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            setHasBeenOpened(true);
            setIsOpen(true);
          }}
        >
          <RiRobot2Line className="h-7 w-7 text-black dark:text-white drop-shadow-lg" />
        </div>
      )}
    </div>
  );
}
