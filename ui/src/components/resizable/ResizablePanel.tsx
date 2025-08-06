'use client';

import React from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

interface ResizablePanelProps {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultLeftWidth?: number;
}

export default function ResizablePanelComponent({
  leftPanel,
  rightPanel,
  minLeftWidth = 30,
  maxLeftWidth = 60,
  defaultLeftWidth = 45,
}: ResizablePanelProps) {
  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="h-screen"
    >
      <ResizablePanel
        defaultSize={defaultLeftWidth}
        minSize={minLeftWidth}
        maxSize={maxLeftWidth}
      >
        {leftPanel}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel>
        {rightPanel}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
